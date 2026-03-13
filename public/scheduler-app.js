// ===================== AUTH =====================

const TOKEN_KEY = 'sch_token';

function getToken() { return sessionStorage.getItem(TOKEN_KEY); }
function setToken(t) { sessionStorage.setItem(TOKEN_KEY, t); }
function clearToken()  { sessionStorage.removeItem(TOKEN_KEY); }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` };
}

// ===================== INIT =====================

async function init() {
  if (!getToken()) {
    showLogin();
    return;
  }
  // Verify token is still valid
  try {
    const res = await fetch('/api/scheduler/schedules', { headers: authHeaders() });
    if (res.status === 401) { clearToken(); showLogin(); return; }
    const data = await res.json();
    showDashboard(data);
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('sch-login').style.display = '';
  document.getElementById('sch-dashboard').style.display = 'none';
}

function showDashboard(schedules) {
  document.getElementById('sch-login').style.display = 'none';
  document.getElementById('sch-dashboard').style.display = '';
  renderTable(schedules);
  loadQueue();
  if (queuePollInterval) clearInterval(queuePollInterval);
  queuePollInterval = setInterval(loadQueue, 5000);
}

// ===================== LOGIN =====================

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  if (!username || !password) { errEl.textContent = 'Please enter username and password.'; return; }

  try {
    const res = await fetch('/api/scheduler/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Invalid credentials.'; return; }
    setToken(data.token);
    showDashboard(data.schedules);
  } catch {
    errEl.textContent = 'Network error. Please try again.';
  }
});

// ===================== LOGOUT =====================

document.getElementById('sch-logout-btn').addEventListener('click', () => {
  clearToken();
  showLogin();
});

// ===================== EXPORT / IMPORT =====================

document.getElementById('sch-export-btn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/scheduler/schedules/export', { headers: authHeaders() });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `schedules-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(`Export failed: ${err.message}`, true);
  }
});

document.getElementById('sch-import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await fetch('/api/scheduler/schedules/import', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Import failed');
    showToast(`Imported ${result.imported} new, updated ${result.updated}${result.skipped ? `, skipped ${result.skipped} invalid` : ''}`);
    await reloadTable();
  } catch (err) {
    showToast(`Import failed: ${err.message}`, true);
  } finally {
    e.target.value = ''; // reset so the same file can be re-selected
  }
});

// ===================== TABLE RENDER =====================

function escHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(iso) {
  if (!iso) return '—';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
}

