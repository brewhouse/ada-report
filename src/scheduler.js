import { v4 as uuidv4 } from 'uuid';
import cron from 'node-cron';
import { readFile, writeFile, rename as renameFile, mkdir } from 'fs/promises';
import { join } from 'path';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import { startAudit } from './audit-manager.js';
import { generateReport, generateSummaryReport, generateVpatReport } from './report-generator.js';

const TIMEZONE = 'America/Los_Angeles';
const AUDIT_TIMEOUT_MS = 480 * 60 * 1000; // 480 minutes

let schedulesFile = null;
let reportsDir = null;
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
  const h = hour ?? 8;
  const m = minute ?? 0;
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
  const h = hour ?? 8;
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

async function sendDevReport(session, schedule, reportUrl) {
  if (!schedule.devEmails?.length) return;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const avg = session.summary?.averageScore ?? 0;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to:   schedule.devEmails.join(', '),
    subject: `ADA Detailed Report (Developer) – ${session.url}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#107DC2;">ADA Detailed Accessibility Report</h2>
        <p>A scheduled audit completed for <strong>${session.url}</strong>. The full detailed report (with per-page issue breakdowns) is available for download below.</p>
        <table style="margin:20px 0;border-collapse:collapse;width:100%;">
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Pages Audited</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalPages ?? 0}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Average Score</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${avg}/100</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Total Issues</td><td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalIssues ?? 0}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Critical</td><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#dc2626;">${session.summary?.criticalIssues ?? 0}</td></tr>
          <tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Serious</td><td style="padding:8px 12px;border:1px solid #e2e8f0;color:#ea580c;">${session.summary?.seriousIssues ?? 0}</td></tr>
        </table>
        <p>
          <a href="${reportUrl}" style="display:inline-block;padding:10px 20px;background:#107DC2;color:#fff;border-radius:5px;text-decoration:none;font-weight:600;">
            Download Full Report
          </a>
        </p>
        <p style="font-size:12px;color:#94a3b8;margin-top:8px;">This link is valid for 30 days.</p>
        <p style="font-size:12px;color:#94a3b8;margin-top:32px;">Scheduled report by Planeteria Inquiros ADA Checker &bull; Powered by Google Lighthouse</p>
      </div>
    `,
  });

  console.log(`[scheduler] Dev report emailed to ${schedule.devEmails.join(', ')} for ${schedule.url}`);
}

