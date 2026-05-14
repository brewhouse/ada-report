import { v4 as uuidv4 } from 'uuid';
import cron from 'node-cron';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import { startAudit } from './audit-manager.js';
import { generateReport, generateSummaryReport, generateVpatReport } from './report-generator.js';
import {
  upsertScheduleToDb, deleteScheduleFromDb,
  loadSchedulesFromDb, patchScheduleInDb,
  savePage, upsertSession, getIgnoredIssuesForSite,
} from './db.js';
import { uploadReportPdfs } from './s3.js';

const TIMEZONE        = 'America/Los_Angeles';
const AUDIT_TIMEOUT_MS = 480 * 60 * 1000;

let reportsDir = null;

// In-memory cache — loaded from DB on startup, kept in sync for cron scheduling.
const schedules = new Map();  // id → schedule object
const cronJobs  = new Map();  // id → node-cron task

// ── Helpers ───────────────────────────────────────────────────────────────────

const DAYS_LONG = ['Sundays','Mondays','Tuesdays','Wednesdays','Thursdays','Fridays','Saturdays'];

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatTime(hour, minute) {
  const h  = hour   ?? 8;
  const m  = minute ?? 0;
  const hh = h % 12 || 12;
  const mm = String(m).padStart(2, '0');
  return `${hh}:${mm} ${h < 12 ? 'AM' : 'PM'} PST`;
}

export function describeSchedule(s) {
  const t = formatTime(s.hour, s.minute);
  switch (s.frequency) {
    case 'daily':   return `Daily at ${t}`;
    case 'weekly':  return `Weekly on ${DAYS_LONG[s.dayOfWeek ?? 1]} at ${t}`;
    case 'monthly': return `Monthly on the ${ordinal(s.dayOfMonth ?? 1)} at ${t}`;
    default: return '';
  }
}

function buildCronExpr({ frequency, dayOfWeek, dayOfMonth, hour, minute }) {
  const m = minute ?? 0;
  const h = hour   ?? 8;
  switch (frequency) {
    case 'daily':   return `${m} ${h} * * *`;
    case 'weekly':  return `${m} ${h} * * ${dayOfWeek ?? 1}`;
    case 'monthly': return `${m} ${h} ${dayOfMonth ?? 1} * *`;
    default: return null;
  }
}

// ── PDF generation ─────────────────────────────────────────────────────────────

async function generatePdfBuffer(htmlContent) {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  try {
    await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 60000 });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Email delivery ─────────────────────────────────────────────────────────────

