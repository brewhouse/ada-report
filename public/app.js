// ===================== UTILITIES =====================

function scoreClass(score) {
  if (score === null || score === undefined) return '';
  if (score >= 90) return 'score-green';
  if (score >= 70) return 'score-lime';
  if (score >= 50) return 'score-amber';
  return 'score-red';
}

function scoreColorHex(score) {
  if (score === null || score === undefined) return '#CBD5E0';
  if (score >= 90) return '#276749';
  if (score >= 70) return '#285E61';
  if (score >= 50) return '#7B341E';
  return '#9B2335';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname : u.hostname + u.pathname;
  } catch { return url; }
}

function timeAgo(isoString) {
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

// ===================== SCORE GAUGE (Canvas) =====================

function drawScoreGauge(canvas, score) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 10;
  const startAngle = -Math.PI / 2;
  const color = scoreColorHex(score);
  const pct = (score ?? 0) / 100;

  ctx.clearRect(0, 0, w, h);

  // Background circle
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 10;
  ctx.stroke();

  // Score arc
  if (score !== null && score !== undefined) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle, startAngle + pct * Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  // Score text
  ctx.fillStyle = color;
  ctx.font = `700 28px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(score !== null && score !== undefined ? score : '—', cx, cy - 6);

  // "/100" text
  ctx.fillStyle = '#94a3b8';
  ctx.font = `500 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.fillText('/100', cx, cy + 14);
}

// ===================== RECENT AUDITS (localStorage) =====================

const RECENT_KEY = 'ada_recent_audits';
const MAX_RECENT = 8;

function saveRecentAudit(id, url, score, status) {
  const recent = getRecentAudits();
  const existing = recent.findIndex(a => a.id === id);
  const entry = { id, url, score, status, timestamp: new Date().toISOString() };
  if (existing >= 0) recent[existing] = entry;
  else recent.unshift(entry);
  localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
}

function getRecentAudits() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

// ===================== APP STATE =====================

let currentAuditId = null;
let currentSession = null;
let ws = null;
let selectedPageUrl = null;
let currentFilter = 'all';
let currentSort = 'score-asc';
let scanningMode = false;
let scanLivePageCount = 0;

// ===================== VIEW MANAGEMENT =====================

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  if (name !== 'landing') stopLandingQueuePoll();
}

// ===================== LANDING =====================

function initLanding() {
  renderRecentAudits();
  showView('landing');
  startLandingQueuePoll();
}

// ===================== LANDING LIVE QUEUE =====================

let _landingQueueTimer = null;

function startLandingQueuePoll() {
  loadLandingQueue();
  if (_landingQueueTimer) clearInterval(_landingQueueTimer);
  _landingQueueTimer = setInterval(loadLandingQueue, 5000);
}

function stopLandingQueuePoll() {
  if (_landingQueueTimer) { clearInterval(_landingQueueTimer); _landingQueueTimer = null; }
}

async function loadLandingQueue() {
  const wrap    = document.getElementById('landing-queue-wrap');
  const content = document.getElementById('landing-queue-content');
  if (!wrap || !content) return;

  try {
    const res = await fetch('/api/queue');
    if (!res.ok) return;
    const { active, queued, runningAudits, maxConcurrent } = await res.json();

    wrap.style.display = '';

    if (!active.length && !queued.length) {
      content.innerHTML = `<div style="padding:20px 14px;text-align:center;color:#94a3b8;font-size:13px">No active audits — queue is idle</div>`;
      return;
    }

    // Fetch progress for running audits
    const progressMap = {};
    await Promise.all(active.map(async a => {
      try {
        const r = await fetch(`/api/audit/${a.id}`);
        if (r.ok) {
          const d = await r.json();
          const p = d.progress || {};
          const audited = p.audited || 0;
          const total   = p.total   || 0;
          progressMap[a.id] = { audited, total, pct: total > 0 ? Math.round(audited / total * 100) : 0 };
        }
      } catch { /* ignore */ }
    }));

    const rows = [
      ...active.map(a => ({ ...a, queueType: 'running' })),
      ...queued.map(a => ({ ...a, queueType: 'queued' })),
    ];

    content.innerHTML = `
      <div style="padding:8px 14px;font-size:12px;color:#64748b;border-bottom:1px solid #e2e8f0">
        ${runningAudits} of ${maxConcurrent} slots in use
      </div>
      <table class="lq-table">
        <thead><tr>
          <th>URL</th><th>Status</th><th>Progress</th><th>Started</th><th></th>
        </tr></thead>
        <tbody>
          ${rows.map(a => {
            const prog = progressMap[a.id];
            const progressCell = prog
              ? `<div style="display:flex;align-items:center;gap:8px;min-width:130px">
                   <div style="flex:1;height:5px;background:#dbeafe;border-radius:3px;overflow:hidden">
                     <div style="width:${prog.pct}%;height:100%;background:#3b82f6;border-radius:3px;transition:width .4s"></div>
                   </div>
                   <span style="font-size:12px;font-weight:600;color:#1d4ed8;white-space:nowrap">${prog.pct}%</span>
                   <span style="font-size:11px;color:#94a3b8;white-space:nowrap">${prog.audited}/${prog.total}</span>
                 </div>`
              : `<span style="font-size:12px;color:#cbd5e1">—</span>`;
            return `<tr>
              <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(a.url)}">${escapeHtml(a.url)}</td>
              <td><span class="lq-badge ${a.queueType === 'running' ? 'running' : 'queued'}">
                ${a.queueType === 'running'
                  ? `<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#3b82f6;animation:lq-pulse 1.5s infinite"></span> ${escapeHtml(a.status || 'running')}`
                  : 'Queued'}
              </span></td>
              <td>${progressCell}</td>
              <td style="color:#64748b;font-size:12px">${timeAgo(a.startTime)}</td>
              <td><button class="lq-cancel" data-id="${escapeHtml(a.id)}">Cancel</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    content.querySelectorAll('.lq-cancel').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Cancel this audit?')) return;
        btn.disabled = true;
        btn.textContent = 'Cancelling…';
        try {
          await fetch(`/api/audit/${btn.dataset.id}`, { method: 'DELETE' });
          await loadLandingQueue();
        } catch {
          btn.disabled = false;
          btn.textContent = 'Cancel';
        }
      });
    });
  } catch { /* silent */ }
}