async function sendReport(session, schedule) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[scheduler] SMTP not configured — skipping email for schedule:', schedule.id);
    return;
  }

  const brand = schedule.brand || null;
  const [summaryPdf, vpatPdf] = await Promise.all([
    generatePdfBuffer(generateSummaryReport(session, brand, false)),
    generatePdfBuffer(generateVpatReport(session, brand)),
  ]);

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  const domain = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const date   = new Date().toISOString().split('T')[0];
  const avg    = session.summary?.averageScore ?? 0;

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to:   schedule.emails.join(', '),
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
        <p style="font-size:12px;color:#94a3b8;margin-top:32px;">
          Scheduled report by Planeteria Inquiros ADA Checker &bull; Powered by Google Lighthouse, Axe Tools &amp; IBM Equal Access Checker
        </p>
      </div>
    `,
    attachments: [
      {
        filename: `accessibility-summary-${domain}-${date}.pdf`,
        content:  summaryPdf,
        contentType: 'application/pdf',
      },
      {
        filename: `vpat-report-${domain}-${date}.pdf`,
        content:  vpatPdf,
        contentType: 'application/pdf',
      },
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
    id: uuidv4(),
    url: schedule.url,
    urlList: null,
    excludeSitemaps: schedule.excludeSitemaps?.length > 0 ? schedule.excludeSitemaps : null,
    maxPages: Math.min(schedule.maxPages || 50, 5000),
    status: 'queued',
    startTime: startedAt,
    endTime: null,
    pages: [],
    crawledUrls: [],
    currentPage: null,
    progress: { crawled: 0, total: 0, audited: 0 },
    summary: null,
    error: null,
  };

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Scheduled audit timed out')), AUDIT_TIMEOUT_MS)
  );

  try {
    await Promise.race([
      startAudit(session, update => {
        if ('completedPage' in update) {
          if (update.completedPage) session.pages.push(update.completedPage);
          const { completedPage, ...rest } = update;
          Object.assign(session, rest);
        } else {
          Object.assign(session, update);
        }
      }),
      timeout,
    ]);

    if (session.status === 'completed') {
      // Save detailed HTML report to disk and email link to developers
      let reportUrl = null;
      if (reportsDir) {
        try {
          const domain = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
          const date = new Date().toISOString().split('T')[0];
          const reportFilename = `${domain}-${date}-${session.id}.html`;
          const reportHtml = generateReport(session, schedule.brand || null, false);
          await writeFile(join(reportsDir, reportFilename), reportHtml, 'utf8');
          const baseUrl = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
          reportUrl = `${baseUrl}/api/reports/${reportFilename}`;
          console.log(`[scheduler] Detailed report saved: ${reportFilename}`);
        } catch (err) {
          console.warn('[scheduler] Failed to save detailed report:', err.message);
        }
      }

      await sendReport(session, schedule);
      if (reportUrl) await sendDevReport(session, schedule, reportUrl).catch(err =>
        console.warn('[scheduler] Dev report email failed:', err.message)
      );
      await patchSchedule(scheduleId, {
        lastRun: startedAt, lastRunStatus: 'success', lastRunError: null,
      });
      console.log(`[scheduler] Completed — ${schedule.url}`);
    } else {
      await patchSchedule(scheduleId, {
        lastRun: startedAt, lastRunStatus: 'error',
        lastRunError: session.error || 'Audit did not complete',
      });
    }
  } catch (err) {
    console.error(`[scheduler] Audit failed — ${schedule.url}:`, err.message);
    await patchSchedule(scheduleId, {
      lastRun: startedAt, lastRunStatus: 'error', lastRunError: err.message,
    });
  }
}

async function patchSchedule(id, fields) {
  const s = schedules.get(id);
  if (!s) return;
  Object.assign(s, fields);
  await saveSchedules();
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

// ── Persistence ────────────────────────────────────────────────────────────────

async function saveSchedules() {
  if (!schedulesFile) return;
  // Write to a temp file first, then atomically rename — prevents data loss on OOM kill.
  const tmp = schedulesFile + '.tmp';
  await writeFile(tmp, JSON.stringify([...schedules.values()], null, 2), 'utf8');
  await renameFile(tmp, schedulesFile);
}

async function loadSchedules() {
  try {
    const data = JSON.parse(await readFile(schedulesFile, 'utf8'));
    if (Array.isArray(data)) {
      data.forEach(s => s?.id && schedules.set(s.id, s));
      console.log(`[scheduler] Loaded ${schedules.size} schedule(s) from disk`);
    }
  } catch { /* file doesn't exist yet — that's fine */ }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function initScheduler(dataDir) {
  schedulesFile = join(dataDir, 'schedules.json');
  reportsDir = join(dataDir, 'reports');
  await mkdir(reportsDir, { recursive: true }).catch(() => {});
  console.log(`[scheduler] Schedules file: ${schedulesFile}`);
  await loadSchedules();
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
    name:            data.name || '',
    url:             data.url,
    maxPages:        data.maxPages || 50,
    excludeSitemaps: data.excludeSitemaps || [],
    frequency:       data.frequency || 'weekly',
    dayOfWeek:       data.dayOfWeek  ?? 1,
    dayOfMonth:      data.dayOfMonth ?? 1,
    hour:            data.hour   ?? 8,
    minute:          data.minute ?? 0,
    emails:          data.emails    || [],
    devEmails:       data.devEmails || [],
    brand:           data.brand  || 'planeteria',
    enabled:         data.enabled !== false,
    lastRun:         null,
    lastRunStatus:   null,
    lastRunError:    null,
    createdAt:       new Date().toISOString(),
  };
  schedules.set(s.id, s);
  registerCronJob(s);
  await saveSchedules();
  return enrichSchedule(s);
}

export async function updateSchedule(id, data) {
  const existing = schedules.get(id);
  if (!existing) return null;
  const updated = { ...existing, ...data, id };
  schedules.set(id, updated);
  registerCronJob(updated);
  await saveSchedules();
  return enrichSchedule(updated);
}

export async function deleteSchedule(id) {
  const job = cronJobs.get(id);
  if (job) { job.stop(); cronJobs.delete(id); }
  schedules.delete(id);
  await saveSchedules();
}

export async function triggerNow(id) {
  // Fire and forget — does not block the HTTP response
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
      registerCronJob(merged);
      updated++;
    } else {
      schedules.set(item.id, item);
      registerCronJob(item);
      imported++;
    }
  }
  await saveSchedules();
  return { imported, updated, skipped, total: items.length };
}
