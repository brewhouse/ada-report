import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import puppeteer from 'puppeteer';
import { startAudit } from './src/audit-manager.js';
import { generateReport } from './src/report-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// In-memory store for audit sessions (max 20)
const auditSessions = new Map();
const MAX_SESSIONS = 20;

// WebSocket connections per audit
const wsConnections = new Map();

// Audit queue for rate limiting
const auditQueue = [];
let runningAudits = 0;
const MAX_CONCURRENT_AUDITS = 2;

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

  // Send current state immediately
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

function cleanOldSessions() {
  if (auditSessions.size < MAX_SESSIONS) return;
  const sorted = [...auditSessions.entries()]
    .filter(([, s]) => s.status === 'completed' || s.status === 'error')
    .sort((a, b) => new Date(a[1].startTime) - new Date(b[1].startTime));
  const toDelete = sorted.slice(0, Math.max(1, sorted.length - MAX_SESSIONS + 1));
  toDelete.forEach(([id]) => auditSessions.delete(id));
}

async function processAuditQueue() {
  if (runningAudits >= MAX_CONCURRENT_AUDITS || auditQueue.length === 0) return;
  const { session } = auditQueue.shift();
  runningAudits++;

  try {
    await startAudit(session, (update) => {
      Object.assign(session, update);
      broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
    });
  } catch (error) {
    session.status = 'error';
    session.error = error.message;
    session.endTime = new Date().toISOString();
    broadcastToAudit(session.id, { type: 'update', data: sanitizeSession(session) });
  } finally {
    runningAudits--;
    processAuditQueue();
  }
}

// Generate a PDF buffer from HTML using Puppeteer
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
    // Use networkidle0 so external logo images have time to load
    await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 60000 });
    return await page.pdf({
      format: 'A4',
      landscape: false,
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// Start a new audit
app.post('/api/audit', (req, res) => {
  const { url, maxPages = 50 } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  cleanOldSessions();

  const auditId = uuidv4();
  const session = {
    id: auditId,
    url,
    maxPages: Math.min(Math.max(1, parseInt(maxPages) || 50), 5000),
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

// Get audit status
app.get('/api/audit/:id', (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  res.json(sanitizeSession(session));
});

// List recent audits
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

// Download HTML report (supports ?brand=planeteria|digitaldeployment|pensionx and ?autoprint=true)
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

  if (autoprint) {
    // Open inline in browser (no download) so print dialog fires
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
  } else {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="accessibility-report-${domain}-${date}.html"`);
  }
  res.send(reportHtml);
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

  // Validate SMTP config
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return res.status(503).json({
      error: 'Email is not configured on this server. Set SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables.',
    });
  }

  try {
    // Generate branded HTML report
    const htmlContent = generateReport(session, brand || null, false);

    // Convert to PDF
    const pdfBuffer = await generatePdfBuffer(htmlContent);

    // Build and send email
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
            <tr>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Pages Audited</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalPages ?? 0}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Average Score</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;">${avgScore}/100</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Total Issues</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;">${session.summary?.totalIssues ?? 0}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Critical</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;color:#dc2626;">${session.summary?.criticalIssues ?? 0}</td>
            </tr>
            <tr>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;">Serious</td>
              <td style="padding:8px 12px;border:1px solid #e2e8f0;color:#ea580c;">${session.summary?.seriousIssues ?? 0}</td>
            </tr>
          </table>
          <p style="font-size:12px;color:#94a3b8;margin-top:32px;">
            Generated by Planeteria Inquiros ADA Checker &bull; Powered by Google Lighthouse
          </p>
        </div>
      `,
      attachments: [
        {
          filename: `accessibility-report-${domain}-${date}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    res.json({ success: true, message: `Report sent to ${emails.join(', ')}` });
  } catch (err) {
    console.error('[email] Error:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// Serve the app for any other route (SPA fallback)
app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ADA Accessibility Auditor running on http://localhost:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
