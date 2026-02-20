// ===================== UTILITIES =====================

function scoreClass(score) {
  if (score === null || score === undefined) return '';
  if (score >= 90) return 'score-green';
  if (score >= 70) return 'score-lime';
  if (score >= 50) return 'score-amber';
  return 'score-red';
}

function scoreColorHex(score) {
  if (score === null || score === undefined) return '#94a3b8';
  if (score >= 90) return '#16a34a';
  if (score >= 70) return '#65a30d';
  if (score >= 50) return '#d97706';
  return '#dc2626';
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

// ===================== VIEW MANAGEMENT =====================

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
}

// ===================== LANDING =====================

function initLanding() {
  renderRecentAudits();
  showView('landing');
}

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

    if (session.status === 'completed') {
      renderResults(session);
    } else if (session.status === 'crawling' || session.status === 'auditing' || session.status === 'queued') {
      showProgress(session);
      connectWebSocket(auditId);
    } else {
      alert(`Audit ended with status: ${session.status}. ${session.error || ''}`);
    }
  } catch {
    alert('Could not load audit. It may have expired.');
  }
}

// ===================== START AUDIT =====================

document.getElementById('audit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('url-input').value.trim();
  const maxPages = parseInt(document.getElementById('max-pages-input').value);

  const btn = document.getElementById('start-btn');
  btn.disabled = true;
  btn.textContent = 'Starting...';

  try {
    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, maxPages }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start audit');

    currentAuditId = data.auditId;
    currentSession = data.session;

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

// ===================== WEBSOCKET =====================

function connectWebSocket(auditId) {
  if (ws) { try { ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/?auditId=${auditId}`);

  ws.onmessage = (event) => {
    const { data } = JSON.parse(event.data);
    if (!data) return;
    currentSession = data;

    if (data.status === 'completed') {
      saveRecentAudit(auditId, data.url, data.summary?.averageScore ?? null, 'completed');
      renderResults(data);
    } else if (data.status === 'error') {
      saveRecentAudit(auditId, data.url, null, 'error');
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

  // Phase label
  let phaseText = 'Waiting in queue...';
  if (status === 'crawling') phaseText = 'Discovering pages...';
  else if (status === 'auditing') phaseText = 'Auditing pages...';
  document.getElementById('progress-phase-label').textContent = phaseText;

  // Current page
  if (currentPage) {
    document.getElementById('progress-current-url').textContent = `Scanning: ${currentPage}`;
  }

  // Progress bar
  if (progress && progress.total > 0) {
    const pct = Math.round((progress.audited / progress.total) * 100);
    document.getElementById('progress-bar-fill').style.width = `${pct}%`;
    document.getElementById('progress-counts').textContent =
      `${progress.audited} / ${progress.total} pages audited`;
  }

  // Page list (show completed pages)
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
    // Scroll to bottom
    listEl.scrollTop = listEl.scrollHeight;
  }
}

// Cancel button
document.getElementById('cancel-btn').addEventListener('click', () => {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  initLanding();
});

// ===================== RESULTS VIEW =====================

function renderResults(session) {
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
    const isActive = page.url === selectedPageUrl;
    return `<div class="page-item ${isError ? 'error-item' : ''} ${isActive ? 'active' : ''}"
        data-url="${escapeHtml(page.url)}">
      <span class="page-score-pill ${cls}">
        ${page.score !== null && page.score !== undefined ? page.score : 'ERR'}
      </span>
      <span class="page-url-text" title="${escapeHtml(page.url)}">${escapeHtml(shortUrl(page.url))}</span>
      ${!isError ? `<span class="page-issue-count">${page.issueCount} issues</span>` : ''}
    </div>`;
  }).join('');

  list.querySelectorAll('.page-item:not(.error-item)').forEach(el => {
    el.addEventListener('click', () => {
      const page = pages.find(p => p.url === el.dataset.url);
      if (page) selectPage(page);
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
  renderIssues(page.issues || []);
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

// New Audit button
document.getElementById('new-audit-btn').addEventListener('click', () => {
  if (ws) { try { ws.close(); } catch {} ws = null; }
  currentAuditId = null;
  currentSession = null;
  selectedPageUrl = null;
  initLanding();
});

// Download Report button
document.getElementById('download-report-btn').addEventListener('click', () => {
  if (!currentAuditId) return;
  window.open(`/api/audit/${currentAuditId}/report`, '_blank');
});

// ===================== INIT =====================

initLanding();