document.getElementById('landing-queue-refresh-btn').addEventListener('click', loadLandingQueue);

function renderRecentAudits() {
  const recent = getRecentAudits().filter(a => a.status === 'completed' || a.status === 'error');
  const wrap = document.getElementById('recent-audits');
  const list = document.getElementById('recent-list');
  if (!recent.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  list.innerHTML = recent.map(a => {
    const sc = a.score;
    const cls = scoreClass(sc);
    return `<div class="recent-item" data-id="${escapeHtml(a.id)}">
      <div class="r-url">${escapeHtml(shortUrl(a.url))}</div>
      <div class="r-meta">${escapeHtml(a.url)} &bull; ${timeAgo(a.timestamp)}</div>
      ${sc !== null && sc !== undefined
        ? `<span class="recent-score ${cls}">${sc}/100</span>`
        : `<span class="recent-score" style="color:#94a3b8;background:#f1f5f9;">Error</span>`}
    </div>`;
  }).join('');
  list.querySelectorAll('.recent-item').forEach(el => {
    el.addEventListener('click', () => loadExistingAudit(el.dataset.id));
  });
}

async function loadExistingAudit(auditId) {
  try {
    const res = await fetch(`/api/audit/${auditId}`);
    if (!res.ok) throw new Error('Not found');
    const session = await res.json();
    currentAuditId = auditId;
    currentSession = session;
    history.pushState({}, '', `?auditId=${auditId}`);

    if (session.status === 'completed') {
      renderResults(session);
    } else if (session.status === 'crawling' || session.status === 'auditing' || session.status === 'queued') {
      if (session.status === 'auditing' && session.pages && session.pages.length > 0) {
        enterLiveResultsMode(session);
      } else {
        showProgress(session);
      }
      connectWebSocket(auditId);
    } else {
      alert(`Audit ended with status: ${session.status}. ${session.error || ''}`);
    }
  } catch {
    alert('Could not load audit. It may have expired.');
  }
}

// ===================== AUDIT MODE TOGGLE =====================

let auditMode = 'crawl'; // 'crawl' | 'url-list'

document.getElementById('mode-crawl-btn').addEventListener('click', () => setAuditMode('crawl'));
document.getElementById('mode-list-btn').addEventListener('click', () => setAuditMode('url-list'));

function setAuditMode(mode) {
  auditMode = mode;
  document.getElementById('mode-crawl-btn').classList.toggle('active', mode === 'crawl');
  document.getElementById('mode-list-btn').classList.toggle('active', mode === 'url-list');
  document.getElementById('crawl-mode-fields').style.display = mode === 'crawl' ? '' : 'none';
  document.getElementById('url-list-mode-fields').style.display = mode === 'url-list' ? '' : 'none';
}

// Live URL count for url-list mode
document.getElementById('url-list-input').addEventListener('input', () => {
  const urls = parseUrlList();
  const el = document.getElementById('url-list-count');
  el.textContent = urls.length > 0 ? `${urls.length} URL${urls.length !== 1 ? 's' : ''} entered` : '';
});

function parseUrlList() {
  return document.getElementById('url-list-input').value
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && (l.startsWith('http://') || l.startsWith('https://')));
}

// ===================== START AUDIT =====================

