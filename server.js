import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import { startAudit, rescanPage, forceReleaseGlobalSlot, getGlobalAuditCount } from './src/audit-manager.js';
import { killAllChrome, countChromeProcesses } from './src/lighthouse-runner.js';
import { generateReport, generateSummaryReport, generateVpatReport } from './src/report-generator.js';
import { applyFix } from './src/wp-fixer.js';
import {
  initScheduler, getSchedules, addSchedule,
  updateSchedule, deleteSchedule, triggerNow, importSchedules,
} from './src/scheduler.js';
import {
  initDb, upsertSession, savePage, deletePageByUrl,
  loadSessionMetas, getFullSession, recomputeSummary, deleteOldSessions,
  saveIgnoredIssue, removeIgnoredIssue, getIgnoredIssuesForSite,
  saveIgnoredIssueGlobal, removeIgnoredIssueGlobal,
  getLatestCompletedSessionByUrl, getPageSummary,
  getCampaignClients, upsertCampaignClient, deleteCampaignClient,
  updateClientScanResults, updateClientPdfResults, updateClientCms,
  getCampaignTemplates, upsertCampaignTemplate, deleteCampaignTemplate,
  logEmailSent, updateEmailLogBySgId, getEmailLogById, getEmailLog, getPendingEmailLog,
} from './src/db.js';
import { uploadReportPdfs } from './src/s3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// node-cron registers SIGINT/SIGTERM/exit/SIGHUP listeners per scheduled task.
process.setMaxListeners(100);

// Prevent Lighthouse protocol errors from crashing the process.
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception (kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled rejection (kept alive):', reason?.message || reason);
});

// Reports directory — detailed HTML reports saved for scheduler dev-email links
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data', 'sessions');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// ── In-memory session store ────────────────────────────────────────────────────
// Keeps ACTIVE (queued/crawling/auditing) sessions and lightweight metadata for
// recently-completed sessions. Full page+issue data is in MySQL — not here.
const auditSessions = new Map();
const MAX_SESSIONS = 100;

// WebSocket connections per audit
const wsConnections = new Map();

// Audit queue
const auditQueue = [];
let runningAudits = 0;
const MAX_CONCURRENT_AUDITS = 4;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ── Scheduler auth ─────────────────────────────────────────────────────────────
const schedulerTokens = new Map();
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000;

function schedulerAuth(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const expiry = schedulerTokens.get(token);
  if (!expiry || Date.now() > expiry) {
    schedulerTokens.delete(token);
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [tok, exp] of schedulerTokens) {
    if (now > exp) schedulerTokens.delete(tok);
  }
}, 60 * 60 * 1000);

// ── PDF Checker API token (pdfchecker.inquiros.io) ─────────────────────────────
const PDF_CHECKER_BASE = 'https://pdfchecker.inquiros.io';
let pdfCheckerJwt = null;
let pdfCheckerJwtExpiry = 0;

