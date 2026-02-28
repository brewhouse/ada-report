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
    let body;
    if (auditMode === 'url-list') {
      const urlList = parseUrlList();
      if (urlList.length === 0) throw new Error('Please enter at least one valid URL (must start with http:// or https://).');
      body = { urlList };
    } else {
      const url = document.getElementById('url-input').value.trim();
      if (!url) throw new Error('Please enter a website URL.');
      const maxPages = parseInt(document.getElementById('max-pages-input').value);
      body = { url, maxPages };
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
  renderIssues(page.issues || []);
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
    }
    // UI updates automatically via WebSocket broadcast from the server
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
    ['brand-modal', 'email-modal', 'fix-modal'].forEach(id => {
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

initLanding();