document.getElementById('audit-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const btn = document.getElementById('start-btn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    const wcag22 = document.getElementById('wcag22-checkbox').checked;
    let body;
    if (auditMode === 'url-list') {
      const urlList = parseUrlList();
      if (urlList.length === 0) throw new Error('Please enter at least one valid URL (must start with http:// or https://).');
      body = { urlList, wcag22 };
    } else {
      const url = document.getElementById('url-input').value.trim();
      if (!url) throw new Error('Please enter a website URL.');
      const maxPages = parseInt(document.getElementById('max-pages-input').value);
      const excludeSitemaps = parseExcludeSitemaps();
      body = { url, maxPages, wcag22, ...(excludeSitemaps.length > 0 && { excludeSitemaps }) };
    }

    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start audit');

    currentAuditId = data.auditId;
    currentSession = data.session;

    // Push ?auditId= to URL so the page is bookmarkable / shareable
    history.pushState({}, '', `?auditId=${data.auditId}`);

    showProgress(data.session);
    connectWebSocket(data.auditId);

  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
    </svg> Start Accessibility Audit`;
  }
});

// Slider label
document.getElementById('max-pages-input').addEventListener('input', (e) => {
  document.getElementById('max-pages-display').textContent = e.target.value;
});

// Exclude sitemaps toggle
document.getElementById('exclude-toggle-btn').addEventListener('click', () => {
  const fields = document.getElementById('exclude-sitemaps-fields');
  const btn = document.getElementById('exclude-toggle-btn');
  const icon = document.getElementById('exclude-toggle-icon');
  const expanded = fields.style.display !== 'none';
  fields.style.display = expanded ? 'none' : 'block';
  btn.setAttribute('aria-expanded', String(!expanded));
  icon.style.transform = expanded ? '' : 'rotate(180deg)';
});

// Live count for exclude sitemaps
document.getElementById('exclude-sitemaps-input').addEventListener('input', () => {
  const urls = parseExcludeSitemaps();
  const el = document.getElementById('exclude-sitemaps-count');
  el.textContent = urls.length > 0 ? `${urls.length} sitemap${urls.length !== 1 ? 's' : ''} to exclude` : '';
});

function parseExcludeSitemaps() {
  return document.getElementById('exclude-sitemaps-input').value
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && (l.startsWith('http://') || l.startsWith('https://')));
}

// ===================== WEBSOCKET =====================

function connectWebSocket(auditId) {
  if (ws) { try { ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/?auditId=${auditId}`);

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);

    // ── Targeted per-page update from auto-rescan (no full re-render) ──
    if (msg.type === 'page-update') {
      const page = msg.data;
      if (!page?.url || !currentSession) return;
      const idx = currentSession.pages.findIndex(p => p.url === page.url);
      if (idx >= 0) {
        // Merge update; keep existing issues if the incoming page has none yet.
        currentSession.pages[idx] = {
          ...currentSession.pages[idx],
          ...page,
          issues: page.issues != null ? page.issues : currentSession.pages[idx].issues,
        };
      }
      renderPagesList(currentSession.pages);
      // If this page is open in the right panel and has new issues, refresh it.
      if (selectedPageUrl === page.url && page.issues) {
        renderIssues(page.issues);
      }
      return;
    }

    // ── Summary-only update after auto-rescan finishes ──
    if (msg.type === 'summary-update') {
      if (msg.data?.summary && currentSession) currentSession.summary = msg.data.summary;
      return;
    }

    // ── Full session update (normal audit progress / completion) ──
    const { data } = msg;
    if (!data) return;

    const wasCompleted = currentSession?.status === 'completed';
    currentSession = data;

    if (data.status === 'completed') {
      saveRecentAudit(auditId, data.url, data.summary?.averageScore ?? null, 'completed');
      if (!wasCompleted) {
        // First 'completed' broadcast — render directly from the broadcast
        // data (which now comes from DB with full issues) instead of calling
        // loadExistingAudit, which is async and can race with subsequent
        // broadcasts, causing issues to disappear.
        renderResults(data);
      } else {
        // Subsequent full-session broadcast (e.g. after auto-rescan)
        // — refresh page list and, if a page is open, update the right panel.
        renderPagesList(data.pages);
        if (selectedPageUrl) {
          const sel = data.pages.find(p => p.url === selectedPageUrl);
          if (sel) renderIssues(sel.issues || []);
        }
      }
    } else if (data.status === 'error') {
      saveRecentAudit(auditId, data.url, null, 'error');
      exitScanningMode();
      alert(`Audit failed: ${data.error}`);
      initLanding();
    } else {
      updateProgress(data);
    }
  };

  ws.onerror = () => {};
  ws.onclose = () => {};
}

// ===================== PROGRESS VIEW =====================

function showProgress(session) {
  document.getElementById('progress-site-url').textContent = session.url;
  document.getElementById('progress-phase-label').textContent =
    session.status === 'queued' ? 'Waiting in queue...' : 'Discovering pages...';
  document.getElementById('progress-current-url').textContent = '';
  document.getElementById('progress-bar-fill').style.width = '0%';
  document.getElementById('progress-counts').textContent = '0 / 0 pages audited';
  document.getElementById('progress-page-list').innerHTML = '';
  showView('progress');
}

