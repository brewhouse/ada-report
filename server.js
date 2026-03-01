import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdir, readdir, readFile, writeFile, unlink, stat } from 'fs/promises';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import { startAudit, rescanPage } from './src/audit-manager.js';
import { generateReport, generateSummaryReport } from './src/report-generator.js';
import { applyFix } from './src/wp-fixer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Session persistence directory — set DATA_DIR env var to a Render Disk mount path
// for persistence across deployments (e.g. DATA_DIR=/data/sessions)
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data', 'sessions');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// In-memory store for audit sessions (max 50)
const auditSessions = new Map();
const MAX_SESSIONS = 50;

// WebSocket connections per audit
const wsConnections = new Map();

// Audit queue for rate limiting
const auditQueue = [];
let runningAudits = 0;
const MAX_CONCURRENT_AUDITS = 4;

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', sessions: auditSessions.size }));

// WebSocket handling
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
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
  conns.forEach(ws => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

function sanitizeSession(session) {
  return {
    ...session,
    pages: session.pages.map(p => ({
      url: p.url,
      status: p.status,
      score: p.score,
      issueCount: p.issueCount,
      issues: p.issues,
      error: p.error,
      timestamp: p.timestamp,
    })),
  };
}

// ── Disk persistence ───────────────────────────────────────────────────────────

async function saveSessionToDisk(session) {
  if (session.status !== 'completed' && session.status !== 'error') return;
  try {
    await writeFile(
      join(DATA_DIR, `${session.id}.json`),
      JSON.stringify(sanitizeSession(session)),
      'utf8'
    );
  } catch (err) {
    if (process.env.DEBUG) console.warn('[sessions] write error:', err.message);
  }
}

async function loadSessionsFromDisk() {
  try {
    const files = await readdir(DATA_DIR);
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    let loaded = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(DATA_DIR, file);
      try {
        const stats = await stat(filePath);
        if (stats.mtimeMs < cutoff) {
          await unlink(filePath).catch(() => {});
          continue;
        }
        const data = JSON.parse(await readFile(filePath, 'utf8'));
        if (data?.id && !auditSessions.has(data.id)) {
          auditSessions.set(data.id, data);
          loaded++;
        }
      } catch {}
    }
    if (loaded > 0) console.log(`[sessions] Restored ${loaded} session(s) from disk`);
  } catch {
    // DATA_DIR doesn't exist yet or is empty — that's fine
  }
}

// ── Session management ─────────────────────────────────────────────────────────

function cleanOldSessions() {
  if (auditSessions.size < MAX_SESSIONS) return;
  const sorted = [...auditSessions.entries()]
    .filter(([, s]) => s.status === 'completed' || s.status === 'error')
    .sort((a, b) => new Date(a[1].startTime) - new Date(b[1].startTime));
  const toDelete = sorted.slice(0, Math.max(1, sorted.length - MAX_SESSIONS + 1));
  toDelete.forEach(([id]) => {
    auditSessions.delete(id);
    unlink(join(DATA_DIR, `${id}.json`)).catch(() => {});
  });
}

const MAX_AUDIT_DURATION_MS = 240 * 60 * 1000; // 240-minute hard cap per audit

