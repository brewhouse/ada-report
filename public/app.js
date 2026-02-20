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

// ===================== TOPBAR BRAND =====================

const PLANETERIA_LOGO_SM = `<svg xmlns="http://www.w3.org/2000/svg" width="110" height="16" viewBox="0 0 214 32" fill="none" aria-label="Planeteria Media">
  <g clip-path="url(#clip_tb)">
    <path d="M6.63207 6.89503L9.4547 8.48009L21.6414 15.308V8.57153L6.46747 0L0.572266 3.49934L0.578362 3.50543L6.63207 6.89503Z" fill="url(#pg0_tb)"/>
    <path d="M15.6975 11.9854L8.85742 15.881V22.2212L21.6355 15.308H21.6415L9.45487 8.47998L15.6975 11.9854Z" fill="url(#pg1_tb)"/>
    <path d="M6.62988 6.89497L0.576172 3.50537V31.9999L6.62988 28.842V6.89497Z" fill="url(#pg2_tb)"/>
    <path d="M44.86 14.16C44.86 14.72 44.76 15.19 44.55 15.57C44.35 15.95 44.07 16.26 43.72 16.49C43.37 16.72 42.96 16.89 42.51 17C42.05 17.11 41.57 17.17 41.08 17.17H39.94V20.76H37.64V11.23H41.14C41.66 11.23 42.15 11.28 42.6 11.39C43.06 11.49 43.44 11.66 43.78 11.89C44.12 12.12 44.39 12.41 44.58 12.79C44.76 13.16 44.86 13.62 44.86 14.16ZM42.56 14.18C42.56 13.95 42.52 13.77 42.43 13.62C42.34 13.47 42.22 13.37 42.06 13.28C41.91 13.2 41.74 13.15 41.54 13.12C41.35 13.09 41.15 13.08 40.94 13.08H39.93V15.32H40.9C41.12 15.32 41.33 15.3 41.52 15.27C41.72 15.24 41.9 15.17 42.05 15.08C42.21 14.99 42.34 14.87 42.43 14.72C42.51 14.58 42.56 14.4 42.56 14.18Z" fill="#074F8B"/>
    <path d="M61.02 11.23V20.76H58.72V11.23H61.02Z" fill="#074F8B"/>
    <path d="M71.36 18.88V20.76H63.89V11.23H71.24V13.11H66.2V14.99H70.72V16.77H66.2V18.88H71.36Z" fill="#074F8B"/>
    <path d="M82.28 20.76H80.32L75.71 14.63V20.76H73.51V11.23H75.64L80.1 17.22V11.23H82.28V20.76Z" fill="#074F8B"/>
    <path d="M89.43 13.11H86.64V20.76H84.34V13.11H81.54V11.23H89.43V13.11Z" fill="#074F8B"/>
    <path d="M109.69 18.88V20.76H102.22V11.23H109.57V13.11H104.52V14.99H109.05V16.77H104.52V18.88H109.69Z" fill="#074F8B"/>
    <path d="M135.89 11.23V20.76H133.59V11.23H135.89Z" fill="#074F8B"/>
    <path d="M172.83 20.76H165.36V11.23H172.71V13.11H167.67V14.99H172.19V16.77H167.67V18.88H172.83V20.76Z" fill="#074F8B"/>
    <path d="M184.08 20.76H182.12L177.52 14.63V20.76H175.32V11.23H177.44L181.91 17.22V11.23H184.08V20.76Z" fill="#074F8B"/>
    <path d="M213.71 20.76H211.28L208.76 16.72L206.21 20.76H203.86L207.66 15.7L204.04 11.23H206.46L208.8 14.92L211.12 11.23H213.47L209.86 15.69L213.71 20.76Z" fill="#074F8B"/>
  </g>
  <defs>
    <linearGradient id="pg0_tb" x1="3.34" y1="1.08" x2="25.05" y2="14.94" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#63CAE2"/><stop offset="1" stop-color="#107DC2"/>
    </linearGradient>
    <linearGradient id="pg1_tb" x1="7.39" y1="16.28" x2="16.24" y2="11.61" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#63CAE2"/><stop offset="1" stop-color="#107DC2"/>
    </linearGradient>
    <linearGradient id="pg2_tb" x1="2.84" y1="29.79" x2="4.25" y2="4.59" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#63CAE2"/><stop offset="1" stop-color="#107DC2"/>
    </linearGradient>
    <clipPath id="clip_tb"><rect width="213.714" height="32" fill="white"/></clipPath>
  </defs>
</svg>`;

function renderTopbarBrand(el) {
  if (!el) return;
  el.innerHTML = `${PLANETERIA_LOGO_SM}
    <span class="brand-divider"></span>
    <span class="brand-tool">Inquiros ADA Checker</span>`;
}

// ===================== INIT =====================

// Inject brand into progress topbar on load
renderTopbarBrand(document.getElementById('progress-brand'));

initLanding();