async function sendDevReport(session, schedule, s3Links) {
  if (!schedule.devEmails?.length) return;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const avg = session.summary?.averageScore ?? 0;
  const baseUrl    = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const resultsUrl = `${baseUrl}/?auditId=${session.id}`;

  // Build download links section for S3-hosted reports.
  const downloadLinks = (s3Links?.summaryUrl || s3Links?.detailUrl || s3Links?.vpatUrl) ? `
        <p style="margin-top:24px;font-weight:600;">Download Reports:</p>
        <ul style="list-style:none;padding:0;margin:8px 0 0 0;">
          ${s3Links.summaryUrl ? `<li style="margin:6px 0;"><a href="${s3Links.summaryUrl}" style="color:#107DC2;text-decoration:none;">&#128196; ADA Summary Report (PDF)</a></li>` : ''}
          ${s3Links.detailUrl  ? `<li style="margin:6px 0;"><a href="${s3Links.detailUrl}"  style="color:#107DC2;text-decoration:none;">&#128203; ADA Detailed Report (PDF)</a></li>` : ''}
          ${s3Links.vpatUrl    ? `<li style="margin:6px 0;"><a href="${s3Links.vpatUrl}"    style="color:#107DC2;text-decoration:none;">&#128221; VPAT Conformance Report (PDF)</a></li>` : ''}
        </ul>
  ` : '';

  await transporter.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to:      schedule.devEmails.join(', '),
    subject: `ADA Detailed Report (Developer) – ${session.url}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#107DC2;">ADA Detailed Accessibility Report</h2>
        <p>A scheduled audit completed for <strong>${session.url}</strong>.</p>
        <table style="margin:20px 0;border-collapse:collapse;width:100%;">
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Pages Audited</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalPages ?? 0}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Average Score</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${avg}/100</td></tr>
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
        <p style="font-size:12px;color:#94a3b8;margin-top:32px;">Scheduled report by Planeteria Inquiros ADA Checker</p>
      </div>
    `,
  });

  console.log(`[scheduler] Dev report emailed to ${schedule.devEmails.join(', ')} for ${schedule.url}`);
}

async function sendReport(session, schedule, s3Links, { summaryPdf, detailPdf, vpatPdf }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[scheduler] SMTP not configured — skipping email for schedule:', schedule.id);
    return;
  }

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const domain     = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const date       = new Date().toISOString().split('T')[0];
  const avg        = session.summary?.averageScore ?? 0;
  const baseUrl    = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const resultsUrl = `${baseUrl}/?auditId=${session.id}`;

  // Build download links section for S3-hosted reports.
  const downloadLinks = (s3Links?.summaryUrl || s3Links?.detailUrl || s3Links?.vpatUrl) ? `
        <p style="margin-top:24px;font-weight:600;">Download Reports:</p>
        <ul style="list-style:none;padding:0;margin:8px 0 0 0;">
          ${s3Links.summaryUrl ? `<li style="margin:6px 0;"><a href="${s3Links.summaryUrl}" style="color:#107DC2;text-decoration:none;">&#128196; ADA Summary Report (PDF)</a></li>` : ''}
          ${s3Links.detailUrl  ? `<li style="margin:6px 0;"><a href="${s3Links.detailUrl}"  style="color:#107DC2;text-decoration:none;">&#128203; ADA Detailed Report (PDF)</a></li>` : ''}
          ${s3Links.vpatUrl    ? `<li style="margin:6px 0;"><a href="${s3Links.vpatUrl}"    style="color:#107DC2;text-decoration:none;">&#128221; VPAT Conformance Report (PDF)</a></li>` : ''}
        </ul>
  ` : '';

  await transporter.sendMail({
    from:    process.env.SMTP_FROM || process.env.SMTP_USER,
    to:      schedule.emails.join(', '),
    subject: `ADA Accessibility Report – ${session.url}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#107DC2;">Scheduled ADA Accessibility Report</h2>
        <p>Automatic scheduled audit for <strong>${session.url}</strong>.</p>
        <table style="margin:20px 0;border-collapse:collapse;width:100%;">
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Schedule</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;">${describeSchedule(schedule)}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Pages Audited</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalPages ?? 0}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Average Score</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;">${avg}/100</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Total Issues</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalIssues ?? 0}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Critical Issues</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;color:#dc2626;">${session.summary?.criticalIssues ?? 0}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Serious Issues</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;color:#ea580c;">${session.summary?.seriousIssues ?? 0}</td></tr>
        </table>
        ${downloadLinks}
        <p style="margin-top:20px;">
          <a href="${resultsUrl}" style="display:inline-block;padding:10px 20px;background:#107DC2;color:#fff;border-radius:5px;text-decoration:none;font-weight:600;">
            View Audit Results &amp; Re-scan Pages
          </a>
        </p>
        <p style="font-size:12px;color:#94a3b8;margin-top:32px;">
          Scheduled report by Planeteria Inquiros ADA Checker &bull; Powered by Google Lighthouse, Axe Tools &amp; IBM Equal Access Checker
        </p>
      </div>
    `,
    attachments: [
      { filename: `accessibility-summary-${domain}-${date}.pdf`, content: summaryPdf, contentType: 'application/pdf' },
      { filename: `accessibility-detail-${domain}-${date}.pdf`,  content: detailPdf,  contentType: 'application/pdf' },
      { filename: `vpat-report-${domain}-${date}.pdf`,           content: vpatPdf,    contentType: 'application/pdf' },
    ],
  });

  console.log(`[scheduler] Report emailed to ${schedule.emails.join(', ')} for ${schedule.url}`);
}

// ── Audit runner ───────────────────────────────────────────────────────────────

async function runScheduledAudit(scheduleId) {
  const schedule = schedules.get(scheduleId);
  if (!schedule || !schedule.enabled) return;

  console.log(`[scheduler] Starting audit — ${schedule.url} (id: ${scheduleId})`);
  const startedAt = new Date().toISOString();

  const session = {
    id:              uuidv4(),
    url:             schedule.url,
    urlList:         null,
    excludeSitemaps: schedule.excludeSitemaps?.length > 0 ? schedule.excludeSitemaps : null,
    maxPages:        Math.min(schedule.maxPages || 50, 5000),
    status:          'queued',
    startTime:       startedAt,
    endTime:         null,
    pages:           [],
    crawledUrls:     [],
    currentPage:     null,
    progress:        { crawled: 0, total: 0, audited: 0 },
    summary:         null,
    error:           null,
  };

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Scheduled audit timed out')), AUDIT_TIMEOUT_MS)
  );

  // Register session so it shows in the live queue on the landing page.
  if (_registerSession) _registerSession(session);

  const pendingPageSaves = [];

  try {
    await Promise.race([
      startAudit(session, update => {
        if ('completedPage' in update) {
          if (update.completedPage) {
            const page = update.completedPage;
            session.pages.push(page);
            // Persist page to DB immediately — keep issues in memory for
            // report generation and summary computation.
            const p = savePage(session.id, page)
              .catch(err => console.warn('[scheduler][db] savePage error:', err.message));
            pendingPageSaves.push(p);
          }
          const { completedPage, ...rest } = update;
          Object.assign(session, rest);
        } else {
          Object.assign(session, update);
        }
      }),
      timeout,
    ]);

    // Wait for all page saves to finish before generating reports.
    await Promise.allSettled(pendingPageSaves);

    if (session.status === 'completed') {
      // Persist session metadata + summary to DB so the "View Results" link works.
      await upsertSession(session).catch(err =>
        console.warn('[scheduler][db] upsertSession error:', err.message)
      );

      // Generate all three report PDFs once, upload to S3, then email.
      const brand  = schedule.brand || null;
      const domain = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
      const date   = new Date().toISOString().split('T')[0];

      const ignoredIssuesList = await getIgnoredIssuesForSite(session.url).catch(() => []);

      const [summaryPdf, detailPdf, vpatPdf] = await Promise.all([
        generatePdfBuffer(generateSummaryReport(session, brand, false, ignoredIssuesList)),
        generatePdfBuffer(generateReport(session, brand, false, ignoredIssuesList)),
        generatePdfBuffer(generateVpatReport(session, brand)),
      ]);

      // Upload to S3 for persistent access.
      const s3Links = await uploadReportPdfs({
        summaryPdf, detailPdf, vpatPdf, domain, date, sessionId: session.id,
      });

      // Also save detailed HTML report to local disk as a fallback.
      if (reportsDir) {
        try {
          const reportFilename = `${domain}-${date}-${session.id}.html`;
          const reportHtml = generateReport(session, brand, false, ignoredIssuesList);
          await writeFile(join(reportsDir, reportFilename), reportHtml, 'utf8');
          console.log(`[scheduler] Detailed report saved locally: ${reportFilename}`);
        } catch (err) {
          console.warn('[scheduler] Failed to save detailed report locally:', err.message);
        }
      }

      // Send emails with S3 links and PDF attachments.
      const pdfs = { summaryPdf, detailPdf, vpatPdf };
      await sendReport(session, schedule, s3Links, pdfs).catch(err =>
        console.warn('[scheduler] Report email failed:', err.message)
      );
      await sendDevReport(session, schedule, s3Links).catch(err =>
        console.warn('[scheduler] Dev report email failed:', err.message)
      );
      await patchSchedule(scheduleId, { lastRun: startedAt, lastRunStatus: 'success', lastRunError: null });
      console.log(`[scheduler] Completed — ${schedule.url}`);
    } else {
      session.status = session.status || 'error';
      session.endTime = new Date().toISOString();
      await upsertSession(session).catch(() => {});
      await patchSchedule(scheduleId, {
        lastRun: startedAt, lastRunStatus: 'error',
        lastRunError: session.error || 'Audit did not complete',
      });
    }
  } catch (err) {
    console.error(`[scheduler] Audit failed — ${schedule.url}:`, err.message);
    await Promise.allSettled(pendingPageSaves);
    session.status = 'error';
    session.error = err.message;
    session.endTime = new Date().toISOString();
    await upsertSession(session).catch(() => {});
    await patchSchedule(scheduleId, { lastRun: startedAt, lastRunStatus: 'error', lastRunError: err.message });
  }
}

async function patchSchedule(id, fields) {
  const s = schedules.get(id);
  if (!s) return;
  Object.assign(s, fields);
  await patchScheduleInDb(id, fields).catch(err =>
    console.warn('[scheduler][db] patchScheduleInDb error:', err.message)
  );
}

// ── Cron registration ──────────────────────────────────────────────────────────

function registerCronJob(schedule) {
  const existing = cronJobs.get(schedule.id);
  if (existing) { existing.stop(); cronJobs.delete(schedule.id); }
  if (!schedule.enabled) return;

  const expr = buildCronExpr(schedule);
  if (!expr || !cron.validate(expr)) {
    console.warn(`[scheduler] Invalid cron expression for ${schedule.id}: "${expr}"`);
    return;
  }

  const task = cron.schedule(expr, () => {
    runScheduledAudit(schedule.id).catch(err =>
      console.error('[scheduler] Uncaught error in runScheduledAudit:', err.message)
    );
  }, { timezone: TIMEZONE });

  cronJobs.set(schedule.id, task);
  console.log(`[scheduler] Cron "${expr}" (TZ: ${TIMEZONE}) for ${schedule.url}`);
}

// ── Public API ─────────────────────────────────────────────────────────────────

// Callback provided by server.js so scheduler can register sessions in the
// shared auditSessions map, making them visible in the live queue.
let _registerSession = null;

export async function initScheduler(dataDir, registerSessionFn) {
  _registerSession = registerSessionFn || null;
  reportsDir = join(dataDir, 'reports');
  await mkdir(reportsDir, { recursive: true }).catch(() => {});

  // Load schedules from DB (replaces reading from schedules.json).
  try {
    const rows = await loadSchedulesFromDb();
    rows.forEach(s => schedules.set(s.id, s));
    console.log(`[scheduler] Loaded ${schedules.size} schedule(s) from database`);
  } catch (err) {
    console.warn('[scheduler] Failed to load schedules from DB:', err.message);
  }

  for (const s of schedules.values()) registerCronJob(s);
}

function enrichSchedule(s) {
  return { ...s, description: describeSchedule(s) };
}

export function getSchedules() {
  return [...schedules.values()].map(enrichSchedule);
}

export async function addSchedule(data) {
  const s = {
    id:              uuidv4(),
    name:            data.name            || '',
    url:             data.url,
    maxPages:        data.maxPages        || 50,
    excludeSitemaps: data.excludeSitemaps || [],
    frequency:       data.frequency       || 'weekly',
    dayOfWeek:       data.dayOfWeek       ?? 1,
    dayOfMonth:      data.dayOfMonth      ?? 1,
    hour:            data.hour            ?? 8,
    minute:          data.minute          ?? 0,
    emails:          data.emails          || [],
    devEmails:       data.devEmails       || [],
    brand:           data.brand           || 'planeteria',
    enabled:         data.enabled         !== false,
    lastRun:         null,
    lastRunStatus:   null,
    lastRunError:    null,
    createdAt:       new Date().toISOString(),
  };

  schedules.set(s.id, s);
  await upsertScheduleToDb(s);
  registerCronJob(s);
  return enrichSchedule(s);
}

export async function updateSchedule(id, data) {
  const existing = schedules.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...data, id };
  schedules.set(id, updated);
  await upsertScheduleToDb(updated);
  registerCronJob(updated);
  return enrichSchedule(updated);
}

export async function deleteSchedule(id) {
  const job = cronJobs.get(id);
  if (job) { job.stop(); cronJobs.delete(id); }
  schedules.delete(id);
  await deleteScheduleFromDb(id);
}

export async function triggerNow(id) {
  runScheduledAudit(id).catch(err =>
    console.error('[scheduler] triggerNow error:', err.message)
  );
}

export async function importSchedules(items) {
  let imported = 0, updated = 0, skipped = 0;
  for (const item of items) {
    if (!item?.id || !item?.url) { skipped++; continue; }
    try { new URL(item.url); } catch { skipped++; continue; }

    if (schedules.has(item.id)) {
      const merged = { ...schedules.get(item.id), ...item, id: item.id };
      schedules.set(item.id, merged);
      await upsertScheduleToDb(merged).catch(err =>
        console.warn('[scheduler][db] upsertScheduleToDb (import) error:', err.message)
      );
      registerCronJob(merged);
      updated++;
    } else {
      schedules.set(item.id, item);
      await upsertScheduleToDb(item).catch(err =>
        console.warn('[scheduler][db] upsertScheduleToDb (import) error:', err.message)
      );
      registerCronJob(item);
      imported++;
    }
  }
  return { imported, updated, skipped, total: items.length };
}