async function processAuditQueue() {
  if (runningAudits >= MAX_CONCURRENT_AUDITS || auditQueue.length === 0) return;
  const { session } = auditQueue.shift();
  runningAudits++;

  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Audit timed out after 25 minutes')),
      MAX_AUDIT_DURATION_MS
    );
  });

  try {
    await Promise.race([
      startAudit(session, (update) => {
        Object.assign(session, update);
        broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
      }),
      timeout,
    ]);
    await saveSessionToDisk(session);
  } catch (error) {
    session.status = 'error';
    session.error = error.message;
    session.endTime = new Date().toISOString();
    broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
    await saveSessionToDisk(session);
  } finally {
    clearTimeout(timeoutId);
    runningAudits--;
    processAuditQueue();
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
      landscape: false,
      printBackground: true,
      displayHeaderFooter: false,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.post('/api/audit', (req, res) => {
  const { url, maxPages = 50, urlList, excludeSitemaps } = req.body;

  // URL-list mode: validate each entry
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

  // Validate excludeSitemaps (optional, crawl mode only)
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
    id: auditId,
    url: resolvedUrl,
    urlList: urlList || null,
    excludeSitemaps: resolvedExcludes.length > 0 ? resolvedExcludes : null,
    maxPages: urlList ? urlList.length : Math.min(Math.max(1, parseInt(maxPages) || 50), 5000),
    status: 'queued',
    startTime: new Date().toISOString(),
    endTime: null,
    pages: [],
    crawledUrls: [],
    currentPage: null,
    progress: { crawled: 0, total: 0, audited: 0 },
    summary: null,
    error: null,
    queuePosition: auditQueue.length + 1,
  };

  auditSessions.set(auditId, session);
  auditQueue.push({ session });
  processAuditQueue();

  res.json({ auditId, session: sanitizeSession(session) });
});

app.get('/api/audit/:id', (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  res.json(sanitizeSession(session));
});

app.get('/api/audits', (_req, res) => {
  const audits = [...auditSessions.values()]
    .sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
    .map(s => ({
      id: s.id,
      url: s.url,
      status: s.status,
      startTime: s.startTime,
      endTime: s.endTime,
      summary: s.summary,
    }));
  res.json(audits);
});

// Download HTML report — supports ?brand=planeteria|digitaldeployment|pensionx and ?autoprint=true
app.get('/api/audit/:id/report', (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  if (session.status !== 'completed') {
    return res.status(400).json({ error: 'Audit not yet completed' });
  }

  const brand = req.query.brand || null;
  const autoprint = req.query.autoprint === 'true';
  const reportHtml = generateReport(session, brand, autoprint);

  const domain = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const date = new Date().toISOString().split('T')[0];

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!autoprint) {
    res.setHeader('Content-Disposition', `attachment; filename="accessibility-report-${domain}-${date}.html"`);
  }
  res.send(reportHtml);
});

// Download summary HTML report (client-facing, no per-page issue details)
app.get('/api/audit/:id/report/summary', (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  if (session.status !== 'completed') {
    return res.status(400).json({ error: 'Audit not yet completed' });
  }

  const brand = req.query.brand || null;
  const autoprint = req.query.autoprint === 'true';
  const reportHtml = generateSummaryReport(session, brand, autoprint);

  const domain = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const date = new Date().toISOString().split('T')[0];

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!autoprint) {
    res.setHeader('Content-Disposition', `attachment; filename="accessibility-summary-${domain}-${date}.html"`);
  }
  res.send(reportHtml);
});

