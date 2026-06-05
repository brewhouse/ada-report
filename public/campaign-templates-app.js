// ===================== AUTH =====================

const TOKEN_KEY = 'cmp_token';

function getToken()   { return sessionStorage.getItem(TOKEN_KEY); }
function setToken(t)  { sessionStorage.setItem(TOKEN_KEY, t); }
function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` };
}

// ===================== INIT =====================

async function init() {
  if (!getToken()) { showLogin(); return; }
  try {
    const res = await fetch('/api/campaign/templates', { headers: authHeaders() });
    if (res.status === 401) { clearToken(); showLogin(); return; }
    showDashboard(await res.json());
  } catch {
    showLogin();
  }
}

function showLogin() {
  document.getElementById('tmpl-login').style.display = '';
  document.getElementById('tmpl-dashboard').style.display = 'none';
}

function showDashboard(templates) {
  document.getElementById('tmpl-login').style.display = 'none';
  document.getElementById('tmpl-dashboard').style.display = '';
  renderTable(templates);
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
    const res = await fetch('/api/campaign/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Invalid credentials.'; return; }
    setToken(data.token);
    const templates = await (await fetch('/api/campaign/templates', { headers: authHeaders() })).json();
    showDashboard(templates);
  } catch {
    errEl.textContent = 'Network error. Please try again.';
  }
});

// ===================== LOGOUT =====================

document.getElementById('tmpl-logout-btn').addEventListener('click', () => {
  clearToken();
  showLogin();
});

// ===================== UTILITY =====================

function escHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ===================== TABLE =====================

function renderTable(templates) {
  const tbody = document.getElementById('tmpl-table-body');
  if (!templates.length) {
    tbody.innerHTML = `<tr><td colspan="4">
      <div class="sch-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
        </svg>
        No email templates yet. Click <strong>Add Template</strong> to create one.
      </div>
    </td></tr>`;
    return;
  }

  tbody.innerHTML = templates.map(t => {
    const preview = stripHtml(t.body).substring(0, 120) + (t.body.length > 120 ? '…' : '');
    return `<tr data-id="${escHtml(t.id)}">
      <td>
        <div class="tmpl-name">${escHtml(t.name)}</div>
        <div class="tmpl-subject" title="${escHtml(t.subject)}">Subject: ${escHtml(t.subject)}</div>
      </td>
      <td><div class="tmpl-preview">${escHtml(preview)}</div></td>
      <td style="white-space:nowrap;color:var(--gray-500)">${fmtDate(t.createdAt)}</td>
      <td>
        <div class="sch-actions">
          <button class="sch-act-btn" data-action="edit" data-id="${escHtml(t.id)}">Edit</button>
          <button class="sch-act-btn danger" data-action="delete" data-id="${escHtml(t.id)}" data-name="${escHtml(t.name)}">Delete</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const { action, id, name } = btn.dataset;
      if (action === 'edit')   openEditModal(id);
      if (action === 'delete') openDeleteModal(id, name);
    });
  });
}

async function reloadTable() {
  try {
    const res = await fetch('/api/campaign/templates', { headers: authHeaders() });
    if (res.status === 401) { clearToken(); showLogin(); return; }
    renderTable(await res.json());
  } catch {
    showToast('Failed to reload templates', true);
  }
}

// ===================== VARIABLE INSERTION =====================

document.querySelectorAll('.var-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const variable = pill.dataset.var;
    const targetId = pill.dataset.target;
    const el = document.getElementById(targetId);
    if (!el) return;

    const start = el.selectionStart;
    const end   = el.selectionEnd;
    const before = el.value.substring(0, start);
    const after  = el.value.substring(end);
    el.value = before + variable + after;
    const newPos = start + variable.length;
    el.selectionStart = newPos;
    el.selectionEnd   = newPos;
    el.focus();
    refreshPreview();
  });
});

// ===================== LIVE PREVIEW =====================

const SAMPLE_VARS = {
  first_name:      'Jane',
  last_name:       'Smith',
  client_name:     'Acme City Government',
  website_url:     'https://acme.gov',
  ada_score:       '72',
  total_issues:    '84',
  critical_issues: '12',
  serious_issues:  '23',
  moderate_issues: '31',
  minor_issues:    '18',
  pdf_total_pdfs:       '14',
  pdf_pages_crawled:    '312',
  pdf_discovered:       '14',
  pdf_audited:          '14',
  pdf_compliant:        '8',
  pdf_non_compliant:    '5',
  pdf_errored:          '1',
  pdf_compliance_rate:  '57.1%',
  pdf_scan_date:        'May 29, 2026',
  pdf_report:           '# PDF Accessibility Report\n\n**14 PDFs scanned** on https://acme.gov\n\n## Summary\n- 3 PDFs missing text layer\n- 6 PDFs lack document titles\n- 2 PDFs have no language set\n',
};

function renderTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}