function updateProgress(session) {
  const { status, progress, currentPage, pages } = session;

  // Once pages start completing during auditing, switch to live results view
  if (status === 'auditing' && pages && pages.length > 0) {
    if (!scanningMode) {
      enterLiveResultsMode(session);
    } else {
      updateLiveResults(session);
    }
    return;
  }

  // Phase label (queued / crawling)
  let phaseText = 'Waiting in queue...';
  if (status === 'crawling') phaseText = 'Discovering pages...';
  else if (status === 'auditing') phaseText = 'Auditing pages...';
  document.getElementById('progress-phase-label').textContent = phaseText;

  if (currentPage) {
    document.getElementById('progress-current-url').textContent = `Scanning: ${currentPage}`;
  }

  if (progress && progress.total > 0) {
    const pct = Math.round((progress.audited / progress.total) * 100);
    document.getElementById('progress-bar-fill').style.width = `${pct}%`;
    document.getElementById('progress-counts').textContent =
      `${progress.audited} / ${progress.total} pages audited`;
  }

  if (pages && pages.length > 0) {
    const listEl = document.getElementById('progress-page-list');
    listEl.innerHTML = pages.map(p => {
      const isCurrent = p.url === currentPage;
      const cls = scoreClass(p.score);
      return `<div class="progress-page-item">
        <span class="p-status-icon">
          ${p.status === 'error'
            ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
            : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>'
          }
        </span>
        <span class="p-url">${escapeHtml(shortUrl(p.url))}</span>
        ${isCurrent
          ? `<span class="p-scanning"><span class="mini-spinner"></span> scanning</span>`
          : p.status === 'completed'
            ? `<span class="p-score-badge ${cls}">${p.score}</span>`
            : p.status === 'error'
              ? `<span class="p-score-badge score-red">Error</span>`
              : ''}
        ${p.issueCount > 0 ? `<span style="font-size:11px;color:#64748b">${p.issueCount} issues</span>` : ''}
      </div>`;
    }).join('');
    listEl.scrollTop = listEl.scrollHeight;
  }
}

// ===================== LIVE RESULTS DURING SCAN =====================

function exitScanningMode() {
  if (!scanningMode) return;
  scanningMode = false;
  scanLivePageCount = 0;
  document.getElementById('results-scanning-banner').style.display = 'none';
  document.querySelector('.topbar-actions').style.display = '';
}

function enterLiveResultsMode(session) {
  scanningMode = true;
  scanLivePageCount = 0;

  showView('results');
  document.getElementById('results-site-url').textContent = session.url;

  // Show scanning banner, hide download/action buttons
  document.getElementById('results-scanning-banner').style.display = '';
  document.querySelector('.topbar-actions').style.display = 'none';

  // Empty the page list ready for live appending
  document.getElementById('pages-list').innerHTML = '';
  document.getElementById('page-count-badge').textContent = '0';

  // Reset summary to dashes (will fill in as pages come in)
  drawScoreGauge(document.getElementById('score-canvas'), null);
  ['stat-pages','stat-issues','stat-critical','stat-serious','stat-moderate','stat-minor']
    .forEach(id => { document.getElementById(id).textContent = '—'; });

  // Hide issues panel placeholder until a page is selected
  document.getElementById('issues-placeholder').style.display = 'flex';
  document.getElementById('issues-content').style.display = 'none';

  updateLiveResults(session);
}

function updateLiveResults(session) {
  const { progress, currentPage, pages } = session;

  // Update scanning banner
  if (progress && progress.total > 0) {
    const pct = Math.round((progress.audited / progress.total) * 100);
    document.getElementById('rsb-bar-fill').style.width = `${pct}%`;
    document.getElementById('rsb-counts').textContent = `${progress.audited} / ${progress.total} pages`;
    document.getElementById('rsb-label').textContent = `Auditing pages… ${pct}%`;
  }
  if (currentPage) {
    document.getElementById('rsb-current-url').textContent = `Scanning: ${currentPage}`;
  }

  // Append only newly completed pages (avoid full re-render)
  if (pages && pages.length > scanLivePageCount) {
    const list = document.getElementById('pages-list');
    const newPages = pages.slice(scanLivePageCount);
    newPages.forEach(page => {
      const cls = scoreClass(page.score);
      const isError = page.status === 'error';
      const div = document.createElement('div');
      div.className = `page-item${isError ? ' error-item' : ''}`;
      div.dataset.url = page.url;
      div.innerHTML = `
        <span class="page-score-pill ${cls}">
          ${page.score !== null && page.score !== undefined ? page.score : 'ERR'}
        </span>
        <span class="page-url-text" title="${escapeHtml(page.url)}">${escapeHtml(shortUrl(page.url))}</span>
        ${isError
          ? `<button class="rescan-btn" data-url="${escapeHtml(page.url)}" title="Re-audit this page">↺ Rescan</button>`
          : `<span class="page-issue-count">${page.issueCount} issues</span>`}`;
      if (!isError) {
        div.addEventListener('click', () => selectPage(page));
      }
      const rescanBtn = div.querySelector('.rescan-btn');
      if (rescanBtn) {
        rescanBtn.addEventListener('click', e => { e.stopPropagation(); rescanSinglePage(page.url); });
      }
      list.appendChild(div);
    });
    scanLivePageCount = pages.length;
    list.scrollTop = list.scrollHeight;
    document.getElementById('page-count-badge').textContent = pages.length;
  }

  // Update running summary stats from pages audited so far.
  // Use page.issueCount (always set) rather than counting p.issues (may be
  // nulled from RAM by savePageAndFreeMemory before this code runs).
  if (pages && pages.length > 0) {
    const completed = pages.filter(p => p.status === 'completed');
    const scores = completed.map(p => p.score).filter(s => s !== null);
    const totalIssueCount = completed.reduce((sum, p) => sum + (p.issueCount || 0), 0);
    // Severity counts: prefer real issue data when available, fall back to 0
    const allIssues = completed.flatMap(p => p.issues || []);
    document.getElementById('stat-pages').textContent = pages.length;
    document.getElementById('stat-issues').textContent = allIssues.length > 0 ? allIssues.length : totalIssueCount;
    document.getElementById('stat-critical').textContent = allIssues.filter(i => i.severity === 'critical').length;
    document.getElementById('stat-serious').textContent = allIssues.filter(i => i.severity === 'serious').length;
    document.getElementById('stat-moderate').textContent = allIssues.filter(i => i.severity === 'moderate').length;
    document.getElementById('stat-minor').textContent = allIssues.filter(i => i.severity === 'minor').length;
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    drawScoreGauge(document.getElementById('score-canvas'), avg);
  }
}

