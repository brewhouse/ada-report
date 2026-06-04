(function () {
  'use strict';

  // ── Auth ──────────────────────────────────────────────────────────────────────

  const TOKEN_KEY = 'campaign_token';
  let token = localStorage.getItem(TOKEN_KEY) || '';

  function authHeaders() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
  }

  async function api(method, path, body) {
    const opts = { method, headers: authHeaders() };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const r = await fetch(path, opts);
    if (r.status === 401) { signOut(); return null; }
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error || `Server error ${r.status}`);
    return data;
  }

  function signOut() {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    showView('login');
  }

  // ── State ─────────────────────────────────────────────────────────────────────

  let allItems   = [];
  let total      = 0;
  let offset     = 0;
  const PAGE_SIZE = 50;
  let sortField  = 'sentAt';
  let sortDir    = 'desc';
  let filterSearch  = '';
  let filterStatus  = '';
  let filterClient  = '';
  let clientOptions = {}; // id -> name

  // ── View helpers ──────────────────────────────────────────────────────────────

  function showView(v) {
    document.getElementById('el-login').style.display     = v === 'login'     ? '' : 'none';
    document.getElementById('el-dashboard').style.display = v === 'dashboard' ? '' : 'none';
  }

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
         + ' ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  }

  function fmtDateShort(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return d.toLocaleDateString('en-US', { month:'short', day:'numeric' })
         + ' ' + d.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  }

  function statusBadge(status) {
    const label = status || 'sent';
    const map = {
      sent:        'Sent',
      delivered:   'Delivered',
      opened:      'Opened',
      clicked:     'Clicked',
      bounce:      'Bounced',
      blocked:     'Blocked',
      spamreport:  'Spam',
      failed:      'Failed',
    };
    const cls = ['bounce','blocked','spamreport','failed'].includes(label) ? 'bounce' : label;
    return `<span class="el-status ${escHtml(cls)}">${escHtml(map[label] || label)}</span>`;
  }

  function tsCell(iso) {
    const val = fmtDateShort(iso);
    return `<span class="el-ts ${val ? 'has-value' : ''}">${escHtml(val || '—')}</span>`;
  }

  // ── Toast ─────────────────────────────────────────────────────────────────────

  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = 'sch-toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── Load data ─────────────────────────────────────────────────────────────────

  async function loadLog(resetOffset = false) {
    if (resetOffset) offset = 0;
    const params = new URLSearchParams({
      limit:  PAGE_SIZE,
      offset: offset,
    });
    if (filterSearch)  params.set('search',   filterSearch);
    if (filterStatus)  params.set('status',   filterStatus);
    if (filterClient)  params.set('clientId', filterClient);

    let data;
    try {
      data = await api('GET', '/api/campaign/email-log?' + params.toString());
    } catch (err) {
      const tbody = document.getElementById('el-tbody');
      tbody.innerHTML = `<tr><td colspan="10" class="el-empty" style="color:red">Error loading logs: ${escHtml(err.message)}</td></tr>`;
      return;
    }
    if (!data) return;
    total    = data.total || 0;
    allItems = data.items || [];

    updateStats(allItems);
    renderTable();
    renderPager();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────

  async function loadStats() {
    // Fetch unfiltered totals for the stat cards
    const data = await api('GET', `/api/campaign/email-log?limit=1&offset=0`);
    if (!data) return;
    const grandTotal = data.total || 0;
    document.getElementById('stat-total').textContent = grandTotal;

    // Fetch per-status counts
    const statuses = ['delivered','opened','clicked'];
    for (const s of statuses) {
      const d = await api('GET', `/api/campaign/email-log?limit=1&offset=0&status=${s}`);
      if (d) document.getElementById('stat-' + s).textContent = d.total ?? '—';
    }
    // Bounced = bounce + blocked + spamreport combined (fetch bounce as representative)
    const bounceData = await api('GET', '/api/campaign/email-log?limit=1&offset=0&status=bounce');
    const blockedData = await api('GET', '/api/campaign/email-log?limit=1&offset=0&status=blocked');
    const spamData    = await api('GET', '/api/campaign/email-log?limit=1&offset=0&status=spamreport');
    const bounceTotal = (bounceData?.total || 0) + (blockedData?.total || 0) + (spamData?.total || 0);
    document.getElementById('stat-bounced').textContent = bounceTotal;
  }

  function updateStats(items) {
    // Update stat cards based on the full unfiltered total which is loaded separately
    // (stats already updated in loadStats — this just avoids an extra full-table scan)
  }

  // ── Populate client filter ────────────────────────────────────────────────────

  async function loadClientFilter() {
    // Use a large limit to get all clients for filter dropdown
    const data = await api('GET', '/api/campaign/email-log?limit=200&offset=0');
    if (!data) return;
    const seen = {};
    for (const item of data.items) {
      if (item.clientId && item.clientName && !seen[item.clientId]) {
        seen[item.clientId] = item.clientName;
      }
    }
    clientOptions = seen;
    const sel = document.getElementById('el-client-filter');
    for (const [id, name] of Object.entries(seen)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = name;
      sel.appendChild(opt);
    }
  }

  // ── Render table ──────────────────────────────────────────────────────────────

  function sortItems(items) {
    return [...items].sort((a, b) => {
      let av = a[sortField], bv = b[sortField];
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }

  function renderTable() {
    const tbody = document.getElementById('el-tbody');
    if (!allItems.length) {
      tbody.innerHTML = `<tr><td colspan="10" class="el-empty">No emails found.</td></tr>`;
      return;
    }

    const sorted = sortItems(allItems);
    tbody.innerHTML = sorted.map(item => {
      const hasSg = !!item.sgMessageId;
      const recipName = item.recipientName
        ? `<div class="el-recipient-name">${escHtml(item.recipientName)}</div>` : '';
      return `
        <tr>
          <td><span class="el-ts has-value">${escHtml(fmtDate(item.sentAt))}</span></td>
          <td>
            <div class="el-client-name">${escHtml(item.clientName || '—')}</div>
            <div class="el-client-tmpl">${escHtml(item.templateName || '')}</div>
          </td>
          <td>
            <div class="el-recipient">${escHtml(item.recipientEmail)}</div>
            ${recipName}
          </td>
          <td style="font-size:12px;color:var(--gray-600)">${escHtml(item.fromEmail || '—')}</td>
          <td><div class="el-subject" title="${escHtml(item.subject || '')}">${escHtml(item.subject || '—')}</div></td>
          <td>${statusBadge(item.status)}</td>
          <td>${tsCell(item.deliveredAt)}</td>
          <td>${tsCell(item.openedAt)}</td>
          <td>${tsCell(item.clickedAt)}</td>
          <td>
            ${hasSg ? `<button class="el-refresh-btn" data-id="${escHtml(item.id)}" title="Refresh status from SendGrid">↻ Refresh</button>` : ''}
          </td>
        </tr>`;
    }).join('');

    // Bind refresh buttons
    tbody.querySelectorAll('.el-refresh-btn').forEach(btn => {
      btn.addEventListener('click', () => refreshEntry(btn.dataset.id, btn));
    });

    // Highlight sorted column
    document.querySelectorAll('.el-table th[data-sort]').forEach(th => {
      const s = th.dataset.sort;
      const arrow = th.querySelector('.sort-arrow');
      if (s === sortField) {
        th.classList.add('sorted');
        if (arrow) arrow.textContent = sortDir === 'asc' ? '↑' : '↓';
      } else {
        th.classList.remove('sorted');
        if (arrow) arrow.textContent = '↕';
      }
    });
  }

  // ── Pagination ────────────────────────────────────────────────────────────────

  function renderPager() {
    const pager = document.getElementById('el-pager');
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

    if (totalPages <= 1) { pager.innerHTML = ''; return; }

    const start = offset + 1;
    const end   = Math.min(offset + PAGE_SIZE, total);

    let html = `<span class="el-page-info">${start}–${end} of ${total}</span>`;
    html += `<button class="el-page-btn" id="pg-prev" ${currentPage === 1 ? 'disabled' : ''}>← Prev</button>`;

    // Show up to 7 page buttons
    const maxButtons = 7;
    let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
    let endPage   = Math.min(totalPages, startPage + maxButtons - 1);
    if (endPage - startPage < maxButtons - 1) startPage = Math.max(1, endPage - maxButtons + 1);

    for (let p = startPage; p <= endPage; p++) {
      html += `<button class="el-page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }

    html += `<button class="el-page-btn" id="pg-next" ${currentPage === totalPages ? 'disabled' : ''}>Next →</button>`;
    pager.innerHTML = html;

    document.getElementById('pg-prev')?.addEventListener('click', () => { offset = Math.max(0, offset - PAGE_SIZE); loadLog(); });
    document.getElementById('pg-next')?.addEventListener('click', () => { offset = Math.min((totalPages - 1) * PAGE_SIZE, offset + PAGE_SIZE); loadLog(); });
    pager.querySelectorAll('[data-page]').forEach(btn => {
      btn.addEventListener('click', () => { offset = (parseInt(btn.dataset.page) - 1) * PAGE_SIZE; loadLog(); });
    });
  }

  // ── Refresh single entry ──────────────────────────────────────────────────────

  async function refreshEntry(id, btn) {
    btn.disabled = true;
    btn.textContent = '…';
    const data = await api('POST', `/api/campaign/email-log/${encodeURIComponent(id)}/refresh`);
    btn.disabled = false;
    btn.textContent = '↻ Refresh';
    if (!data) return;
    if (data.error) { toast(data.error, 'error'); return; }
    if (data.refreshed) {
      toast(`Status updated: ${data.status}`);
      loadLog();
      loadStats();
    } else {
      toast(data.message || 'No update', 'warn');
    }
  }

  // ── Refresh all — sync pending rows from SendGrid then reload ────────────────

  async function refreshAll() {
    const btn = document.getElementById('el-refresh-all-btn');
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      const data = await api('POST', '/api/campaign/email-log/sync-pending');
      if (data) toast(`Synced ${data.synced} rows, updated ${data.updated}`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Refresh All';
    }
    await loadLog();
    await loadStats();
  }

  // ── Login ─────────────────────────────────────────────────────────────────────

  async function doLogin(username, password) {
    try {
      const r = await fetch('/api/campaign/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json();
      if (!r.ok || !data.token) throw new Error(data.error || 'Login failed');
      token = data.token;
      localStorage.setItem(TOKEN_KEY, token);
      return true;
    } catch (err) {
      document.getElementById('login-error').textContent = err.message;
      return false;
    }
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────

  async function boot() {
    if (token) {
      showView('dashboard');
      await loadClientFilter();
      await loadStats();
      await loadLog();
    } else {
      showView('login');
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────────

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const u = document.getElementById('login-user').value.trim();
    const p = document.getElementById('login-pass').value;
    if (await doLogin(u, p)) {
      showView('dashboard');
      await loadClientFilter();
      await loadStats();
      await loadLog();
    }
  });

  document.getElementById('el-logout-btn').addEventListener('click', signOut);
  document.getElementById('el-refresh-all-btn').addEventListener('click', refreshAll);

  // Debounced search
  let searchTimer;
  document.getElementById('el-search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      filterSearch = e.target.value.trim();
      loadLog(true);
    }, 350);
  });

  document.getElementById('el-status-filter').addEventListener('change', e => {
    filterStatus = e.target.value;
    loadLog(true);
  });

  document.getElementById('el-client-filter').addEventListener('change', e => {
    filterClient = e.target.value;
    loadLog(true);
  });

  document.getElementById('el-clear-btn').addEventListener('click', () => {
    filterSearch = ''; filterStatus = ''; filterClient = '';
    document.getElementById('el-search').value = '';
    document.getElementById('el-status-filter').value = '';
    document.getElementById('el-client-filter').value = '';
    loadLog(true);
  });

  // Column sort
  document.querySelectorAll('.el-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (sortField === field) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortField = field;
        sortDir   = 'desc';
      }
      renderTable();
    });
  });

  boot();
})();