// Rescan a single page — POST body: { url: string }
app.post('/api/audit/:id/rescan', async (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  if (session.status !== 'completed' && session.status !== 'error') {
    return res.status(400).json({ error: 'Audit must be completed before rescanning individual pages' });
  }

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  // Mark the page as rescanning so the UI can show a spinner
  const existingIdx = session.pages.findIndex(p => p.url === url);
  if (existingIdx >= 0) {
    session.pages[existingIdx] = { ...session.pages[existingIdx], status: 'rescanning' };
  }
  broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });

  try {
    const result = await rescanPage(url);

    // Replace or append the page result
    if (existingIdx >= 0) {
      session.pages[existingIdx] = result;
    } else {
      session.pages.push(result);
    }

    // Recompute summary
    const completed = session.pages.filter(p => p.status === 'completed');
    const scores = completed.map(p => p.score).filter(s => s !== null);
    const allIssues = completed.flatMap(p => p.issues || []);

    session.summary = {
      ...session.summary,
      totalPages: session.pages.length,
      successfulPages: completed.length,
      errorPages: session.pages.filter(p => p.status === 'error').length,
      averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0,
      minScore: scores.length ? Math.min(...scores) : 0,
      maxScore: scores.length ? Math.max(...scores) : 0,
      totalIssues: allIssues.length,
      criticalIssues: allIssues.filter(i => i.severity === 'critical').length,
      seriousIssues: allIssues.filter(i => i.severity === 'serious').length,
      moderateIssues: allIssues.filter(i => i.severity === 'moderate').length,
      minorIssues: allIssues.filter(i => i.severity === 'minor').length,
      pagesAbove90: scores.filter(s => s >= 90).length,
      pages70to89: scores.filter(s => s >= 70 && s < 90).length,
      pages50to69: scores.filter(s => s >= 50 && s < 70).length,
      pagesBelow50: scores.filter(s => s < 50).length,
    };

    broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
    await saveSessionToDisk(session);

    res.json({ success: true, page: result });
  } catch (err) {
    console.error('[rescan] Error:', err.message);
    // Restore page as error if rescan itself threw unexpectedly
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

// Email report — POST body: { emails: string[], brand: string }
app.post('/api/audit/:id/email', async (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  if (session.status !== 'completed') {
    return res.status(400).json({ error: 'Audit not yet completed' });
  }

  const { emails, brand } = req.body;

  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'At least one email address is required' });
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(503).json({
      error: 'Email is not configured on this server. Set SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables.',
    });
  }

  try {
    const htmlContent = generateReport(session, brand || null, false);
    const pdfBuffer = await generatePdfBuffer(htmlContent);

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const domain = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
    const date = new Date().toISOString().split('T')[0];
    const avgScore = session.summary?.averageScore ?? 0;

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: emails.join(', '),
      subject: `ADA Accessibility Report – ${session.url}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <h2 style="color:#107DC2;">ADA Accessibility Report</h2>
          <p>Please find attached the ADA Accessibility Report for <strong>${session.url}</strong>.</p>
          <table style="margin:20px 0;border-collapse:collapse;width:100%;">
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Pages Audited</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalPages ?? 0}</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Average Score</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${avgScore}/100</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Total Issues</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalIssues ?? 0}</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Critical</td><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#dc2626;">${session.summary?.criticalIssues ?? 0}</td></tr>
            <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Serious</td><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#ea580c;">${session.summary?.seriousIssues ?? 0}</td></tr>
          </table>
          <p style="font-size:12px;color:#94a3b8;margin-top:32px;">Generated by Planeteria Inquiros ADA Checker &bull; Powered by Google Lighthouse</p>
        </div>
      `,
      attachments: [{
        filename: `accessibility-report-${domain}-${date}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });

    res.json({ success: true, message: `Report sent to ${emails.join(', ')}` });
  } catch (err) {
    console.error('[email] Error:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// AI Fix — POST body: { pageUrl, issue, targetType:'live'|'dev', devUrl, username, password }
app.post('/api/audit/:id/fix', async (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  if (session.status !== 'completed') return res.status(400).json({ error: 'Audit not yet completed' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({
      error: 'ANTHROPIC_API_KEY is not configured on this server. Add it to your Render environment variables.',
    });
  }

  const { pageUrl, issue, targetType, devUrl, username, password } = req.body;
  if (!pageUrl || !issue || !username || !password) {
    return res.status(400).json({ error: 'Missing required fields: pageUrl, issue, username, password' });
  }

  const wpBaseUrl = (targetType === 'dev' && devUrl)
    ? new URL(devUrl).origin
    : new URL(pageUrl).origin;

  const targetPageUrl = (targetType === 'dev' && devUrl) ? devUrl : pageUrl;

  try {
    const result = await applyFix({ wpBaseUrl, username, password, pageUrl: targetPageUrl, issue });
    res.json(result);
  } catch (err) {
    console.error('[fix] Error:', err.message);
    res.status(500).json({ error: 'Fix failed: ' + err.message });
  }
});

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ── Startup ────────────────────────────────────────────────────────────────────

await mkdir(DATA_DIR, { recursive: true }).catch(() => {});
await loadSessionsFromDisk();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ADA Accessibility Auditor running on http://localhost:${PORT}`);
  console.log(`Session storage: ${DATA_DIR}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