// Cancel button inside scanning results view
document.getElementById('results-cancel-btn').addEventListener('click', async () => {
  if (currentAuditId) {
    try { await fetch(`/api/audit/${currentAuditId}`, { method: 'DELETE' }); } catch {}
  }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  exitScanningMode();
  initLanding();
});

// Cancel button (progress view)
document.getElementById('cancel-btn').addEventListener('click', async () => {
  if (currentAuditId) {
    try { await fetch(`/api/audit/${currentAuditId}`, { method: 'DELETE' }); } catch {}
  }
  if (ws) { try { ws.close(); } catch {} ws = null; }
  initLanding();
});

// ===================== RESULTS VIEW =====================

function renderResults(session) {
  exitScanningMode(); // clears scanning banner and restores action buttons if needed
  showView('results');

  currentSession = session;
  selectedPageUrl = null;

  // Set URL
  document.getElementById('results-site-url').textContent = session.url;

  // Draw score gauge
  const canvas = document.getElementById('score-canvas');
  drawScoreGauge(canvas, session.summary?.averageScore ?? null);

  // Stats
  document.getElementById('stat-pages').textContent = session.summary?.totalPages ?? 0;
  document.getElementById('stat-issues').textContent = session.summary?.totalIssues ?? 0;
  document.getElementById('stat-critical').textContent = session.summary?.criticalIssues ?? 0;
  document.getElementById('stat-serious').textContent = session.summary?.seriousIssues ?? 0;
  document.getElementById('stat-moderate').textContent = session.summary?.moderateIssues ?? 0;
  document.getElementById('stat-minor').textContent = session.summary?.minorIssues ?? 0;

  // Render pages list
  renderPagesList(session.pages);
}

function renderPagesList(pages) {
  const list = document.getElementById('pages-list');
  const sorted = sortPages([...pages], currentSort);

  document.getElementById('page-count-badge').textContent = pages.length;

  list.innerHTML = sorted.map(page => {
    const cls = scoreClass(page.score);
    const isError = page.status === 'error';
    const isRescanning = page.status === 'rescanning';
    const isActive = page.url === selectedPageUrl;
    return `<div class="page-item ${isError || isRescanning ? 'error-item' : ''} ${isActive ? 'active' : ''}"
        data-url="${escapeHtml(page.url)}">
      <span class="page-score-pill ${cls}">
        ${isRescanning ? '…' : (page.score !== null && page.score !== undefined ? page.score : 'ERR')}
      </span>
      <span class="page-url-text" title="${escapeHtml(page.url)}">${escapeHtml(shortUrl(page.url))}</span>
      ${isRescanning
        ? `<span class="rescan-scanning-label">Scanning…</span>`
        : isError
          ? `<button class="rescan-btn" data-url="${escapeHtml(page.url)}" title="Re-audit this page">↺ Rescan</button>`
          : `<span class="page-issue-count">${page.issueCount} issues</span>`
      }
    </div>`;
  }).join('');

  list.querySelectorAll('.page-item:not(.error-item)').forEach(el => {
    el.addEventListener('click', () => {
      const page = pages.find(p => p.url === el.dataset.url);
      if (page) selectPage(page);
    });
  });

  list.querySelectorAll('.rescan-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      rescanSinglePage(btn.dataset.url);
    });
  });
}

function sortPages(pages, sortBy) {
  switch (sortBy) {
    case 'score-asc':
      return pages.sort((a, b) => {
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return a.score - b.score;
      });
    case 'score-desc':
      return pages.sort((a, b) => {
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return b.score - a.score;
      });
    case 'issues-desc':
      return pages.sort((a, b) => (b.issueCount ?? 0) - (a.issueCount ?? 0));
    case 'alpha':
      return pages.sort((a, b) => a.url.localeCompare(b.url));
    default:
      return pages;
  }
}