function renderTable(schedules) {
  const tbody = document.getElementById('sch-table-body');

  if (!schedules.length) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="sch-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>
        </svg>
        No scheduled audits yet. Click <strong>Add Schedule</strong> to create one.
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = schedules.map(s => {
    const statusBadge = s.lastRunStatus === 'success'
      ? `<span class="run-badge success">✓ Success <span style="font-weight:400;opacity:.8">${timeAgo(s.lastRun)}</span></span>`
      : s.lastRunStatus === 'error'
        ? `<span class="run-badge error" title="${escHtml(s.lastRunError)}">✕ Error <span style="font-weight:400;opacity:.8">${timeAgo(s.lastRun)}</span></span>`
        : `<span class="run-badge never">Never run</span>`;

    return `<tr data-id="${escHtml(s.id)}">
      <td class="sch-name-cell">
        <strong>${escHtml(s.name || new URL(s.url).hostname)}</strong>
        <span>${escHtml(s.url)}</span>
      </td>
      <td>${escHtml(s.description || '')}</td>
      <td style="font-size:12px;color:var(--gray-600)">${escHtml((s.emails || []).join(', '))}</td>
      <td>${statusBadge}</td>
      <td>
        <label class="toggle-switch" title="${s.enabled ? 'Disable' : 'Enable'}">
          <input type="checkbox" class="toggle-enabled" data-id="${escHtml(s.id)}" ${s.enabled ? 'checked' : ''}>
          <span class="toggle-track"></span>
          <span class="toggle-thumb"></span>
        </label>
      </td>
      <td>
        <div class="sch-actions">
          <button class="sch-act-btn run-now" data-action="run" data-id="${escHtml(s.id)}" title="Run audit now">▶ Run Now</button>
          <button class="sch-act-btn" data-action="edit" data-id="${escHtml(s.id)}">Edit</button>
          <button class="sch-act-btn danger" data-action="delete" data-id="${escHtml(s.id)}" data-name="${escHtml(s.name || s.url)}">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  // Enable/disable toggles
  tbody.querySelectorAll('.toggle-enabled').forEach(cb => {
    cb.addEventListener('change', () => toggleEnabled(cb.dataset.id, cb.checked));
  });

  // Action buttons
  tbody.querySelectorAll('.sch-act-btn[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { action, id, name } = btn.dataset;
      if (action === 'edit')   openEditModal(id);
      if (action === 'delete') openDeleteModal(id, name);
      if (action === 'run')    runNow(id, btn);
    });
  });
}

async function reloadTable() {
  try {
    const res = await fetch('/api/scheduler/schedules', { headers: authHeaders() });
    if (res.status === 401) { clearToken(); showLogin(); return; }
    renderTable(await res.json());
  } catch (err) {
    showToast('Failed to reload schedules', true);
  }
}

// ===================== TOGGLE ENABLED =====================

async function toggleEnabled(id, enabled) {
  try {
    const res = await fetch(`/api/scheduler/schedules/${id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast(enabled ? 'Schedule enabled' : 'Schedule disabled');
    await reloadTable();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
    await reloadTable(); // revert toggle visually
  }
}

// ===================== RUN NOW =====================

async function runNow(id, btn) {
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    const res = await fetch(`/api/scheduler/schedules/${id}/run`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast('Audit started — report will be emailed when complete');
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// ===================== FORM STATE =====================

let editingId = null;
let selectedFreq   = 'daily';
let selectedDow    = 1;
let selectedBrand  = 'planeteria';

function resetForm() {
  editingId = null;
  document.getElementById('sch-modal-title').textContent = 'Add Schedule';
  document.getElementById('f-name').value = '';
  document.getElementById('f-url').value = '';
  document.getElementById('f-maxpages').value = '50';
  document.getElementById('f-exclude').value = '';
  document.getElementById('f-emails').value = '';
  document.getElementById('f-dev-emails').value = '';
  document.getElementById('f-hour').value = '8';
  document.getElementById('f-minute').value = '0';
  document.getElementById('f-dom').value = '1';
  document.getElementById('f-enabled').checked = true;
  setFreq('daily');
  setDow(1);
  setBrand('planeteria');
}

function setFreq(freq) {
  selectedFreq = freq;
  document.querySelectorAll('.freq-btn').forEach(b => b.classList.toggle('active', b.dataset.freq === freq));
  document.getElementById('f-dow-row').style.display  = freq === 'weekly'  ? '' : 'none';
  document.getElementById('f-dom-row').style.display  = freq === 'monthly' ? '' : 'none';
}

function setDow(dow) {
  selectedDow = dow;
  document.querySelectorAll('#f-dow-pills .day-pill').forEach(p =>
    p.classList.toggle('active', Number(p.dataset.dow) === dow)
  );
}

function setBrand(brand) {
  selectedBrand = brand;
  document.querySelectorAll('#f-brand-grid .brand-card').forEach(c =>
    c.classList.toggle('active', c.dataset.brand === brand)
  );
}

// Frequency buttons
document.querySelectorAll('.freq-btn').forEach(btn => {
  btn.addEventListener('click', () => setFreq(btn.dataset.freq));
});

// Day of week pills
document.querySelectorAll('#f-dow-pills .day-pill').forEach(pill => {
  pill.addEventListener('click', () => setDow(Number(pill.dataset.dow)));
});

// Brand cards
document.querySelectorAll('#f-brand-grid .brand-card').forEach(card => {
  card.addEventListener('click', () => setBrand(card.dataset.brand));
});

// ===================== ADD MODAL =====================

document.getElementById('sch-add-btn').addEventListener('click', () => {
  resetForm();
  openModal('sch-modal');
});

// ===================== EDIT MODAL =====================

async function openEditModal(id) {
  try {
    const res = await fetch('/api/scheduler/schedules', { headers: authHeaders() });
    const all = await res.json();
    const s = all.find(x => x.id === id);
    if (!s) return;

    editingId = id;
    document.getElementById('sch-modal-title').textContent = 'Edit Schedule';
    document.getElementById('f-name').value     = s.name || '';
    document.getElementById('f-url').value      = s.url  || '';
    document.getElementById('f-maxpages').value = s.maxPages || 50;
    document.getElementById('f-exclude').value  = (s.excludeSitemaps || []).join('\n');
    document.getElementById('f-emails').value     = (s.emails    || []).join('\n');
    document.getElementById('f-dev-emails').value = (s.devEmails || []).join('\n');
    document.getElementById('f-hour').value     = s.hour   ?? 8;
    document.getElementById('f-minute').value   = s.minute ?? 0;
    document.getElementById('f-dom').value      = s.dayOfMonth ?? 1;
    document.getElementById('f-enabled').checked = s.enabled !== false;
    setFreq(s.frequency || 'daily');
    setDow(s.dayOfWeek ?? 1);
    setBrand(s.brand || 'planeteria');
    openModal('sch-modal');
  } catch (err) {
    showToast('Failed to load schedule', true);
  }
}

// ===================== SAVE =====================

document.getElementById('sch-modal-save').addEventListener('click', async () => {
  const url = document.getElementById('f-url').value.trim();
  if (!url) { showToast('Website URL is required', true); return; }
  try { new URL(url); } catch { showToast('Invalid website URL', true); return; }

  const emailLines = document.getElementById('f-emails').value
    .split('\n').map(l => l.trim()).filter(Boolean);
  if (!emailLines.length) { showToast('At least one email address is required', true); return; }

  const excludeLines = document.getElementById('f-exclude').value
    .split('\n').map(l => l.trim()).filter(l => l.startsWith('http'));

  const payload = {
    name:            document.getElementById('f-name').value.trim(),
    url,
    maxPages:        parseInt(document.getElementById('f-maxpages').value) || 50,
    excludeSitemaps: excludeLines,
    frequency:       selectedFreq,
    dayOfWeek:       selectedDow,
    dayOfMonth:      parseInt(document.getElementById('f-dom').value) || 1,
    hour:            parseInt(document.getElementById('f-hour').value)   || 0,
    minute:          parseInt(document.getElementById('f-minute').value) || 0,
    emails:          emailLines,
    devEmails:       document.getElementById('f-dev-emails').value
                       .split('\n').map(l => l.trim()).filter(Boolean),
    brand:           selectedBrand,
    enabled:         document.getElementById('f-enabled').checked,
  };

  const saveBtn = document.getElementById('sch-modal-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const endpoint = editingId
      ? `/api/scheduler/schedules/${editingId}`
      : '/api/scheduler/schedules';
    const method = editingId ? 'PUT' : 'POST';

    const res = await fetch(endpoint, {
      method, headers: authHeaders(), body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');

    closeModal('sch-modal');
    showToast(editingId ? 'Schedule updated' : 'Schedule created');
    await reloadTable();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Schedule';
  }
});

// ===================== DELETE =====================

let pendingDeleteId = null;

function openDeleteModal(id, name) {
  pendingDeleteId = id;
  document.getElementById('sch-delete-name').textContent = name || 'this schedule';
  openModal('sch-delete-modal');
}

document.getElementById('sch-delete-confirm').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  try {
    const res = await fetch(`/api/scheduler/schedules/${pendingDeleteId}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    closeModal('sch-delete-modal');
    showToast('Schedule deleted');
    await reloadTable();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    pendingDeleteId = null;
  }
});

// ===================== MODAL HELPERS =====================

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.getElementById('sch-modal-close').addEventListener('click',  () => closeModal('sch-modal'));
document.getElementById('sch-modal-cancel').addEventListener('click', () => closeModal('sch-modal'));
document.getElementById('sch-delete-close').addEventListener('click', () => closeModal('sch-delete-modal'));
document.getElementById('sch-delete-cancel').addEventListener('click',() => closeModal('sch-delete-modal'));

document.querySelectorAll('.sch-modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal('sch-modal');
    closeModal('sch-delete-modal');
  }
});

// ===================== TOAST =====================

function showToast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `sch-toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ===================== LIVE QUEUE =====================

let queuePollInterval = null;

async function loadQueue() {
  const wrap = document.getElementById('live-queue-content');
  try {
    const res = await fetch('/api/queue');
    if (!res.ok) throw new Error('Failed to load queue');
    const { active, queued, runningAudits, maxConcurrent } = await res.json();

    if (!active.length && !queued.length) {
      wrap.innerHTML = `<div class="sch-empty" style="padding:32px 20px">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        No audits running or queued right now.
      </div>`;
      return;
    }

    // Fetch progress for each active audit in parallel
    const progressMap = {};
    await Promise.all(active.map(async a => {
      try {
        const r = await fetch(`/api/audit/${a.id}`);
        if (r.ok) {
          const d = await r.json();
          const p = d.progress || {};
          const audited = p.audited || 0;
          const total = p.total || 0;
          progressMap[a.id] = { audited, total, pct: total > 0 ? Math.round(audited / total * 100) : 0 };
        }
      } catch { /* ignore */ }
    }));

    const rows = [
      ...active.map(a => ({ ...a, queueType: 'running' })),
      ...queued.map(a => ({ ...a, queueType: 'queued' })),
    ];

    wrap.innerHTML = `
      <div style="padding:10px 16px;font-size:12px;color:var(--gray-500);border-bottom:1px solid var(--border)">
        ${runningAudits} of ${maxConcurrent} slots in use
      </div>
      <table class="queue-table">
        <thead><tr>
          <th>URL</th><th>Status</th><th>Progress</th><th>Started</th><th>Action</th>
        </tr></thead>
        <tbody>
          ${rows.map(a => {
            const prog = progressMap[a.id];
            const progressCell = prog
              ? `<div style="display:flex;align-items:center;gap:8px;min-width:140px">
                   <div style="flex:1;height:6px;background:#dbeafe;border-radius:3px;overflow:hidden">
                     <div style="width:${prog.pct}%;height:100%;background:#3b82f6;border-radius:3px;transition:width 0.4s"></div>
                   </div>
                   <span style="font-size:12px;font-weight:600;color:#1d4ed8;white-space:nowrap">${prog.pct}%</span>
                   <span style="font-size:11px;color:var(--gray-500);white-space:nowrap">${prog.audited}/${prog.total}</span>
                 </div>`
              : `<span style="font-size:12px;color:var(--gray-400)">—</span>`;
            return `<tr data-id="${escHtml(a.id)}">
              <td style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(a.url)}">${escHtml(a.url)}</td>
              <td><span class="queue-status-badge ${a.queueType === 'running' ? 'running' : 'queued'}">
                ${a.queueType === 'running'
                  ? `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#3b82f6;animation:pulse 1.5s infinite"></span> ${escHtml(a.status || 'running')}`
                  : 'Queued'}
              </span></td>
              <td>${progressCell}</td>
              <td style="color:var(--gray-500)">${timeAgo(a.startTime)}</td>
              <td><button class="queue-cancel-btn" data-id="${escHtml(a.id)}">Cancel</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;

    wrap.querySelectorAll('.queue-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => cancelAudit(btn.dataset.id, btn));
    });
  } catch {
    wrap.innerHTML = `<div class="sch-empty" style="padding:32px 20px;color:#dc2626">Failed to load queue.</div>`;
  }
}

async function cancelAudit(id, btn) {
  if (!confirm('Cancel this audit?')) return;
  btn.disabled = true;
  btn.textContent = 'Cancelling…';
  try {
    const res = await fetch(`/api/audit/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Cancel failed');
    showToast('Audit cancelled');
    await loadQueue();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
    btn.disabled = false;
    btn.textContent = 'Cancel';
  }
}

document.getElementById('queue-refresh-btn').addEventListener('click', loadQueue);

// ===================== BOOT =====================

init();