async function getPdfCheckerToken() {
  if (pdfCheckerJwt && Date.now() < pdfCheckerJwtExpiry - 60_000) return pdfCheckerJwt;
  const username = process.env.PDF_CHECKER_USER || process.env.SCHEDULER_USER || 'admin';
  const password = process.env.PDF_CHECKER_PASS || process.env.SCHEDULER_PASS || 'inquiros2025';
  const res = await fetch(`${PDF_CHECKER_BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`PDF checker auth failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  pdfCheckerJwt = data.token;
  pdfCheckerJwtExpiry = Date.now() + 4 * 60 * 60 * 1000;
  return pdfCheckerJwt;
}

async function pdfCheckerFetch(path, options = {}) {
  const token = await getPdfCheckerToken();
  const res = await fetch(`${PDF_CHECKER_BASE}/api/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    pdfCheckerJwt = null; // force re-auth on next call
    throw new Error('PDF checker session expired — will re-authenticate on retry');
  }
  return res;
}

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', sessions: auditSessions.size }));

// DB connectivity check — hit /api/db-status to confirm MySQL is reachable
app.get('/api/db-status', async (_req, res) => {
  try {
    const { initDb, testIssueInsert } = await import('./src/db.js');
    await initDb();
    // Run a write/read/delete test on audit_issues
    const testResult = await testIssueInsert();
    res.json({ status: 'connected', message: 'MySQL is reachable and tables are initialised', issueInsertTest: testResult });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// Diagnostic endpoint — tests S3 connectivity by uploading and deleting a small test file.
app.get('/api/s3-status', async (_req, res) => {
  try {
    const { S3Client, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const bucket = process.env.S3_BUCKET || 'planeteria-pdf-report';
    const region = process.env.AWS_REGION || 'us-west-2';

    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      return res.status(503).json({ status: 'not_configured', message: 'AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY not set' });
    }

    const client = new S3Client({
      region,
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    });

    const testKey = '_test/s3-connectivity-check.txt';
    await client.send(new PutObjectCommand({
      Bucket: bucket, Key: testKey, Body: 'ok', ContentType: 'text/plain',
    }));
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: testKey }));

    res.json({
      status: 'connected',
      bucket,
      region,
      message: 'S3 upload and delete succeeded',
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// Diagnostic endpoint — checks DB state for a session
app.get('/api/audit/:id/debug', async (req, res) => {
  try {
    const full = await getFullSession(req.params.id);
    if (!full) return res.status(404).json({ error: 'Session not found in DB' });

    const pagesSummary = full.pages.map(p => ({
      url: p.url.substring(0, 80),
      status: p.status,
      score: p.score,
      issueCount: p.issueCount,
      issuesInDb: (p.issues || []).length,
      match: p.issueCount === (p.issues || []).length,
    }));

    const totalIssueCount = full.pages.reduce((s, p) => s + (p.issueCount || 0), 0);
    const totalIssuesInDb = full.pages.reduce((s, p) => s + (p.issues || []).length, 0);

    res.json({
      sessionId: full.id,
      status: full.status,
      summary: full.summary,
      totalPages: full.pages.length,
      totalIssueCount,
      totalIssuesInDb,
      issuesMissing: totalIssueCount - totalIssuesInDb,
      pages: pagesSummary,
      inMemory: auditSessions.has(req.params.id),
      inMemoryPageCount: auditSessions.get(req.params.id)?.pages?.length ?? 0,
      inMemoryHasIssues: (auditSessions.get(req.params.id)?.pages || []).some(p => p.issues?.length > 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket ──────────────────────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url     = new URL(req.url, 'http://localhost');
  const auditId = url.searchParams.get('auditId');

  if (!auditId) return ws.close();

  if (!wsConnections.has(auditId)) wsConnections.set(auditId, new Set());
  wsConnections.get(auditId).add(ws);

  const session = auditSessions.get(auditId);
  if (session) ws.send(JSON.stringify({ type: 'state', data: sanitizeSession(session) }));

  ws.on('close', () => {
    const conns = wsConnections.get(auditId);
    if (conns) {
      conns.delete(ws);
      if (conns.size === 0) wsConnections.delete(auditId);
    }
  });
  ws.on('error', () => {});
});

function broadcastToAudit(auditId, message) {
  const conns = wsConnections.get(auditId);
  if (!conns) return;
  const msg = JSON.stringify(message);
  conns.forEach(ws => { if (ws.readyState === ws.OPEN) ws.send(msg); });
}

function sanitizeSession(session) {
  return {
    ...session,
    pages: session.pages.map(p => ({
      url:        p.url,
      status:     p.status,
      score:      p.score,
      // Prefer issues.length when available — stays in sync with consistency-check additions
      issueCount: p.issues && p.issues.length > 0 ? p.issues.length : (p.issueCount || 0),
      issues:     p.issues || [],   // included so the right panel can display them
      error:      p.error,
      timestamp:  p.timestamp,
      // supplementalData intentionally stripped — aggregated results live on session
    })),
    // Supplemental feature results
    pagesWithForms:    session.pagesWithForms    ?? null,
    globalFormsExist:  session.globalFormsExist  ?? false,
    pagesWithIframes:  session.pagesWithIframes  ?? null,
    globalIframesExist: session.globalIframesExist ?? false,
    brokenLinks:       session.brokenLinks       ?? null,
  };
}

// ── DB persistence helpers ─────────────────────────────────────────────────────

// Persist a completed/error session's metadata to the DB.
async function saveSessionToDb(session) {
  if (session.status !== 'completed' && session.status !== 'error') return;
  try {
    await upsertSession(session);
  } catch (err) {
    console.warn('[db] saveSessionToDb error:', err.message);
  }
}

// Write one completed page to DB.
// Returns the promise so callers can await all pending saves before querying DB.
// NOTE: we intentionally keep page.issues in memory — the RAM cost (~20 MB for
// a 100-page audit) is small, and nulling them caused cascading bugs: broken
// summaries, empty reports, issues disappearing from the UI.  The in-memory
// issues serve as the authoritative source for WS broadcasts and the summary
// computed inside startAudit; DB is a persistence layer, not the primary store.
function savePageToDb(session, page, pendingSaves) {
  const p = savePage(session.id, page)
    .catch(err => console.warn('[db] savePage error:', err.message));
  if (pendingSaves) pendingSaves.push(p);
  return p;
}

// Load a session from memory, or fall back to DB if not present.
async function getOrLoadSession(id) {
  const mem = auditSessions.get(id);
  if (mem) return mem;
  try {
    const db = await getFullSession(id);
    if (db) {
      auditSessions.set(id, db);
      return db;
    }
  } catch (err) {
    console.warn('[db] getOrLoadSession error:', err.message);
  }
  return null;
}

// Load session metadata from DB on startup.
async function loadSessionsFromDb() {
  try {
    const sessions = await loadSessionMetas(7);
    let loaded = 0;
    for (const s of sessions) {
      if (!auditSessions.has(s.id)) {
        auditSessions.set(s.id, s);
        loaded++;
      }
    }
    if (loaded > 0) console.log(`[db] Restored ${loaded} session(s) from database`);
  } catch (err) {
    console.warn('[db] loadSessionsFromDb error:', err.message);
  }
}

// ── Session management ─────────────────────────────────────────────────────────

function cleanOldSessions() {
  if (auditSessions.size < MAX_SESSIONS) return;
  const sorted = [...auditSessions.entries()]
    .filter(([, s]) => s.status === 'completed' || s.status === 'error')
    .sort((a, b) => new Date(a[1].startTime) - new Date(b[1].startTime));
  const toDelete = sorted.slice(0, Math.max(1, sorted.length - MAX_SESSIONS + 10));
  toDelete.forEach(([id]) => auditSessions.delete(id));
  // Old session data stays in MySQL; DB pruning happens on a daily schedule.
}

const MAX_AUDIT_DURATION_MS = 1440 * 60 * 1000; // 24 hours

async function processAuditQueue() {
  if (runningAudits >= MAX_CONCURRENT_AUDITS || auditQueue.length === 0) return;
  const { session } = auditQueue.shift();
  runningAudits++;

  session._cancelledExternally = false;

  // Track all in-flight savePage() promises so we can await them before
  // querying the DB for reports/summary (avoids a race where getFullSession
  // runs before all pages have been written).
  const pendingPageSaves = [];

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Audit timed out after 24 hours')),
      MAX_AUDIT_DURATION_MS
    );
  });

  let broadcastTimer = null;

  function flushBroadcast() {
    if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
    broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
  }

  try {
    await Promise.race([
      startAudit(session, (update) => {
        if (session._cancelledExternally || session.status === 'error') return;

        if ('completedPage' in update) {
          if (update.completedPage) {
            const page = update.completedPage;
            session.pages.push(page);
            const { completedPage, ...rest } = update;
            Object.assign(session, rest);

            flushBroadcast();

            // Persist to DB (issues stay in RAM for broadcasts + summary).
            savePageToDb(session, page, pendingPageSaves);
          } else {
            const { completedPage, ...rest } = update;
            Object.assign(session, rest);
            // Debounce when there's no page data (progress-only update).
            if (!broadcastTimer) {
              broadcastTimer = setTimeout(() => {
                broadcastTimer = null;
                broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
              }, 2000);
            }
          }
        } else {
          Object.assign(session, update);
          // Issues are kept in memory, so the broadcast always has full data.
          flushBroadcast();
        }
      }),
      timeout,
    ]);

    // Wait for all page saves to finish before persisting the session summary.
    await Promise.allSettled(pendingPageSaves);

    // Re-save any pages that the consistency checker modified after initial save.
    // These pages have extra issues added in memory but the DB still has the old counts.
    if (session.consistencyModifiedPages && session.consistencyModifiedPages.length > 0) {
      for (const page of session.consistencyModifiedPages) {
        try {
          await deletePageByUrl(session.id, page.url);
          await savePage(session.id, page);
          console.log(`[consistency] Re-saved ${page.url} with ${page.issueCount} issues`);
        } catch (err) {
          console.warn(`[consistency] Re-save failed for ${page.url}:`, err.message);
        }
      }
      delete session.consistencyModifiedPages;
    }

    if (!session._cancelledExternally) {
      await saveSessionToDb(session);

      // Fire-and-forget background auto-rescan for any error pages.
      // Delayed so the client has time to finish rendering the completed
      // results view before per-page update messages start arriving.
      const errorCount = session.pages.filter(p => p.status === 'error').length;
      if (errorCount > 0) {
        autoRescanErrorPages(session.id, !!session.wcag22).catch(err =>
          console.warn('[auto-rescan] Unexpected error:', err.message)
        );
      }
    }
  } catch (error) {
    if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
    // Ensure any in-flight saves complete even on error/timeout.
    await Promise.allSettled(pendingPageSaves);
    if (!session._cancelledExternally) {
      session.status  = 'error';
      session.error   = error.message;
      session.endTime = new Date().toISOString();
      broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
      await saveSessionToDb(session);
    }
  } finally {
    clearTimeout(timeoutId);
    if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null; }
    if (!session._cancelledExternally) {
      runningAudits--;
      processAuditQueue();
    }
  }
}

// ── Background auto-rescan ─────────────────────────────────────────────────────
// Runs after an audit completes to retry pages that errored (timeout/crash).
// Uses 'page-update' WS messages so the client updates individual rows in the
// page list without re-rendering the entire results view.
// Errors that won't improve with a retry — page-specific failures unrelated to
// Chrome state.  Matches the same patterns as isNonRetryableError() plus the
// "fully rendered" / login messages Lighthouse emits.
function isKnownNonRetryableMsg(msg) {
  if (!msg) return false;
  return (
    /\bstatus.?code\s+[45]\d\d\b/i.test(msg) ||
    /too many redirects|ERR_TOO_MANY_REDIRECTS/i.test(msg) ||
    /ERR_NAME_NOT_RESOLVED/i.test(msg) ||
    /404|410|not.*exist/i.test(msg) ||
    /403 Forbidden/i.test(msg) ||
    /redirects to a different URL/i.test(msg) ||
    /not.*fully.*rendered|requires login/i.test(msg)
  );
}

async function autoRescanErrorPages(sessionId, wcag22) {
  // Give the client ~3 s to finish rendering the completed results before we
  // start sending page-update messages (avoids racing with loadExistingAudit).
  await new Promise(r => setTimeout(r, 3000));

  const session = auditSessions.get(sessionId);
  // Run rescans one at a time — each rescanPage launches its own Chrome browser,
  // and concurrent launches right after an audit competes for the same resources.
  const CONCURRENT  = 1;
  const MAX_PASSES  = 2; // maximum retry passes

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (session?._cancelledExternally) break;

    // Load current page statuses from DB to find remaining error pages.
    const full = await getFullSession(sessionId).catch(() => null);
    if (!full) break;
    // Skip pages whose errors are known to be non-retryable (404, DNS failure,
    // login wall, etc.) — launching Chrome for these is always wasted work.
    const errorPages = full.pages.filter(p =>
      p.status === 'error' && !isKnownNonRetryableMsg(p.error)
    );
    if (errorPages.length === 0) break;

    console.log(`[auto-rescan] Pass ${pass}/${MAX_PASSES}: ${errorPages.length} page(s) — ${sessionId}`);

    // Process in batches of CONCURRENT pages.
    for (let i = 0; i < errorPages.length; i += CONCURRENT) {
      if (session?._cancelledExternally) break;
      const batch = errorPages.slice(i, i + CONCURRENT);

      // Tell the client each page is now being rescanned.
      for (const ep of batch) {
        broadcastToAudit(sessionId, {
          type: 'page-update',
          data: { url: ep.url, status: 'rescanning', score: null, issueCount: 0, error: null, issues: null },
        });
      }

      // Rescan all pages in the batch concurrently.
      await Promise.allSettled(batch.map(async (ep) => {
        try {
          const result = await rescanPage(ep.url, { wcag22 });
          await deletePageByUrl(sessionId, ep.url).catch(() => {});
          await savePage(sessionId, result).catch(err =>
            console.warn('[db] auto-rescan savePage error:', err.message)
          );
          // Update the in-memory session page.
          if (session?.pages) {
            const idx = session.pages.findIndex(p => p.url === ep.url);
            if (idx >= 0) session.pages[idx] = result;
          }
          broadcastToAudit(sessionId, { type: 'page-update', data: result });
        } catch (err) {
          console.warn(`[auto-rescan] pass ${pass} failed for ${ep.url}: ${err.message}`);
          const errPage = {
            url: ep.url, status: 'error', score: null,
            issueCount: 0, error: err.message, issues: [],
          };
          if (session?.pages) {
            const idx = session.pages.findIndex(p => p.url === ep.url);
            if (idx >= 0) session.pages[idx] = errPage;
          }
          broadcastToAudit(sessionId, { type: 'page-update', data: errPage });
        }
      }));
    }
  }

  // Recompute and persist the updated summary.
  const newSummary = await recomputeSummary(sessionId).catch(() => null);
  if (newSummary) {
    if (session) {
      session.summary = newSummary;
      await upsertSession(session).catch(() => {});
    }
    broadcastToAudit(sessionId, { type: 'summary-update', data: { summary: newSummary } });
  }
}

// ── PDF generation ─────────────────────────────────────────────────────────────
async function generatePdfBuffer(htmlContent) {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--no-first-run', '--no-zygote',
    ],
  });
  const page = await browser.newPage();
  try {
    await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 60000 });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Helper: get session with full page+issue data for report routes ─────────────
// During an active audit, issues are stripped from memory after each page saves.
// Reports therefore always load the full session from MySQL.
async function getSessionForReport(id) {
  try {
    const full = await getFullSession(id);
    return full;
  } catch (err) {
    console.warn('[db] getSessionForReport error:', err.message);
    // Fall back to in-memory session (issues may be null for some pages).
    return auditSessions.get(id) || null;
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.post('/api/audit', (req, res) => {
  const {
    url, maxPages = 50, urlList, excludeSitemaps, wcag22 = false,
    listForms = false, listIframes = false, checkBrokenLinks = false,
  } = req.body;

  if (urlList) {
    if (!Array.isArray(urlList) || urlList.length === 0) {
      return res.status(400).json({ error: 'urlList must be a non-empty array' });
    }
    for (const u of urlList) {
      try { new URL(u); } catch {
        return res.status(400).json({ error: `Invalid URL in list: ${u}` });
      }
    }
  } else {
    if (!url) return res.status(400).json({ error: 'URL is required' });
    try { new URL(url); } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }
  }

  const resolvedExcludes = [];
  if (excludeSitemaps && Array.isArray(excludeSitemaps)) {
    for (const s of excludeSitemaps) {
      try { new URL(s); resolvedExcludes.push(s); } catch {
        return res.status(400).json({ error: `Invalid exclude sitemap URL: ${s}` });
      }
    }
  }

  cleanOldSessions();

  const resolvedUrl = urlList ? urlList[0] : url;
  const auditId = uuidv4();
  const session = {
    id:              auditId,
    url:             resolvedUrl,
    urlList:         urlList || null,
    excludeSitemaps: resolvedExcludes.length > 0 ? resolvedExcludes : null,
    maxPages:        urlList ? urlList.length : Math.min(Math.max(1, parseInt(maxPages) || 50), 5000),
    status:          'queued',
    startTime:       new Date().toISOString(),
    endTime:         null,
    pages:           [],
    crawledUrls:     [],
    currentPage:     null,
    progress:        { crawled: 0, total: 0, audited: 0 },
    summary:         null,
    error:           null,
    wcag22:           !!wcag22,
    listForms:        !!listForms,
    listIframes:      !!listIframes,
    checkBrokenLinks: !!checkBrokenLinks,
    pagesWithForms:   null,
    globalFormsExist: false,
    pagesWithIframes: null,
    globalIframesExist: false,
    brokenLinks:      null,
    queuePosition:   auditQueue.length + 1,
  };

  auditSessions.set(auditId, session);

  // Insert into DB immediately so the session is trackable from the start.
  upsertSession(session).catch(err => console.warn('[db] initial upsertSession error:', err.message));

  auditQueue.push({ session });
  processAuditQueue();

  res.json({ auditId, session: sanitizeSession(session) });
});

app.get('/api/audit/:id', async (req, res) => {
  const session = auditSessions.get(req.params.id);

  // Active (non-completed) sessions: return in-memory state for real-time fidelity.
  if (session && session.status !== 'completed' && session.status !== 'error') {
    return res.json(sanitizeSession(session));
  }

  // Completed/error sessions: always load from DB so page issues (nulled from
  // memory after DB save) are included in the response.
  try {
    const dbSession = await getFullSession(req.params.id);
    if (dbSession) return res.json(sanitizeSession(dbSession));
  } catch (err) {
    console.warn('[db] getFullSession error in GET /api/audit/:id:', err.message);
  }

  // Fall back to in-memory if DB is unavailable
  if (session) return res.json(sanitizeSession(session));
  res.status(404).json({ error: 'Audit not found' });
});

app.get('/api/audits', (_req, res) => {
  const audits = [...auditSessions.values()]
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
    .map(s => ({
      id:        s.id,
      url:       s.url,
      status:    s.status,
      startTime: s.startTime,
      endTime:   s.endTime,
      summary:   s.summary,
    }));
  res.json(audits);
});

// Summary analytics for a URL — returns the latest completed scan's stats,
// with ignored-issue adjustments applied (matches the dashboard display).
//
// Optional ?auditId= parameter: when provided, the in-memory session map is
// checked first so the response is correct even if the DB write hasn't landed
// yet (race condition that occurs immediately after a scan completes).
app.get('/api/scan-summary', async (req, res) => {
  const { url, auditId } = req.query;
  if (!url && !auditId) return res.status(400).json({ error: 'url parameter is required' });

  try {
    let session = null;

    // 1. If auditId supplied, try in-memory first (avoids DB-write race condition).
    if (auditId) {
      const mem = auditSessions.get(auditId);
      if (mem && mem.status === 'completed' && (mem.pages?.length > 0 || mem.summary?.totalPages > 0)) {
        session = mem;
      }
    }

    // 2. Fall back to DB — either by auditId or by URL (latest completed scan).
    if (!session) {
      let meta = null;
      if (auditId) {
        meta = await getFullSession(auditId);
        if (meta && meta.status !== 'completed') meta = null;
      }
      if (!meta && url) {
        const urlMeta = await getLatestCompletedSessionByUrl(url);
        if (urlMeta) meta = await getFullSession(urlMeta.id);
      }
      session = meta;
    }

    if (!session) return res.json({ status: 'not_scanned' });

    // 3. If session came from in-memory (pages populated), skip getFullSession.
    //    Otherwise getFullSession was already called above and session has pages.
    const ignoredIssuesList = await getIgnoredIssuesForSite(session.url).catch(() => []);

    // Build lookup set (matches report-generator logic)
    const ignoredSet = new Set(ignoredIssuesList.map(i => `${i.pageUrl}::${i.issueId}`));
    const isIgnored  = (pageUrl, issueId) =>
      ignoredSet.has(`${pageUrl}::${issueId}`) || ignoredSet.has(`*::${issueId}`);

    let ignoredTotal = 0, ignoredCritical = 0, ignoredSerious = 0,
        ignoredModerate = 0, ignoredMinor = 0;
    const adjScores = [];

    for (const page of (session.pages || [])) {
      if (page.status !== 'completed') continue;
      const issues  = page.issues || [];
      const ignored = issues.filter(i => isIgnored(page.url, i.id));
      ignoredTotal    += ignored.length;
      ignoredCritical += ignored.filter(i => i.severity === 'critical').length;
      ignoredSerious  += ignored.filter(i => i.severity === 'serious').length;
      ignoredModerate += ignored.filter(i => i.severity === 'moderate').length;
      ignoredMinor    += ignored.filter(i => i.severity === 'minor').length;

      if (page.score !== null && page.score !== undefined) {
        const ratio = issues.length ? ignored.length / issues.length : 0;
        adjScores.push(Math.min(100, Math.round(page.score + (100 - page.score) * ratio)));
      }
    }

    const adjustedScore = adjScores.length
      ? Math.round(adjScores.reduce((a, b) => a + b, 0) / adjScores.length)
      : Math.round(session.summary?.averageScore || 0);

    const s = session.summary || {};
    res.json({
      status:       'found',
      auditId:      session.id,
      url:          session.url,
      completedAt:  session.endTime,
      score:        adjustedScore,
      pagesAudited: s.totalPages || 0,
      issues: {
        total:    Math.max(0, (s.totalIssues    || 0) - ignoredTotal),
        critical: Math.max(0, (s.criticalIssues || 0) - ignoredCritical),
        serious:  Math.max(0, (s.seriousIssues  || 0) - ignoredSerious),
        moderate: Math.max(0, (s.moderateIssues || 0) - ignoredModerate),
        minor:    Math.max(0, (s.minorIssues    || 0) - ignoredMinor),
      },
      ignored: ignoredTotal,
    });
  } catch (err) {
    console.error('[api] GET /api/scan-summary error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Per-page summary — score and issue counts for one page in a completed scan.
// Efficient: loads only the one page row + its issues, not the entire session.
app.get('/api/page-summary', async (req, res) => {
  const { auditId, pageUrl } = req.query;
  if (!auditId || !pageUrl) {
    return res.status(400).json({ error: 'auditId and pageUrl parameters are required' });
  }
  try {
    const data = await getPageSummary(auditId, pageUrl);
    if (!data) return res.status(404).json({ error: 'Audit not found' });
    res.json(data);
  } catch (err) {
    console.error('[api] GET /api/page-summary error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Full developer report — fetches complete page+issue data from DB.
app.get('/api/audit/:id/report', async (req, res) => {
  const meta = await getOrLoadSession(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Audit not found' });
  if (meta.status !== 'completed' && meta.status !== 'error') {
    return res.status(400).json({ error: 'Audit not yet completed' });
  }

  const session = await getSessionForReport(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });

  const brand     = req.query.brand || null;
  const autoprint = req.query.autoprint === 'true';
  const ignoredIssuesList = await getIgnoredIssuesForSite(session.url).catch(() => []);
  const reportHtml = generateReport(session, brand, autoprint, ignoredIssuesList);

  const domain = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const date   = new Date().toISOString().split('T')[0];

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!autoprint) {
    res.setHeader('Content-Disposition', `attachment; filename="accessibility-report-${domain}-${date}.html"`);
  }
  res.send(reportHtml);
});

// VPAT report
app.get('/api/audit/:id/report/vpat', async (req, res) => {
  const meta = await getOrLoadSession(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Audit not found' });
  if (meta.status !== 'completed' && meta.status !== 'error') {
    return res.status(400).json({ error: 'Audit not yet completed' });
  }

  const session = await getSessionForReport(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });

  const ignoredIssuesList = await getIgnoredIssuesForSite(session.url).catch(() => []);
  const reportHtml = generateVpatReport(session, req.query.brand || null, ignoredIssuesList);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(reportHtml);
});

// Summary report
app.get('/api/audit/:id/report/summary', async (req, res) => {
  const meta = await getOrLoadSession(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Audit not found' });
  if (meta.status !== 'completed' && meta.status !== 'error') {
    return res.status(400).json({ error: 'Audit not yet completed' });
  }

  const session = await getSessionForReport(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });

  const brand     = req.query.brand || null;
  const autoprint = req.query.autoprint === 'true';
  const ignoredIssuesList = await getIgnoredIssuesForSite(session.url).catch(() => []);
  const reportHtml = generateSummaryReport(session, brand, autoprint, ignoredIssuesList);

  const domain = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const date   = new Date().toISOString().split('T')[0];

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!autoprint) {
    res.setHeader('Content-Disposition', `attachment; filename="accessibility-summary-${domain}-${date}.html"`);
  }
  res.send(reportHtml);
});

// Rescan a single page
app.post('/api/audit/:id/rescan', async (req, res) => {
  const session = await getOrLoadSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  if (session.status !== 'completed' && session.status !== 'error') {
    return res.status(400).json({ error: 'Audit must be completed before rescanning individual pages' });
  }

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // If session was restored from DB metadata (pages: []), load the full page list
  // so in-memory stays consistent for future rescans and broadcasts.
  if (session.pages.length === 0) {
    try {
      const full = await getFullSession(req.params.id);
      if (full) session.pages = full.pages;
    } catch (err) {
      console.warn('[db] rescan: could not load pages from DB:', err.message);
    }
  }

  const existingIdx = session.pages.findIndex(p => p.url === url);
  if (existingIdx >= 0) {
    session.pages[existingIdx] = { ...session.pages[existingIdx], status: 'rescanning' };
  }
  broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });

  try {
    const result = await rescanPage(url, { wcag22: !!session.wcag22 });

    // Remove old page from DB then save the fresh result.
    await deletePageByUrl(session.id, url).catch(err =>
      console.warn('[db] deletePageByUrl error:', err.message)
    );
    await savePage(session.id, result).catch(err =>
      console.warn('[db] savePage (rescan) error:', err.message)
    );

    // Update in-memory page with full result (including issues).
    if (existingIdx >= 0) {
      session.pages[existingIdx] = result;
    } else {
      session.pages.push(result);
    }

    // Recompute summary from DB so we get accurate totals across all pages.
    const newSummary = await recomputeSummary(session.id);
    session.summary  = newSummary;

    // Persist updated summary.
    await upsertSession(session).catch(err => console.warn('[db] upsertSession (rescan) error:', err.message));

    broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });

    res.json({ success: true, page: result });
  } catch (err) {
    console.error('[rescan] Error:', err.message);
    if (existingIdx >= 0) {
      session.pages[existingIdx] = {
        url, status: 'error', error: err.message,
        score: null, issues: [], issueCount: 0,
        timestamp: new Date().toISOString(),
      };
      broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
    }
    res.status(500).json({ error: 'Rescan failed: ' + err.message });
  }
});

// Email report
app.post('/api/audit/:id/email', async (req, res) => {
  const meta = await getOrLoadSession(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Audit not found' });
  if (meta.status !== 'completed' && meta.status !== 'error') {
    return res.status(400).json({ error: 'Audit not yet completed' });
  }

  const { emails, brand } = req.body;
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'At least one email address is required' });
  }
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(503).json({ error: 'Email is not configured on this server.' });
  }

  try {
    const session   = await getSessionForReport(req.params.id);
    const brandKey  = brand || null;
    const ignoredIssuesList = await getIgnoredIssuesForSite(session.url).catch(() => []);
    const [summaryPdf, detailPdf, vpatPdf] = await Promise.all([
      generatePdfBuffer(generateSummaryReport(session, brandKey, false, ignoredIssuesList)),
      generatePdfBuffer(generateReport(session, brandKey, false, ignoredIssuesList)),
      generatePdfBuffer(generateVpatReport(session, brandKey, ignoredIssuesList)),
    ]);

    const domain   = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
    const date     = new Date().toISOString().split('T')[0];

    // Upload all three PDFs to S3 for persistent access.
    const s3Links = await uploadReportPdfs({
      summaryPdf, detailPdf, vpatPdf, domain, date, sessionId: session.id,
    });

    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    const avgScore = session.summary?.averageScore ?? 0;
    // Prefer explicit BASE_URL env var; fall back to detecting from the request
    const proto    = req.get('x-forwarded-proto') || req.protocol;
    const host     = req.get('x-forwarded-host')  || req.get('host');
    const baseUrl  = (process.env.BASE_URL || `${proto}://${host}`).replace(/\/$/, '');
    const resultsUrl = `${baseUrl}/?auditId=${session.id}`;

    // Build download links section for S3-hosted reports.
    const downloadLinks = (s3Links.summaryUrl || s3Links.detailUrl || s3Links.vpatUrl) ? `
          <p style="margin-top:24px;font-weight:600;">Download Reports:</p>
          <ul style="list-style:none;padding:0;margin:8px 0 0 0;">
            ${s3Links.summaryUrl ? `<li style="margin:6px 0;"><a href="${s3Links.summaryUrl}" style="color:#107DC2;text-decoration:none;">&#128196; ADA Summary Report (PDF)</a></li>` : ''}
            ${s3Links.detailUrl  ? `<li style="margin:6px 0;"><a href="${s3Links.detailUrl}"  style="color:#107DC2;text-decoration:none;">&#128203; ADA Detailed Report (PDF)</a></li>` : ''}
            ${s3Links.vpatUrl    ? `<li style="margin:6px 0;"><a href="${s3Links.vpatUrl}"    style="color:#107DC2;text-decoration:none;">&#128221; VPAT Conformance Report (PDF)</a></li>` : ''}
          </ul>
    ` : '';

    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      emails.join(', '),
      subject: `ADA Accessibility Report – ${session.url}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#107DC2;">ADA Accessibility Report</h2>
          <p>Please find attached the ADA Accessibility Summary and VPAT Conformance Report for <strong>${session.url}</strong>.</p>
          <table style="margin:20px 0;border-collapse:collapse;width:100%;">
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Pages Audited</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalPages ?? 0}</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Average Score</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${avgScore}/100</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Total Issues</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalIssues ?? 0}</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Critical</td><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#dc2626;">${session.summary?.criticalIssues ?? 0}</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Serious</td><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#ea580c;">${session.summary?.seriousIssues ?? 0}</td></tr>
          </table>
          ${downloadLinks}
          <p style="margin-top:20px;">
            <a href="${resultsUrl}" style="display:inline-block;padding:10px 20px;background:#107DC2;color:#fff;border-radius:5px;text-decoration:none;font-weight:600;">
              View Audit Results &amp; Re-scan Pages
            </a>
          </p>
          <p style="font-size:12px;color:#94a3b8;margin-top:32px;">Generated by Planeteria Inquiros ADA Checker &bull; Powered by Google Lighthouse, Axe Tools &amp; IBM Equal Access Checker</p>
        </div>
      `,
      attachments: [
        { filename: `accessibility-summary-${domain}-${date}.pdf`, content: summaryPdf, contentType: 'application/pdf' },
        { filename: `accessibility-detail-${domain}-${date}.pdf`,  content: detailPdf,  contentType: 'application/pdf' },
        { filename: `vpat-report-${domain}-${date}.pdf`,           content: vpatPdf,    contentType: 'application/pdf' },
      ],
    });

    res.json({ success: true, message: `Report sent to ${emails.join(', ')}` });
  } catch (err) {
    console.error('[email] Error:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// AI Fix
app.post('/api/audit/:id/fix', async (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  if (session.status !== 'completed') return res.status(400).json({ error: 'Audit not yet completed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on this server.' });
  }

  const { pageUrl, issue, targetType, devUrl, username, password } = req.body;
  if (!pageUrl || !issue || !username || !password) {
    return res.status(400).json({ error: 'Missing required fields: pageUrl, issue, username, password' });
  }

  const wpBaseUrl     = (targetType === 'dev' && devUrl) ? new URL(devUrl).origin : new URL(pageUrl).origin;
  const targetPageUrl = (targetType === 'dev' && devUrl) ? devUrl : pageUrl;

  try {
    const result = await applyFix({ wpBaseUrl, username, password, pageUrl: targetPageUrl, issue });
    res.json(result);
  } catch (err) {
    console.error('[fix] Error:', err.message);
    res.status(500).json({ error: 'Fix failed: ' + err.message });
  }
});

// Saved reports (scheduler detailed reports)
app.get('/api/reports/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!/^[\w.-]+-[0-9a-f-]{36}\.html$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid report filename' });
  }
  try {
    const content = await readFile(join(DATA_DIR, 'reports', filename), 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(content);
  } catch {
    res.status(404).json({ error: 'Report not found or has expired' });
  }
});

// ── System status & reset ──────────────────────────────────────────────────────

// GET /api/system-status — full diagnostic snapshot: queue, active audits,
// Chrome process count, semaphore state, uptime.
app.get('/api/system-status', (_req, res) => {
  const now = Date.now();
  const active = [...auditSessions.values()]
    .filter(s => s.status === 'auditing' || s.status === 'crawling')
    .map(s => ({
      id:          s.id,
      url:         s.url,
      status:      s.status,
      startTime:   s.startTime,
      currentPage: s.currentPage || null,
      progress:    s.progress || null,
      ageMs:       s.startTime ? now - new Date(s.startTime).getTime() : null,
    }));

  const queued = auditQueue.map(({ session }) => ({
    id:        session.id,
    url:       session.url,
    startTime: session.startTime,
    ageMs:     session.startTime ? now - new Date(session.startTime).getTime() : null,
  }));

  res.json({
    timestamp:        new Date().toISOString(),
    uptimeSeconds:    Math.floor(process.uptime()),
    chromeProcesses:  countChromeProcesses(),
    semaphoreSlots:   getGlobalAuditCount(),
    runningAudits,
    maxConcurrent:    MAX_CONCURRENT_AUDITS,
    queueLength:      auditQueue.length,
    active,
    queued,
    totalSessionsInMemory: auditSessions.size,
  });
});

// POST /api/system-reset — kill all Chrome processes, drain the queue, and
// release any stuck semaphore slots.  Does NOT restart the process — just
// clears the stuck state so new audits can launch immediately.
app.post('/api/system-reset', (_req, res) => {
  // 1. Kill every Chrome process
  killAllChrome();

  // 2. Cancel all queued (not yet started) audits
  const cancelledQueue = [];
  while (auditQueue.length > 0) {
    const { session } = auditQueue.shift();
    session.status  = 'error';
    session.error   = 'Cancelled — system was reset';
    session.endTime = new Date().toISOString();
    broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
    cancelledQueue.push(session.id);
  }

  // 3. Mark any stuck active audits as error
  const cancelledActive = [];
  for (const session of auditSessions.values()) {
    if (session.status === 'auditing' || session.status === 'crawling') {
      session._cancelledExternally = true;
      session.status  = 'error';
      session.error   = 'Cancelled — system was reset';
      session.endTime = new Date().toISOString();
      broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
      cancelledActive.push(session.id);
    }
  }

  // 4. Reset the running-audits counter and drain the semaphore
  runningAudits = 0;
  const slotsHeld = getGlobalAuditCount();
  for (let i = 0; i < slotsHeld; i++) forceReleaseGlobalSlot();

  // 5. Evict all completed/error sessions from memory — they're persisted in
  //    MySQL so nothing is lost. Keeps memory lean and the status count honest.
  let evicted = 0;
  for (const [id, s] of auditSessions) {
    if (s.status === 'completed' || s.status === 'error') {
      auditSessions.delete(id);
      evicted++;
    }
  }

  console.log(`[system-reset] Chrome killed, ${cancelledQueue.length} queued + ${cancelledActive.length} active audits cancelled, ${slotsHeld} semaphore slot(s) released, ${evicted} sessions evicted from memory`);

  res.json({
    success: true,
    chromeKilled:     true,
    cancelledQueue,
    cancelledActive,
    slotsReleased:    slotsHeld,
    sessionsEvicted:  evicted,
  });
});

// Queue management
app.get('/api/queue', (_req, res) => {
  res.json({
    runningAudits,
    maxConcurrent: MAX_CONCURRENT_AUDITS,
    queueLength:   auditQueue.length,
    queued: auditQueue.map(({ session }) => ({
      id: session.id, url: session.url, startTime: session.startTime,
    })),
    active: [...auditSessions.values()]
      .filter(s => s.status === 'auditing' || s.status === 'crawling')
      .map(s => ({ id: s.id, url: s.url, status: s.status, startTime: s.startTime })),
  });
});

app.delete('/api/queue', (_req, res) => {
  const cancelled = [];
  while (auditQueue.length > 0) {
    const { session } = auditQueue.shift();
    session.status  = 'error';
    session.error   = 'Cancelled — queue was cleared';
    session.endTime = new Date().toISOString();
    broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
    cancelled.push(session.id);
  }
  res.json({ cancelled, message: `Cleared ${cancelled.length} queued audit(s)` });
});

app.delete('/api/audit/:id', (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });

  const wasActive = session.status === 'auditing' || session.status === 'crawling';
  const wasQueued = session.status === 'queued';

  if (!wasActive && !wasQueued) {
    return res.status(400).json({ error: `Audit is already ${session.status} — nothing to cancel` });
  }

  let wasDequeued = false;
  if (wasQueued) {
    const idx = auditQueue.findIndex(({ session: s }) => s.id === session.id);
    if (idx >= 0) {
      auditQueue.splice(idx, 1);
    } else {
      wasDequeued = true;
    }
  }

  if (wasActive || wasDequeued) session._cancelledExternally = true;

  session.status  = 'error';
  session.error   = 'Cancelled by user';
  session.endTime = new Date().toISOString();
  broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });

  if (wasActive || wasDequeued) {
    runningAudits = Math.max(0, runningAudits - 1);
    forceReleaseGlobalSlot();
    processAuditQueue();
  }

  res.json({ success: true, id: session.id, wasActive, wasQueued });
});

// ── Ignored issues ─────────────────────────────────────────────────────────────

// GET  /api/ignored-issues?siteUrl=https://example.com
app.get('/api/ignored-issues', async (req, res) => {
  const { siteUrl } = req.query;
  if (!siteUrl) return res.status(400).json({ error: 'siteUrl is required' });
  try {
    const issues = await getIgnoredIssuesForSite(siteUrl);
    res.json(issues);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ignored-issues  — mark an issue as ignored/visually verified
app.post('/api/ignored-issues', async (req, res) => {
  const { siteUrl, pageUrl, issueId, issueTitle, wcag, severity } = req.body;
  if (!siteUrl || !pageUrl || !issueId) {
    return res.status(400).json({ error: 'siteUrl, pageUrl, and issueId are required' });
  }
  try {
    await saveIgnoredIssue({ siteUrl, pageUrl, issueId, issueTitle, wcag, severity });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ignored-issues  — remove an ignore entry
app.delete('/api/ignored-issues', async (req, res) => {
  const { siteUrl, pageUrl, issueId } = req.body;
  if (!siteUrl || !pageUrl || !issueId) {
    return res.status(400).json({ error: 'siteUrl, pageUrl, and issueId are required' });
  }
  try {
    await removeIgnoredIssue({ siteUrl, pageUrl, issueId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ignored-issues/all-pages  — ignore an issue on every page of the site
app.post('/api/ignored-issues/all-pages', async (req, res) => {
  const { siteUrl, issueId, issueTitle, wcag, severity } = req.body;
  if (!siteUrl || !issueId) {
    return res.status(400).json({ error: 'siteUrl and issueId are required' });
  }
  try {
    await saveIgnoredIssueGlobal({ siteUrl, issueId, issueTitle, wcag, severity });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ignored-issues/all-pages  — remove a site-wide ignore entry
app.delete('/api/ignored-issues/all-pages', async (req, res) => {
  const { siteUrl, issueId } = req.body;
  if (!siteUrl || !issueId) {
    return res.status(400).json({ error: 'siteUrl and issueId are required' });
  }
  try {
    await removeIgnoredIssueGlobal({ siteUrl, issueId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scheduler page
app.get('/scheduler', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'scheduler.html'));
});

// Scheduler auth
app.post('/api/scheduler/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.SCHEDULER_USER || 'admin';
  const validPass = process.env.SCHEDULER_PASS || 'inquiros2025';
  if (username !== validUser || password !== validPass) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = uuidv4();
  schedulerTokens.set(token, Date.now() + TOKEN_TTL_MS);
  res.json({ token, schedules: getSchedules() });
});

app.post('/api/scheduler/logout', schedulerAuth, (req, res) => {
  const token = req.headers['authorization']?.slice(7);
  if (token) schedulerTokens.delete(token);
  res.json({ success: true });
});

// Scheduler CRUD
app.get('/api/scheduler/schedules', schedulerAuth, (_req, res) => {
  res.json(getSchedules());
});

app.post('/api/scheduler/schedules', schedulerAuth, async (req, res) => {
  const { name, url, maxPages, excludeSitemaps, frequency, dayOfWeek,
          dayOfMonth, hour, minute, emails, devEmails, brand, enabled } = req.body;

  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'At least one email address is required' });
  }
  const validFreqs = ['daily', 'weekly', 'monthly'];
  if (frequency && !validFreqs.includes(frequency)) {
    return res.status(400).json({ error: 'frequency must be daily, weekly, or monthly' });
  }

  try {
    const schedule = await addSchedule({
      name, url, maxPages, excludeSitemaps, frequency, dayOfWeek,
      dayOfMonth, hour, minute, emails, devEmails, brand, enabled,
    });
    res.status(201).json(schedule);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/scheduler/schedules/:id', schedulerAuth, async (req, res) => {
  try {
    const updated = await updateSchedule(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Schedule not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/scheduler/schedules/:id', schedulerAuth, async (req, res) => {
  try {
    await deleteSchedule(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scheduler/schedules/:id/run', schedulerAuth, async (req, res) => {
  try {
    await triggerNow(req.params.id);
    res.json({ success: true, message: 'Audit started in background' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scheduler/schedules/export', schedulerAuth, (_req, res) => {
  const data = getSchedules();
  const date = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="schedules-${date}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

app.post('/api/scheduler/schedules/import', schedulerAuth, async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected a JSON array of schedules' });
  }
  try {
    const result = await importSchedules(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/status', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'status.html'));
});

// ── Campaign pages ─────────────────────────────────────────────────────────────
app.get('/campaign/templates', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'campaign-templates.html'));
});

app.get('/campaign', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'campaign.html'));
});

// Campaign auth — reuse the same credentials / token pool as the scheduler
app.post('/api/campaign/login', (req, res) => {
  const { username, password } = req.body;
  const validUser = process.env.SCHEDULER_USER || 'admin';
  const validPass = process.env.SCHEDULER_PASS || 'inquiros2025';
  if (username !== validUser || password !== validPass) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const token = uuidv4();
  schedulerTokens.set(token, Date.now() + TOKEN_TTL_MS);
  res.json({ token });
});

// Campaign client CRUD
app.get('/api/campaign/clients', schedulerAuth, async (_req, res) => {
  try { res.json(await getCampaignClients()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaign/clients', schedulerAuth, async (req, res) => {
  const { name, url, fromEmail, fromName, ccEmail, notes, recipients } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!url)  return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  try {
    const client = await upsertCampaignClient({
      id: uuidv4(), name, url, fromEmail, fromName, ccEmail, notes, recipients,
    });
    res.status(201).json(client);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/campaign/clients/:id', schedulerAuth, async (req, res) => {
  const { name, url, fromEmail, fromName, ccEmail, notes, recipients,
          avgScore, totalIssues, criticalIssues, seriousIssues, moderateIssues, minorIssues, lastAuditId } = req.body;
  if (url) { try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); } }
  try {
    const existing = (await getCampaignClients()).find(c => c.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Client not found' });
    const updated = await upsertCampaignClient({
      id: req.params.id,
      name:      name      ?? existing.name,
      url:       url       ?? existing.url,
      fromEmail: fromEmail ?? existing.fromEmail,
      fromName:  fromName  ?? existing.fromName,
      ccEmail:   ccEmail   ?? existing.ccEmail,
      notes:     notes     ?? existing.notes,
      recipients: recipients ?? existing.recipients,
    });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/campaign/clients/:id', schedulerAuth, async (req, res) => {
  try { await deleteCampaignClient(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Trigger ADA scan (50 pages) for a campaign client
app.post('/api/campaign/clients/:id/scan', schedulerAuth, async (req, res) => {
  const clients = await getCampaignClients().catch(() => []);
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  cleanOldSessions();
  const auditId = uuidv4();
  const session = {
    id:              auditId,
    url:             client.url,
    urlList:         null,
    excludeSitemaps: null,
    maxPages:        50,
    status:          'queued',
    startTime:       new Date().toISOString(),
    endTime:         null,
    pages:           [],
    crawledUrls:     [],
    currentPage:     null,
    progress:        { crawled: 0, total: 0, audited: 0 },
    summary:         null,
    error:           null,
    wcag22:          false,
    listForms:       false,
    listIframes:     false,
    checkBrokenLinks: false,
    pagesWithForms:  null,
    globalFormsExist: false,
    pagesWithIframes: null,
    globalIframesExist: false,
    brokenLinks:     null,
    queuePosition:   auditQueue.length + 1,
  };
  auditSessions.set(auditId, session);
  upsertSession(session).catch(err => console.warn('[db] campaign scan upsertSession:', err.message));
  auditQueue.push({ session });
  processAuditQueue();
  res.json({ auditId });
});

// Save ADA scan results back to client record (called by frontend after audit completes)
app.post('/api/campaign/clients/:id/scan-results', schedulerAuth, async (req, res) => {
  const { lastAuditId, avgScore, totalIssues, criticalIssues, seriousIssues, moderateIssues, minorIssues } = req.body;
  try {
    await updateClientScanResults(req.params.id, { lastAuditId, avgScore, totalIssues, criticalIssues, seriousIssues, moderateIssues, minorIssues });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PDF report stats parser ───────────────────────────────────────────────────
function parsePdfReportStats(markdown) {
  if (!markdown) return {};

  // Extract an integer from the report for any of the given label patterns.
  // Handles: "- **Label:** 42", "Label: 42", "| Label | 42 |", "**Label**: 42", "Label — 42"
  function findInt(labels) {
    for (const label of labels) {
      const patterns = [
        // Line-start: "- **Label:** 42" or "Label: 42" or "> Label: 42"
        new RegExp(`(?:^|\\n)[\\s\\-•>*_]*(?:\\*+|_+)?${label}(?:\\*+|_+)?[\\s]*[:\\-–—|]+\\s*([\\d,]+)`, 'im'),
        // Table cell: "| Label | 42 |"
        new RegExp(`\\|\\s*(?:[*_]+)?${label}(?:[*_]+)?\\s*\\|\\s*([\\d,]+)`, 'im'),
        // Inline: "Label: 42" anywhere on line (last resort)
        new RegExp(`${label}[^\\n]{0,80}?([\\d,]+)`, 'im'),
      ];
      for (const re of patterns) {
        const m = markdown.match(re);
        if (m) { const n = parseInt(m[1].replace(/,/g, ''), 10); if (!isNaN(n)) return n; }
      }
    }
    return null;
  }

  // Extract a percentage string (e.g. "75.0%") for the given label patterns.
  function findRate(labels) {
    for (const label of labels) {
      const patterns = [
        new RegExp(`(?:^|\\n)[\\s\\-•>*_]*(?:\\*+|_+)?${label}(?:\\*+|_+)?[\\s]*[:\\-–—|]+\\s*([\\d.]+\\s*%)`, 'im'),
        new RegExp(`\\|\\s*(?:[*_]+)?${label}(?:[*_]+)?\\s*\\|\\s*([\\d.]+\\s*%)`, 'im'),
        new RegExp(`${label}[^\\n]{0,80}?([\\d.]+\\s*%)`, 'im'),
      ];
      for (const re of patterns) {
        const m = markdown.match(re);
        if (m) return m[1].trim();
      }
    }
    return null;
  }

  const nonCompliant = findInt([
    'non[\\s\\-]?compliant(?!\\s*(?:rate|pdfs?))',
    'inaccessible(?:\\s+pdfs?)?',
    'failed(?:\\s+pdfs?)?(?!\\s+to)',
    'accessibility\\s+failures?',
  ]);

  const compliant = findInt([
    'compliant(?!\\s*(?:rate|pdfs?))(?<!non[\\s\\-]?)',
    'accessible(?:\\s+pdfs?)?(?!\\s*(?:rate|failures?))',
    'passed(?:\\s+pdfs?)?',
  ]);

  return {
    pdfPagesCrawled: findInt([
      'pages?\\s+crawled', 'crawled\\s+pages?',
      'total\\s+pages?', 'pages?\\s+scanned', 'web\\s+pages?',
      'pages?\\s+visited', 'pages?\\s+checked',
    ]),
    pdfDiscovered: findInt([
      'pdfs?\\s+discovered(?:\\s+on\\s+(?:the\\s+)?site)?',
      'pdfs?\\s+found(?:\\s+on\\s+(?:the\\s+)?site)?',
      'discovered(?:\\s+on\\s+(?:the\\s+)?site)?',
      'total\\s+pdfs?(?!\\s+audited)',
      'pdfs?\\s+on\\s+(?:the\\s+)?site',
      'pdfs?\\s+detected',
      'pdfs?\\s+in\\s+site',
      'number\\s+of\\s+pdfs?',
    ]),
    pdfAudited: findInt([
      'pdfs?\\s+audited', 'audited\\s+pdfs?',
      'pdfs?\\s+scanned', 'scanned\\s+pdfs?',
      'pdfs?\\s+checked', 'checked\\s+pdfs?',
      'pdfs?\\s+processed', 'pdfs?\\s+tested',
      'pdfs?\\s+analyzed', 'pdfs?\\s+evaluated',
    ]),
    pdfNonCompliant: nonCompliant,
    pdfCompliant: compliant,
    pdfErrored: findInt([
      'errored?(?:\\s+\\(?could\\s+not\\s+audit\\)?)?',
      'failed\\s+to\\s+audit', 'audit\\s+errors?',
      'could\\s+not\\s+(?:be\\s+)?audit(?:ed)?',
      'unreadable(?:\\s+pdfs?)?', 'error(?:ed)?(?:\\s+pdfs?)?',
    ]),
    pdfComplianceRate: findRate([
      'compliance\\s+rate', 'compliant\\s+rate',
      'accessibility\\s+rate', 'pass\\s+rate',
      'compliance\\s+percentage', 'compliance\\s+score',
    ]),
  };
}

// ── PDF scan (proxy to pdfchecker.inquiros.io) ────────────────────────────────

// Start a PDF scan for a campaign client
app.post('/api/campaign/clients/:id/pdf-scan', schedulerAuth, async (req, res) => {
  const clients = await getCampaignClients().catch(() => []);
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  try {
    const pdfRes = await pdfCheckerFetch('/audits', {
      method: 'POST',
      body: JSON.stringify({ url: client.url, maxPdfs: 50 }),
    });
    const data = await pdfRes.json();
    if (!pdfRes.ok) {
      return res.status(pdfRes.status).json({ error: data.message || data.error || 'PDF scan start failed', code: data.code });
    }
    res.json({ pdfAuditId: data.auditId, status: data.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Poll PDF scan status (proxied)
app.get('/api/campaign/pdf-audit/:auditId', schedulerAuth, async (req, res) => {
  try {
    const pdfRes = await pdfCheckerFetch(`/audits/${req.params.auditId}`);
    const data = await pdfRes.json();
    if (!pdfRes.ok) return res.status(pdfRes.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch PDF scan markdown report (proxied)
app.get('/api/campaign/pdf-audit/:auditId/report', schedulerAuth, async (req, res) => {
  try {
    const pdfRes = await pdfCheckerFetch(`/audits/${req.params.auditId}/report?format=markdown`);
    if (!pdfRes.ok) {
      const data = await pdfRes.json().catch(() => ({}));
      return res.status(pdfRes.status).json(data);
    }
    const markdown = await pdfRes.text();
    res.type('text/markdown').send(markdown);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save PDF scan results back to client record (parses stats from markdown automatically)
app.post('/api/campaign/clients/:id/pdf-scan-results', schedulerAuth, async (req, res) => {
  const { pdfAuditId, pdfTotalPdfs, pdfReportMarkdown } = req.body;
  const parsed = parsePdfReportStats(pdfReportMarkdown);
  try {
    await updateClientPdfResults(req.params.id, {
      pdfAuditId,
      pdfTotalPdfs: pdfTotalPdfs ?? parsed.pdfAudited ?? 0,
      pdfPagesCrawled:  parsed.pdfPagesCrawled  ?? 0,
      pdfDiscovered:    parsed.pdfDiscovered    ?? 0,
      pdfAudited:       parsed.pdfAudited       ?? 0,
      pdfCompliant:     parsed.pdfCompliant     ?? 0,
      pdfNonCompliant:  parsed.pdfNonCompliant  ?? 0,
      pdfErrored:       parsed.pdfErrored       ?? 0,
      pdfComplianceRate: parsed.pdfComplianceRate ?? '',
      pdfReportMarkdown,
    });
    res.json({ success: true, parsed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CMS detection ─────────────────────────────────────────────────────────────

async function detectCmsForUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  let html = '', headers = {};
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    headers = Object.fromEntries(res.headers.entries());
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const h = html.toLowerCase();
  const hdr = k => (headers[k] || headers[k.toLowerCase()] || '').toLowerCase();

  // Each rule: [cms_name, test_fn]
  const rules = [
    // ── Hosted site-builders ──
    ['Wix',          () => h.includes('static.wixstatic.com') || h.includes('wix.com/lpvideo')],
    ['Squarespace',  () => h.includes('squarespace.com') || hdr('server').includes('squarespace')],
    ['Webflow',      () => h.includes('webflow.com') || hdr('x-powered-by').includes('webflow')],
    ['Shopify',      () => h.includes('cdn.shopify.com') || hdr('x-shopid') !== ''],
    ['BigCommerce',  () => h.includes('bigcommerce.com') || h.includes('stencil.bigcommerce')],
    ['Weebly',       () => h.includes('weebly.com') || h.includes('weeblycloud.com')],
    ['GoDaddy/Websites+Marketing', () => h.includes('godaddy.com/websites') || h.includes('ols.bizcomponents.net')],
    // ── Open-source CMS ──
    ['WordPress',    () => h.includes('wp-content/') || h.includes('wp-includes/') || /generator.*wordpress/i.test(html)],
    ['Drupal',       () => /generator.*drupal/i.test(html) || h.includes('drupal.js') || hdr('x-generator').includes('drupal') || h.includes('sites/default/files')],
    ['Joomla',       () => /generator.*joomla/i.test(html) || h.includes('/media/jui/') || h.includes('com_content')],
    ['TYPO3',        () => /generator.*typo3/i.test(html) || h.includes('typo3conf/') || h.includes('typo3/sysext/')],
    ['Magento',      () => h.includes('mage/cookies') || h.includes('/skin/frontend/') || h.includes('magento')],
    ['OpenCart',     () => h.includes('catalog/view/theme') && h.includes('opencart')],
    ['PrestaShop',   () => h.includes('prestashop') || h.includes('/modules/blockcart/')],
    ['Ghost',        () => /generator.*ghost/i.test(html) || h.includes('ghost.io') || h.includes('content/themes/casper')],
    ['Craft CMS',    () => /generator.*craft/i.test(html) || h.includes('craftcms') || hdr('x-powered-by').includes('craft')],
    ['Concrete CMS', () => h.includes('concrete/js') || h.includes('/application/themes/') && h.includes('concrete')],
    ['ModX',         () => h.includes('assets/components/') || h.includes('/connectors/modx') || h.includes('modx.com')],
    // ── Enterprise / Government CMS ──
    ['Kentico',      () => /generator.*kentico/i.test(html) || h.includes('/cmspages/') || h.includes('kentico') || hdr('x-aspnet-version') !== '' && h.includes('kentico')],
    ['Sitecore',     () => h.includes('/-/media/') || h.includes('/sitecore/shell/') || h.includes('sitecore-jss') || h.includes('/~/media/')],
    ['Adobe AEM',    () => h.includes('/etc.clientlibs/') || h.includes('/content/dam/') || h.includes('adobeaemcloud.com')],
    ['Episerver/Optimizely', () => h.includes('episerver') || h.includes('optimizely.com/cms') || h.includes('epi-cms')],
    ['Sitefinity',   () => h.includes('telerik.sitefinity') || h.includes('sitefinity') || hdr('x-aspnet-version') !== '' && h.includes('sitefinity')],
    ['SharePoint',   () => h.includes('sharepoint') || hdr('microsoftsharepointteamservices') !== '' || h.includes('/_layouts/')],
    ['OpenText Web Solutions', () => h.includes('opentext') || h.includes('teamsite') || h.includes('livelink')],
    ['Ektron',       () => h.includes('ektron') || h.includes('/workarea/') && h.includes('ektron')],
    ['DotNetNuke',   () => h.includes('dotnetnuke') || h.includes('/portals/') || hdr('x-dnn-version') !== ''],
    ['Umbraco',      () => h.includes('umbraco') || hdr('x-umbraco-version') !== ''],
    ['Contentful',   () => h.includes('ctfassets.net') || hdr('x-powered-by').includes('contentful')],
    ['Contentstack', () => h.includes('contentstack') && (h.includes('cdn.contentstack') || h.includes('contentstack.io'))],
    ['Liferay',      () => h.includes('liferay') || hdr('x-liferay-portal') !== ''],
    ['HubSpot',      () => h.includes('hs-scripts.com') || h.includes('hubspot.com') || h.includes('_hsp')],
    ['Salesforce',   () => h.includes('force.com') || h.includes('salesforce.com/content') || h.includes('sfdcstatic.com')],
    // ── Misc ──
    ['Next.js',      () => hdr('x-powered-by').includes('next.js') || h.includes('__next') || h.includes('_next/static')],
    ['Gatsby',       () => h.includes('gatsby-') || h.includes('/gatsby-browser')],
    ['Nuxt.js',      () => h.includes('__nuxt') || h.includes('_nuxt/') || hdr('x-powered-by').includes('nuxt')],
    ['Angular',      () => h.includes('ng-version=') || h.includes('angular.min.js')],
    ['React (SPA)',  () => h.includes('react-root') || (h.includes('react') && h.includes('__reactfiber'))],
  ];

  // Return first match
  for (const [name, test] of rules) {
    try { if (test()) return name; } catch { /* skip */ }
  }
  return 'Unknown';
}

app.post('/api/campaign/clients/:id/detect-cms', schedulerAuth, async (req, res) => {
  try {
    const clients = await getCampaignClients();
    const client = clients.find(c => c.id === req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    const cms = await detectCmsForUrl(client.url);
    await updateClientCms(req.params.id, cms);
    res.json({ cms });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Re-parse stored PDF markdown report and update stats (no new scan needed)
app.post('/api/campaign/clients/:id/reparse-pdf', schedulerAuth, async (req, res) => {
  try {
    const clients = await getCampaignClients();
    const client = clients.find(c => c.id === req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!client.pdfReportMarkdown) return res.status(400).json({ error: 'No stored PDF report to re-parse' });
    const parsed = parsePdfReportStats(client.pdfReportMarkdown);
    await updateClientPdfResults(req.params.id, {
      pdfAuditId:       client.pdfAuditId,
      pdfTotalPdfs:     client.pdfTotalPdfs ?? parsed.pdfAudited ?? 0,
      pdfPagesCrawled:  parsed.pdfPagesCrawled  ?? 0,
      pdfDiscovered:    parsed.pdfDiscovered    ?? 0,
      pdfAudited:       parsed.pdfAudited       ?? 0,
      pdfCompliant:     parsed.pdfCompliant     ?? 0,
      pdfNonCompliant:  parsed.pdfNonCompliant  ?? 0,
      pdfErrored:       parsed.pdfErrored       ?? 0,
      pdfComplianceRate: parsed.pdfComplianceRate ?? '',
      pdfReportMarkdown: client.pdfReportMarkdown,
    });
    res.json({ success: true, parsed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send campaign email using a template to all recipients of a client
app.post('/api/campaign/clients/:id/send-email', schedulerAuth, async (req, res) => {
  const { templateId, ccEmail, bccEmail, fromEmail, fromName } = req.body;
  if (!templateId) return res.status(400).json({ error: 'templateId is required' });

  const useSendGrid = !!process.env.SENDGRID_API_KEY;
  if (!useSendGrid && (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)) {
    return res.status(503).json({ error: 'Email is not configured on this server.' });
  }

  const clients = await getCampaignClients().catch(() => []);
  const client = clients.find(c => c.id === req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.recipients || client.recipients.length === 0) {
    return res.status(400).json({ error: 'No recipients configured for this client' });
  }

  const templates = await getCampaignTemplates().catch(() => []);
  const tmpl = templates.find(t => t.id === templateId);
  if (!tmpl) return res.status(404).json({ error: 'Template not found' });

  const effectiveFrom     = fromEmail || tmpl.fromEmail || client.fromEmail || 'noreply@planeteria.com';
  const effectiveFromName = fromName  || client.fromName  || 'Planeteria Media';
  const effectiveBcc      = bccEmail  || tmpl.bccEmail  || null;

  function renderTemplate(str, vars) {
    return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
  }

  const baseVars = {
    client_name:         client.name,
    website_url:         client.url,
    ada_score:           client.avgScore != null ? String(Math.round(client.avgScore)) : 'N/A',
    total_issues:        String(client.totalIssues ?? 0),
    critical_issues:     String(client.criticalIssues ?? 0),
    serious_issues:      String(client.seriousIssues ?? 0),
    moderate_issues:     String(client.moderateIssues ?? 0),
    minor_issues:        String(client.minorIssues ?? 0),
    pdf_total_pdfs:      String(client.pdfTotalPdfs ?? 0),
    pdf_scan_date:       client.pdfScanAt ? new Date(client.pdfScanAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A',
    pdf_pages_crawled:   String(client.pdfPagesCrawled ?? 0),
    pdf_discovered:      String(client.pdfDiscovered ?? 0),
    pdf_audited:         String(client.pdfAudited ?? 0),
    pdf_compliant:       String(client.pdfCompliant ?? 0),
    pdf_non_compliant:   String(client.pdfNonCompliant ?? 0),
    pdf_errored:         String(client.pdfErrored ?? 0),
    pdf_compliance_rate: client.pdfComplianceRate || 'N/A',
    pdf_report:          client.pdfReportMarkdown || 'No PDF scan results available.',
  };

  let transporter = null;
  if (!useSendGrid) {
    transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }

  const errors = [];
  const sentEmails = [];
  for (const recipient of client.recipients) {
    const vars = {
      ...baseVars,
      first_name: recipient.firstName || '',
      last_name:  recipient.lastName  || '',
    };
    const subject = renderTemplate(tmpl.subject, vars);
    const html    = renderTemplate(tmpl.body,    vars);
    const logId   = uuidv4();
    let sgMessageId = null;

    try {
      if (useSendGrid) {
        const sgBody = {
          personalizations: [{ to: [{ email: recipient.email }] }],
          from:    { email: effectiveFrom, name: effectiveFromName },
          subject,
          content: [{ type: 'text/html', value: html }],
        };
        if (ccEmail)      sgBody.personalizations[0].cc  = [{ email: ccEmail }];
        if (effectiveBcc) sgBody.personalizations[0].bcc = [{ email: effectiveBcc }];

        const sgRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method:  'POST',
          headers: {
            'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify(sgBody),
        });
        if (!sgRes.ok) {
          const errText = await sgRes.text();
          throw new Error(`SendGrid ${sgRes.status}: ${errText}`);
        }
        sgMessageId = sgRes.headers.get('x-message-id');
      } else {
        await transporter.sendMail({
          from:    `"${effectiveFromName}" <${effectiveFrom}>`,
          to:      recipient.email,
          cc:      ccEmail      || undefined,
          bcc:     effectiveBcc || undefined,
          subject,
          html,
        });
      }

      sentEmails.push(recipient.email);

      // Log to DB — non-fatal
      logEmailSent({
        id: logId,
        clientId:       client.id,
        clientName:     client.name,
        templateId:     tmpl.id,
        templateName:   tmpl.name,
        recipientEmail: recipient.email,
        recipientName:  [recipient.firstName, recipient.lastName].filter(Boolean).join(' ') || null,
        fromEmail:      effectiveFrom,
        fromName:       effectiveFromName,
        ccEmail:        ccEmail || null,
        subject,
        bodyHtml:       html,
        sgMessageId,
      }).catch(e => console.warn('[email-log] DB write failed:', e.message));

    } catch (err) {
      errors.push({ email: recipient.email, error: err.message });
    }
  }

  if (errors.length > 0 && sentEmails.length === 0) {
    return res.status(500).json({ error: 'All emails failed', details: errors });
  }
  res.json({
    success: true,
    sent:    sentEmails.length,
    failed:  errors.length,
    details: errors.length ? errors : undefined,
  });
});

// SendGrid Event Webhook — no auth required (SendGrid posts here automatically)
app.post('/api/campaign/email-events', express.json(), async (req, res) => {
  res.sendStatus(200); // acknowledge immediately
  const events = Array.isArray(req.body) ? req.body : [];
  for (const event of events) {
    try {
      const sgMessageId = event.sg_message_id || event.smtp_id;
      if (!sgMessageId) continue;
      const ts = event.timestamp ? new Date(event.timestamp * 1000).toISOString() : new Date().toISOString();
      const updates = { lastEventAt: ts };
      switch (event.event) {
        case 'delivered':   updates.status = 'delivered'; updates.deliveredAt = ts; break;
        case 'open':        updates.status = 'opened';    updates.openedAt    = ts; break;
        case 'click':       updates.status = 'clicked';   updates.clickedAt   = ts; break;
        case 'bounce':
        case 'blocked':
        case 'spamreport':  updates.status = event.event; updates.bouncedAt   = ts; break;
        default:            updates.status = event.event;
      }
      await updateEmailLogBySgId(sgMessageId, updates).catch(() => {});
    } catch {}
  }
});

// Bulk-sync pending (status='sent') entries from SendGrid Activity API
app.post('/api/campaign/email-log/sync-pending', schedulerAuth, async (req, res) => {
  if (!process.env.SENDGRID_API_KEY) {
    return res.status(400).json({ error: 'SendGrid not configured' });
  }
  try {
    const pending = await getPendingEmailLog();
    if (!pending.length) return res.json({ synced: 0, updated: 0 });

    let updated = 0;
    for (const row of pending) {
      try {
        const sgRes = await fetch(
          `https://api.sendgrid.com/v3/messages?msg_id=${encodeURIComponent(row.sg_message_id)}`,
          { headers: { 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}` } }
        );
        if (!sgRes.ok) continue;
        const data = await sgRes.json();
        const msg  = (data.messages || [])[0];
        if (!msg) continue;

        const status = msg.status || 'unknown';
        const updates = { status, lastEventAt: new Date().toISOString() };
        if (status === 'delivered' && msg.last_event_time) updates.deliveredAt = msg.last_event_time;
        await updateEmailLogBySgId(row.sg_message_id, updates);
        updated++;
      } catch {}
    }
    res.json({ synced: pending.length, updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually refresh SendGrid status for one log entry
app.post('/api/campaign/email-log/:id/refresh', schedulerAuth, async (req, res) => {
  if (!process.env.SENDGRID_API_KEY) {
    return res.status(400).json({ error: 'SendGrid not configured' });
  }
  try {
    const row = await getEmailLogById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Log entry not found' });
    if (!row.sg_message_id) return res.status(400).json({ error: 'No SendGrid message ID for this entry' });

    const sgRes = await fetch(
      `https://api.sendgrid.com/v3/messages?msg_id=${encodeURIComponent(row.sg_message_id)}`,
      { headers: { 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}` } }
    );
    if (!sgRes.ok) {
      const errText = await sgRes.text();
      return res.status(502).json({ error: `SendGrid error ${sgRes.status}`, detail: errText });
    }
    const data = await sgRes.json();
    const msgs = data.messages || [];
    if (!msgs.length) return res.json({ refreshed: false, message: 'No data from SendGrid yet' });

    const msg    = msgs[0];
    const status = msg.status || 'unknown';
    const updates = { status, lastEventAt: new Date().toISOString() };
    if (status === 'delivered' && msg.last_event_time) updates.deliveredAt = msg.last_event_time;
    await updateEmailLogBySgId(row.sg_message_id, updates);
    res.json({ refreshed: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Email log list API
app.get('/api/campaign/email-log', schedulerAuth, async (req, res) => {
  try {
    const limit    = Math.min(parseInt(req.query.limit  || '50'), 200);
    const offset   = parseInt(req.query.offset || '0');
    const { clientId, status, search } = req.query;
    const result = await getEmailLog({ limit, offset, clientId, status, search });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Email log page
app.get('/campaign/email-log', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'campaign-email-log.html'));
});

// Campaign export / import
app.get('/api/campaign/clients/export', schedulerAuth, async (_req, res) => {
  try {
    const data = await getCampaignClients();
    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-clients-${date}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaign/clients/import', schedulerAuth, async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Expected a JSON array of clients' });
  }
  let imported = 0, skipped = 0;
  for (const c of req.body) {
    if (!c.name || !c.url) { skipped++; continue; }
    try {
      await upsertCampaignClient({
        id: c.id || uuidv4(), name: c.name, url: c.url,
        fromEmail: c.fromEmail, fromName: c.fromName, ccEmail: c.ccEmail,
        notes: c.notes, recipients: c.recipients || [],
      });
      imported++;
    } catch { skipped++; }
  }
  res.json({ imported, skipped });
});

// Campaign email templates CRUD
app.get('/api/campaign/templates', schedulerAuth, async (_req, res) => {
  try { res.json(await getCampaignTemplates()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/campaign/templates', schedulerAuth, async (req, res) => {
  const { name, subject, body, fromEmail, bccEmail } = req.body;
  if (!name)    return res.status(400).json({ error: 'name is required' });
  if (!subject) return res.status(400).json({ error: 'subject is required' });
  if (!body)    return res.status(400).json({ error: 'body is required' });
  try {
    const tmpl = await upsertCampaignTemplate({ id: uuidv4(), name, subject, body, fromEmail, bccEmail });
    res.status(201).json(tmpl);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/campaign/templates/:id', schedulerAuth, async (req, res) => {
  const { name, subject, body, fromEmail, bccEmail } = req.body;
  try {
    const existing = (await getCampaignTemplates()).find(t => t.id === req.params.id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });
    const updated = await upsertCampaignTemplate({
      id:        req.params.id,
      name:      name      ?? existing.name,
      subject:   subject   ?? existing.subject,
      body:      body      ?? existing.body,
      fromEmail: fromEmail !== undefined ? fromEmail : existing.fromEmail,
      bccEmail:  bccEmail  !== undefined ? bccEmail  : existing.bccEmail,
    });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/campaign/templates/:id', schedulerAuth, async (req, res) => {
  try { await deleteCampaignTemplate(req.params.id); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ── Startup ────────────────────────────────────────────────────────────────────

await mkdir(DATA_DIR, { recursive: true }).catch(() => {});

// DB connection is non-fatal — if the MySQL server is unreachable (e.g. firewall)
// the app starts in degraded mode with in-memory-only storage and logs a warning.
try {
  await initDb();
  await loadSessionsFromDb();
} catch (err) {
  console.error('[db] ⚠️  Could not connect to MySQL:', err.message);
  console.error('[db] ⚠️  Running without DB persistence. Check MYSQL_HOST and Cloudways firewall (whitelist this server\'s IP).');
}

await initScheduler(DATA_DIR, (session) => {
  // Register scheduler-initiated sessions so they appear in the live queue.
  auditSessions.set(session.id, session);
});

// Prune sessions older than 30 days every 24 hours.
setInterval(() => {
  deleteOldSessions(30).catch(err => console.warn('[db] pruneOldSessions error:', err.message));
}, 24 * 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ADA Accessibility Auditor running on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