function selectPage(page) {
  selectedPageUrl = page.url;

  // Update active state in list
  document.querySelectorAll('.page-item').forEach(el => {
    el.classList.toggle('active', el.dataset.url === page.url);
  });

  // Show issue panel
  document.getElementById('issues-placeholder').style.display = 'none';
  const content = document.getElementById('issues-content');
  content.style.display = 'block';

  // Header
  document.getElementById('issue-page-url').textContent = page.url;
  const scoreWrap = document.getElementById('issue-page-score');
  const cls = scoreClass(page.score);
  scoreWrap.innerHTML = `<span class="page-score-pill ${cls}" style="font-size:18px;padding:4px 14px">
    ${page.score !== null ? page.score + '/100' : 'Error'}
  </span>`;

  // Render issues
  currentFilter = 'all';
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.filter-btn[data-severity="all"]').classList.add('active');

  // If we have issues in memory, render immediately.
  // If not but the page reports a non-zero issueCount, fetch from the API
  // (issues may have been stripped from RAM after DB save).
  if (page.issues && page.issues.length > 0) {
    renderIssues(page.issues);
  } else if (page.issueCount > 0 && currentAuditId) {
    renderIssues([]); // show empty temporarily
    fetch(`/api/audit/${currentAuditId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data || selectedPageUrl !== page.url) return;
        const dbPage = data.pages.find(p => p.url === page.url);
        if (dbPage && dbPage.issues && dbPage.issues.length > 0) {
          // Update in-memory cache so subsequent clicks don't re-fetch
          page.issues = dbPage.issues;
          if (currentSession) {
            const idx = currentSession.pages.findIndex(p => p.url === page.url);
            if (idx >= 0) currentSession.pages[idx].issues = dbPage.issues;
          }
          renderIssues(dbPage.issues);
        }
      })
      .catch(() => {});
  } else {
    renderIssues([]);
  }
}

async function rescanSinglePage(url) {
  if (!currentAuditId) return;
  try {
    const res = await fetch(`/api/audit/${currentAuditId}/rescan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`Rescan failed: ${data.error || 'Unknown error'}`);
    } else {
      // Reload the full session from the API so the page list and issues panel
      // reflect the updated results (the in-memory WS broadcast strips issues
      // from RAM, so we always need a fresh fetch from the DB after a rescan).
      await loadExistingAudit(currentAuditId);
    }
  } catch (err) {
    showToast(`Rescan error: ${err.message}`);
  }
}

function renderIssues(issues) {
  const list = document.getElementById('issues-list');
  const filtered = currentFilter === 'all'
    ? issues
    : issues.filter(i => i.severity === currentFilter);

  if (!issues.length) {
    list.innerHTML = `<div class="no-issues">
      <div class="check-icon">✅</div>
      <strong>No issues found!</strong>
      <p>This page passed all accessibility checks.</p>
    </div>`;
    return;
  }

  if (!filtered.length) {
    list.innerHTML = `<div class="no-issues">
      <p>No ${currentFilter} issues on this page.</p>
    </div>`;
    return;
  }

  list.innerHTML = filtered.map(issue => `
    <div class="issue-card">
      <div class="issue-card-header">
        <span class="sev-tag ${issue.severity}">${escapeHtml(issue.severity)}</span>
        <span class="issue-title">${escapeHtml(issue.title)}</span>
        <span class="wcag-tag">WCAG ${escapeHtml(issue.wcag)} (${escapeHtml(issue.wcagLevel)})</span>
        <button class="btn-fix-issue btn-sm" data-issue-id="${escapeHtml(issue.id)}" title="Fix this issue on WordPress">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Fix
        </button>
      </div>
      <div class="issue-card-body">
        ${issue.description ? `<p class="issue-desc">${escapeHtml(issue.description)}</p>` : ''}
        ${issue.elements && issue.elements.length > 0 ? `
          <div class="issue-count-label">
            ${issue.count} element${issue.count !== 1 ? 's' : ''} affected:
          </div>
          ${issue.elements.slice(0, 5).map(el => `
            <div class="element-snippet">
              <code>${escapeHtml(el.snippet || el.selector || '(no snippet)')}</code>
              ${el.explanation ? `<div class="element-explanation">${escapeHtml(el.explanation)}</div>` : ''}
            </div>
          `).join('')}
          ${issue.elements.length > 5 ? `<div class="more-elements">...and ${issue.elements.length - 5} more elements</div>` : ''}
        ` : ''}
      </div>
    </div>
  `).join('');

  // Attach Fix button handlers
  list.querySelectorAll('.btn-fix-issue').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const issueId = btn.dataset.issueId;
      const page = currentSession?.pages.find(p => p.url === selectedPageUrl);
      const issue = page?.issues?.find(i => i.id === issueId);
      if (issue && page) openFixModal(issue, page.url);
    });
  });
}

// Severity filter
document.getElementById('issue-filter-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  currentFilter = btn.dataset.severity;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  if (selectedPageUrl && currentSession) {
    const page = currentSession.pages.find(p => p.url === selectedPageUrl);
    if (page) renderIssues(page.issues || []);
  }
});

// Sort
document.getElementById('sort-select').addEventListener('change', (e) => {
  currentSort = e.target.value;
  if (currentSession) renderPagesList(currentSession.pages);
});

// New Audit button — navigate to root so state is fully reset
document.getElementById('new-audit-btn').addEventListener('click', () => {
  if (ws) { try { ws.close(); } catch {} }
  window.location.href = '/';
});

// Download HTML button
document.getElementById('download-report-btn').addEventListener('click', () => {
  if (!currentAuditId) return;
  window.open(`/api/audit/${currentAuditId}/report`, '_blank');
});

