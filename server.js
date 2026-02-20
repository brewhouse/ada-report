import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
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
  // Strip raw lighthouse data from pages to keep payload manageable
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
  // Remove oldest completed/error sessions
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
    maxPages: Math.min(Math.max(1, parseInt(maxPages) || 50), 200),
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

// Download HTML report
app.get('/api/audit/:id/report', (req, res) => {
  const session = auditSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Audit not found' });
  if (session.status !== 'completed') {
    return res.status(400).json({ error: 'Audit not yet completed' });
  }
  const reportHtml = generateReport(session);
  const domain = new URL(session.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const date = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="accessibility-report-${domain}-${date}.html"`);
  res.send(reportHtml);
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