function refreshPreview() {
  const body    = document.getElementById('f-body').value;
  const subject = document.getElementById('f-subject').value;
  const rendered = renderTemplate(body, SAMPLE_VARS);
  const frame = document.getElementById('tmpl-preview-frame');
  const doc = frame.contentDocument || frame.contentWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <style>
      body { font-family: Arial, sans-serif; font-size:14px; line-height:1.6; color:#1a202c; padding:16px; margin:0; }
      a { color:#107DC2; }
      table { border-collapse:collapse; }
      td, th { padding:8px 12px; border:1px solid #e2e8f0; }
    </style>
  </head><body>${rendered}</body></html>`);
  doc.close();
}

document.getElementById('f-body').addEventListener('input', refreshPreview);
document.getElementById('f-subject').addEventListener('input', refreshPreview);
document.getElementById('refresh-preview-btn').addEventListener('click', refreshPreview);

// ===================== MODAL HELPERS =====================

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.getElementById('tmpl-modal-close').addEventListener('click',  () => closeModal('tmpl-modal'));
document.getElementById('tmpl-modal-cancel').addEventListener('click', () => closeModal('tmpl-modal'));
document.getElementById('tmpl-delete-close').addEventListener('click', () => closeModal('tmpl-delete-modal'));
document.getElementById('tmpl-delete-cancel').addEventListener('click',() => closeModal('tmpl-delete-modal'));

document.querySelectorAll('.sch-modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal('tmpl-modal');
    closeModal('tmpl-delete-modal');
  }
});

// ===================== ADD / EDIT MODAL =====================

let editingId = null;

function resetForm() {
  editingId = null;
  document.getElementById('tmpl-modal-title').textContent = 'Add Template';
  document.getElementById('f-tname').value      = '';
  document.getElementById('f-from-email').value = '';
  document.getElementById('f-bcc-email').value  = 'planeteria_board_18415768357_df9dd2be8427a618f717__48675235@use1.mx.monday.com';
  document.getElementById('f-subject').value    = '';
  document.getElementById('f-body').value       = '';
  refreshPreview();
}

document.getElementById('tmpl-add-btn').addEventListener('click', () => {
  resetForm();
  openModal('tmpl-modal');
});

async function openEditModal(id) {
  try {
    const res = await fetch('/api/campaign/templates', { headers: authHeaders() });
    const all = await res.json();
    const t = all.find(x => x.id === id);
    if (!t) return;
    editingId = id;
    document.getElementById('tmpl-modal-title').textContent = 'Edit Template';
    document.getElementById('f-tname').value      = t.name      || '';
    document.getElementById('f-from-email').value = t.fromEmail || '';
    document.getElementById('f-bcc-email').value  = t.bccEmail  || 'planeteria_board_18415768357_df9dd2be8427a618f717__48675235@use1.mx.monday.com';
    document.getElementById('f-subject').value    = t.subject   || '';
    document.getElementById('f-body').value       = t.body      || '';
    refreshPreview();
    openModal('tmpl-modal');
  } catch (err) {
    showToast('Failed to load template', true);
  }
}

document.getElementById('tmpl-modal-save').addEventListener('click', async () => {
  const name      = document.getElementById('f-tname').value.trim();
  const fromEmail = document.getElementById('f-from-email').value.trim() || null;
  const bccEmail  = document.getElementById('f-bcc-email').value.trim()  || null;
  const subject   = document.getElementById('f-subject').value.trim();
  const body      = document.getElementById('f-body').value.trim();
  if (!name)    { showToast('Template name is required', true); return; }
  if (!subject) { showToast('Email subject is required', true); return; }
  if (!body)    { showToast('Email body is required', true); return; }

  const saveBtn = document.getElementById('tmpl-modal-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const endpoint = editingId ? `/api/campaign/templates/${editingId}` : '/api/campaign/templates';
    const method   = editingId ? 'PUT' : 'POST';
    const res = await fetch(endpoint, {
      method, headers: authHeaders(), body: JSON.stringify({ name, fromEmail, bccEmail, subject, body }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    closeModal('tmpl-modal');
    showToast(editingId ? 'Template updated' : 'Template created');
    await reloadTable();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Template';
  }
});

// ===================== DELETE =====================

let pendingDeleteId = null;

function openDeleteModal(id, name) {
  pendingDeleteId = id;
  document.getElementById('tmpl-delete-name').textContent = name || 'this template';
  openModal('tmpl-delete-modal');
}

document.getElementById('tmpl-delete-confirm').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  try {
    const res = await fetch(`/api/campaign/templates/${pendingDeleteId}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    closeModal('tmpl-delete-modal');
    showToast('Template deleted');
    await reloadTable();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    pendingDeleteId = null;
  }
});

// ===================== TOAST =====================

function showToast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = `sch-toast${isError ? ' error' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// ===================== BOOT =====================

init();