// Client Summary button — opens summary brand selection modal
document.getElementById('summary-report-btn').addEventListener('click', () => {
  if (!currentAuditId) return;
  openModal('summary-brand-modal');
});

// Summary brand modal: clicking a card opens the branded summary report
document.querySelectorAll('#summary-brand-modal .brand-option-card').forEach(card => {
  card.addEventListener('click', () => {
    const brand = card.dataset.brand;
    closeModal('summary-brand-modal');
    window.open(`/api/audit/${currentAuditId}/report/summary?brand=${encodeURIComponent(brand)}&autoprint=true`, '_blank');
  });
});

document.getElementById('summary-brand-modal-close').addEventListener('click', () => closeModal('summary-brand-modal'));

// VPAT Report button — opens brand selection modal
document.getElementById('vpat-report-btn').addEventListener('click', () => {
  if (!currentAuditId) return;
  openModal('vpat-brand-modal');
});

document.querySelectorAll('#vpat-brand-modal .brand-option-card').forEach(card => {
  card.addEventListener('click', () => {
    const brand = card.dataset.brand;
    closeModal('vpat-brand-modal');
    window.open(`/api/audit/${currentAuditId}/report/vpat?brand=${encodeURIComponent(brand)}`, '_blank');
  });
});

document.getElementById('vpat-brand-modal-close').addEventListener('click', () => closeModal('vpat-brand-modal'));

// Detail PDF button — opens brand selection modal
document.getElementById('print-report-btn').addEventListener('click', () => {
  if (!currentAuditId) return;
  openModal('brand-modal');
});

// Brand modal: clicking a card immediately opens the branded printable report
document.querySelectorAll('#brand-modal .brand-option-card').forEach(card => {
  card.addEventListener('click', () => {
    const brand = card.dataset.brand;
    closeModal('brand-modal');
    window.open(`/api/audit/${currentAuditId}/report?brand=${encodeURIComponent(brand)}&autoprint=true`, '_blank');
  });
});

document.getElementById('brand-modal-close').addEventListener('click', () => closeModal('brand-modal'));

// Email Report button — opens email modal
document.getElementById('email-report-btn').addEventListener('click', () => {
  if (!currentAuditId) return;
  document.getElementById('email-addresses').value = '';
  // Pre-select Planeteria
  document.querySelectorAll('#email-modal .brand-option-card').forEach((c, i) => {
    c.classList.toggle('selected', i === 0);
  });
  openModal('email-modal');
});

document.getElementById('email-modal-close').addEventListener('click', () => closeModal('email-modal'));
document.getElementById('email-cancel-btn').addEventListener('click', () => closeModal('email-modal'));

// Brand selection inside email modal
document.querySelectorAll('#email-modal .brand-option-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('#email-modal .brand-option-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
  });
});

// Send email
document.getElementById('email-send-btn').addEventListener('click', async () => {
  const rawInput = document.getElementById('email-addresses').value.trim();
  if (!rawInput) {
    alert('Please enter at least one email address.');
    return;
  }
  const emails = rawInput.split(',').map(e => e.trim()).filter(Boolean);
  const selectedCard = document.querySelector('#email-modal .brand-option-card.selected');
  const brand = selectedCard?.dataset.brand || 'planeteria';

  const btn = document.getElementById('email-send-btn');
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Generating PDF & Sending…';

  try {
    const res = await fetch(`/api/audit/${currentAuditId}/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails, brand }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to send email');
    closeModal('email-modal');
    showToast(`Report sent to ${emails.length} recipient${emails.length !== 1 ? 's' : ''}`);
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
});

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// Close modals on Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    ['brand-modal', 'vpat-brand-modal', 'summary-brand-modal', 'email-modal', 'fix-modal'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') closeModal(id);
    });
  }
});

// ===================== FIX MODAL =====================

const WP_CREDS_PREFIX = 'wp_creds_';

function loadWpCreds(hostname) {
  try { return JSON.parse(localStorage.getItem(WP_CREDS_PREFIX + hostname) || 'null'); } catch { return null; }
}

function saveWpCreds(hostname, username, password) {
  localStorage.setItem(WP_CREDS_PREFIX + hostname, JSON.stringify({ username, password }));
}

// The issue and page URL currently loaded in the Fix modal
let fixModalIssue = null;
let fixModalPageUrl = null;

function openFixModal(issue, pageUrl) {
  fixModalIssue = issue;
  fixModalPageUrl = pageUrl;

  // Issue summary
  document.getElementById('fix-modal-title').textContent = 'Fix Issue';
  document.getElementById('fix-issue-summary').innerHTML = `
    <div class="fix-issue-label">
      <span class="sev-tag ${escapeHtml(issue.severity)}" style="font-size:11px">${escapeHtml(issue.severity)}</span>
      <strong>${escapeHtml(issue.title)}</strong>
      <span class="wcag-tag" style="font-size:11px">WCAG ${escapeHtml(issue.wcag)}</span>
    </div>`;

  // Live site label
  try {
    document.getElementById('fix-live-url-display').textContent = new URL(pageUrl).origin;
  } catch {}

  // Reset to live site
  document.getElementById('fix-target-live').checked = true;
  document.getElementById('fix-dev-url-wrap').style.display = 'none';
  document.getElementById('fix-dev-url').value = '';

  // Pre-fill credentials from localStorage
  const hostname = new URL(pageUrl).hostname;
  const saved = loadWpCreds(hostname);
  document.getElementById('fix-wp-username').value = saved?.username || '';
  document.getElementById('fix-wp-password').value = saved?.password || '';
  document.getElementById('fix-save-creds-text').textContent = `Save credentials for ${hostname}`;
  document.getElementById('fix-save-creds').checked = true;

  // Reset result panel
  const result = document.getElementById('fix-result');
  result.style.display = 'none';
  result.innerHTML = '';

  // Reset apply button
  const btn = document.getElementById('fix-apply-btn');
  btn.disabled = false;
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Apply Fix`;

  openModal('fix-modal');
}

// Toggle dev URL input
document.querySelectorAll('input[name="fix-target"]').forEach(radio => {
  radio.addEventListener('change', () => {
    document.getElementById('fix-dev-url-wrap').style.display =
      document.getElementById('fix-target-dev').checked ? 'block' : 'none';
  });
});

document.getElementById('fix-modal-close').addEventListener('click', () => closeModal('fix-modal'));
document.getElementById('fix-cancel-btn').addEventListener('click', () => closeModal('fix-modal'));

document.getElementById('fix-apply-btn').addEventListener('click', async () => {
  if (!fixModalIssue || !fixModalPageUrl || !currentAuditId) return;

  const targetType = document.getElementById('fix-target-dev').checked ? 'dev' : 'live';
  const devUrl = document.getElementById('fix-dev-url').value.trim();
  const username = document.getElementById('fix-wp-username').value.trim();
  const password = document.getElementById('fix-wp-password').value.trim();

  if (!username || !password) {
    alert('Please enter WordPress username and application password.');
    return;
  }

  if (targetType === 'dev' && !devUrl) {
    alert('Please enter the dev site URL.');
    return;
  }

  // Save credentials if checkbox is checked
  if (document.getElementById('fix-save-creds').checked) {
    const hostname = new URL(fixModalPageUrl).hostname;
    saveWpCreds(hostname, username, password);
  }

  const btn = document.getElementById('fix-apply-btn');
  btn.disabled = true;
  btn.innerHTML = `<span class="mini-spinner" style="display:inline-block;margin-right:6px"></span> Applying…`;

  const resultEl = document.getElementById('fix-result');
  resultEl.style.display = 'none';
  resultEl.innerHTML = '';

  try {
    const res = await fetch(`/api/audit/${currentAuditId}/fix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pageUrl: fixModalPageUrl,
        issue: fixModalIssue,
        targetType,
        devUrl: devUrl || null,
        username,
        password,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Fix request failed');

    if (data.type === 'fixed') {
      resultEl.innerHTML = `
        <div class="fix-result-success">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          <div>
            <strong>Fix applied successfully</strong>
            <div style="font-size:13px;color:#475569;margin-top:2px">${escapeHtml(data.summary)}</div>
          </div>
        </div>`;
      showToast('Fix applied to WordPress site');
    } else {
      // Code suggestion
      const codeHtml = data.code
        ? `<div class="fix-code-wrap">
            <div class="fix-code-header">
              Code to apply
              <button class="fix-copy-btn" onclick="navigator.clipboard.writeText(${JSON.stringify(data.code)}).then(()=>{this.textContent='Copied!';setTimeout(()=>{this.textContent='Copy'},2000)})">Copy</button>
            </div>
            <pre class="fix-code-block"><code>${escapeHtml(data.code)}</code></pre>
           </div>`
        : '';
      resultEl.innerHTML = `
        <div class="fix-result-suggestion">
          <div class="fix-suggestion-reason">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            ${escapeHtml(data.reason)}
          </div>
          ${codeHtml}
        </div>`;
    }

    resultEl.style.display = 'block';
  } catch (err) {
    resultEl.innerHTML = `<div class="fix-result-error">Error: ${escapeHtml(err.message)}</div>`;
    resultEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Apply Fix`;
  }
});

// ===================== MODAL UTILITIES =====================

function openModal(id) {
  document.getElementById(id).style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).style.display = 'none';
  document.body.style.overflow = '';
}

function showToast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast-notification toast-${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ===================== TOPBAR BRAND =====================

const PLANETERIA_LOGO_SM = `<img src="https://www.planeteria.com/wp-content/uploads/2024/11/logo-1.svg" alt="Planeteria Logo" class="logo-img">`;

function renderTopbarBrand(el) {
  if (!el) return;
  el.innerHTML = `${PLANETERIA_LOGO_SM}
    <span class="brand-divider"></span>
    <span class="brand-tool">Inquiros ADA Checker</span>`;
}

// ===================== INIT =====================

// Inject brand into progress topbar on load
renderTopbarBrand(document.getElementById('progress-brand'));

// Deep-link: if URL has ?auditId= load that audit directly
const _initAuditId = new URLSearchParams(window.location.search).get('auditId');
if (_initAuditId) {
  loadExistingAudit(_initAuditId);
} else {
  initLanding();
}
