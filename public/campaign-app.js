// ===================== AUTH =====================

const TOKEN_KEY = 'cmp_token';

function getToken()   { return sessionStorage.getItem(TOKEN_KEY); }
function setToken(t)  { sessionStorage.setItem(TOKEN_KEY, t); }
function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

function authHeaders() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` };
}

// ===================== INIT =====================

let allTemplates = [];

async function init() {
  if (!getToken()) { showLogin(); return; }
  try {
    const res = await fetch('/api/campaign/clients', { headers: authHeaders() });
    if (res.status === 401) { clearToken(); showLogin(); return; }
    const clients = await res.json();
    allTemplates = await fetchTemplates();
    showDashboard(clients);
  } catch {
    showLogin();
  }
}

async function fetchTemplates() {
  try {
    const res = await fetch('/api/campaign/templates', { headers: authHeaders() });
    return res.ok ? await res.json() : [];
  } catch { return []; }
}

function showLogin() {
  document.getElementById('cmp-login').style.display = '';
  document.getElementById('cmp-dashboard').style.display = 'none';
}

function showDashboard(clients) {
  document.getElementById('cmp-login').style.display = 'none';
  document.getElementById('cmp-dashboard').style.display = '';
  renderTable(clients);
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
    allTemplates = await fetchTemplates();
    const clients = await (await fetch('/api/campaign/clients', { headers: authHeaders() })).json();
    showDashboard(clients);
  } catch {
    errEl.textContent = 'Network error. Please try again.';
  }
});

// ===================== LOGOUT =====================

document.getElementById('cmp-logout-btn').addEventListener('click', () => {
  clearToken();
  showLogin();
});

// ===================== EXPORT / IMPORT =====================

document.getElementById('cmp-export-btn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/campaign/clients/export', { headers: authHeaders() });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `campaign-clients-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    showToast(`Export failed: ${err.message}`, true);
  }
});

document.getElementById('cmp-import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const res = await fetch('/api/campaign/clients/import', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Import failed');
    showToast(`Imported ${result.imported}${result.skipped ? `, skipped ${result.skipped} invalid` : ''}`);
    await reloadTable();
  } catch (err) {
    showToast(`Import failed: ${err.message}`, true);
  } finally {
    e.target.value = '';
  }
});

// ===================== UTILITY =====================

function escHtml(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' +
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtDateShort(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ===================== TABLE RENDER =====================

// Track active ADA scans: clientId → auditId
const activeScans = new Map();
// Track active PDF scans: clientId → pdfAuditId
const activePdfScans = new Map();

function renderTable(clients) {
  const tbody = document.getElementById('cmp-table-body');

  if (!clients.length) {
    tbody.innerHTML = `<tr><td colspan="5">
      <div class="cmp-empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
        </svg>
        No campaign clients yet. Click <strong>Add Client</strong> to get started.
      </div>
    </td></tr>`;
    return;
  }

  const templateOptions = allTemplates.length
    ? allTemplates.map(t => `<option value="${escHtml(t.id)}">${escHtml(t.name)}</option>`).join('')
    : '<option value="" disabled>No templates — create one first</option>';

  tbody.innerHTML = clients.map(c => {
    const recipCount = (c.recipients || []).length;

    // Recipients cell
    const recipHtml = recipCount === 0
      ? `<span style="color:var(--gray-400);font-style:italic">No recipients</span>`
      : c.recipients.slice(0, 3).map(r => {
          const name = [r.firstName, r.lastName].filter(Boolean).join(' ');
          return `<div class="cmp-recip-item" title="${escHtml(r.email)}">${escHtml(r.email)}${name ? ` <span style="color:var(--gray-400)">(${escHtml(name)})</span>` : ''}</div>`;
        }).join('') + (recipCount > 3 ? `<div class="cmp-recip-more">+${recipCount - 3} more</div>` : '');

    // ADA scan results
    const isScanning = activeScans.has(c.id);
    let adaHtml;
    if (isScanning) {
      adaHtml = `<div id="scan-cell-${escHtml(c.id)}">
        <span class="scanning-dot"></span>
        <span style="font-size:12px;color:var(--gray-500)">ADA scanning…</span>
      </div>`;
    } else if (c.avgScore != null) {
      const score = Math.round(c.avgScore);
      const scoreClass = score >= 80 ? 'high' : score >= 60 ? 'mid' : 'low';
      adaHtml = `<div class="cmp-scan-results" id="scan-cell-${escHtml(c.id)}">
        <span class="score-badge ${scoreClass}" title="Average ADA score">${score}</span>
        <div>
          <div class="cmp-issue-pills">
            ${c.criticalIssues ? `<span class="issue-pill critical">C: ${c.criticalIssues}</span>` : ''}
            ${c.seriousIssues  ? `<span class="issue-pill serious">S: ${c.seriousIssues}</span>` : ''}
            ${c.moderateIssues ? `<span class="issue-pill moderate">M: ${c.moderateIssues}</span>` : ''}
            ${c.minorIssues    ? `<span class="issue-pill minor">Mi: ${c.minorIssues}</span>` : ''}
          </div>
          <div style="font-size:11px;color:var(--gray-500);margin-top:3px">
            ${c.totalIssues ?? 0} total issues &bull; ${fmtDate(c.lastScanAt)}
          </div>
        </div>
      </div>`;
    } else {
      adaHtml = `<div class="cmp-scan-results" id="scan-cell-${escHtml(c.id)}">
        <span class="score-badge none">—</span>
        <span style="font-size:12px;color:var(--gray-400)">No ADA scan yet</span>
      </div>`;
    }

    // PDF scan results
    const isPdfScanning = activePdfScans.has(c.id);
    let pdfHtml;
    if (isPdfScanning) {
      pdfHtml = `<div class="pdf-scan-section" id="pdf-cell-${escHtml(c.id)}">
        <div class="pdf-scan-row">
          <span class="scanning-dot pdf"></span>
          <span style="font-size:12px;color:#7c3aed">PDF scanning…</span>
        </div>
      </div>`;
    } else if (c.pdfScanAt) {
      const hasStats = c.pdfDiscovered > 0 || c.pdfAudited > 0 || c.pdfPagesCrawled > 0 || c.pdfTotalPdfs > 0;
      const pdfCount = c.pdfDiscovered || c.pdfAudited || c.pdfTotalPdfs || 0;
      pdfHtml = `<div class="pdf-scan-section" id="pdf-cell-${escHtml(c.id)}">
        <div class="pdf-scan-row">
          <span class="pdf-icon">📄</span>
          <span class="pdf-badge">${pdfCount} PDFs found</span>
          <span style="font-size:11px;color:var(--gray-500)">${fmtDateShort(c.pdfScanAt)}</span>
        </div>
        ${hasStats ? `<div class="pdf-stats-grid">
          <div class="pdf-stat">Pages crawled: <strong>${c.pdfPagesCrawled ?? 0}</strong></div>
          <div class="pdf-stat">Discovered: <strong>${c.pdfDiscovered ?? 0}</strong></div>
          <div class="pdf-stat">Audited: <strong>${c.pdfAudited ?? 0}</strong></div>
          <div class="pdf-stat" style="color:#166534">Compliant: <strong>${c.pdfCompliant ?? 0}</strong></div>
          <div class="pdf-stat" style="color:#991b1b">Non-compliant: <strong>${c.pdfNonCompliant ?? 0}</strong></div>
          <div class="pdf-stat" style="color:#b45309">Errored: <strong>${c.pdfErrored ?? 0}</strong></div>
          ${c.pdfComplianceRate ? `<div class="pdf-stat rate" style="grid-column:1/-1">Compliance rate: <strong>${escHtml(c.pdfComplianceRate)}</strong></div>` : ''}
        </div>` : ''}
        ${c.pdfReportMarkdown ? `<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="pdf-report-btn" data-action="view-report" data-id="${escHtml(c.id)}">View Full Report</button><button class="pdf-report-btn" style="background:#f0fdf4;color:#166534;border-color:#bbf7d0" data-action="reparse-pdf" data-id="${escHtml(c.id)}">Re-parse Stats</button></div>` : ''}
      </div>`;
    } else {
      pdfHtml = `<div class="pdf-scan-section" id="pdf-cell-${escHtml(c.id)}">
        <div class="pdf-scan-row">
          <span class="pdf-icon" style="opacity:.4">📄</span>
          <span style="font-size:12px;color:var(--gray-400)">No PDF scan yet</span>
        </div>
      </div>`;
    }

    // Send controls
    const noTemplates = allTemplates.length === 0;
    const noRecip = recipCount === 0;
    const sendDisabled = noTemplates || noRecip ? 'disabled' : '';
    const sendTitle = noTemplates ? 'Create email templates first' : noRecip ? 'Add recipients first' : '';
    const sendHtml = `<div class="cmp-send-wrap">
      <select class="cmp-template-select" data-id="${escHtml(c.id)}" ${noTemplates ? 'disabled' : ''}>
        <option value="">Select template…</option>
        ${templateOptions}
      </select>
      <button class="cmp-send-btn" data-action="send" data-id="${escHtml(c.id)}" ${sendDisabled} title="${escHtml(sendTitle)}">Send</button>
    </div>`;

    return `<tr data-id="${escHtml(c.id)}">
      <td>
        <div class="cmp-client-name">${escHtml(c.name)}</div>
        <div class="cmp-client-url"><a href="${escHtml(c.url)}" target="_blank" rel="noopener" style="color:var(--gray-500)">${escHtml(c.url)}</a></div>
      </td>
      <td><div class="cmp-recip-list">${recipHtml}</div></td>
      <td>${adaHtml}${pdfHtml}</td>
      <td>${sendHtml}</td>
      <td>
        <div class="cmp-actions">
          <button class="sch-act-btn scan-btn" data-action="scan" data-id="${escHtml(c.id)}"
            ${isScanning ? 'disabled' : ''} title="Run ADA accessibility scan on 50 pages">
            ${isScanning ? '…ADA' : '▶ ADA'}
          </button>
          <button class="sch-act-btn" data-action="pdf-scan" data-id="${escHtml(c.id)}"
            ${isPdfScanning ? 'disabled' : ''}
            style="color:#7c3aed;border-color:#ddd6fe;" title="Scan PDFs on this website">
            ${isPdfScanning ? '…PDF' : '📄 PDF'}
          </button>
          <button class="sch-act-btn" data-action="detect-cms" data-id="${escHtml(c.id)}"
            style="color:#0369a1;border-color:#bae6fd;" title="Detect CMS platform">
            🔍 CMS
          </button>
          <button class="sch-act-btn" data-action="edit" data-id="${escHtml(c.id)}">Edit</button>
          <button class="sch-act-btn danger" data-action="delete" data-id="${escHtml(c.id)}" data-name="${escHtml(c.name)}">Delete</button>
        </div>
        ${c.cmsDetected ? `<div class="cms-badge" title="Detected ${c.cmsDetectedAt ? new Date(c.cmsDetectedAt).toLocaleDateString() : ''}">${escHtml(c.cmsDetected)}</div>` : ''}
      </td>
    </tr>`;
  }).join('');

  // Wire up all action buttons
  tbody.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', () => {
      const { action, id, name } = el.dataset;
      if (action === 'scan')        startScan(id, el);
      if (action === 'pdf-scan')    startPdfScan(id, el);
      if (action === 'edit')        openEditModal(id);
      if (action === 'delete')      openDeleteModal(id, name);
      if (action === 'send')        sendEmail(id, el);
      if (action === 'view-report') viewPdfReport(id);
      if (action === 'reparse-pdf') reparsePdf(id, el);
      if (action === 'detect-cms')  detectCms(id, el);
    });
  });
}

async function reloadTable() {
  try {
    const res = await fetch('/api/campaign/clients', { headers: authHeaders() });
    if (res.status === 401) { clearToken(); showLogin(); return; }
    allTemplates = await fetchTemplates();
    renderTable(await res.json());
  } catch {
    showToast('Failed to reload clients', true);
  }
}

// ===================== ADA SCAN =====================

async function startScan(clientId, btn) {
  btn.disabled = true;
  btn.textContent = '…ADA';
  activeScans.set(clientId, true);

  const scanCell = document.getElementById(`scan-cell-${clientId}`);
  if (scanCell) scanCell.innerHTML = `<span class="scanning-dot"></span><span style="font-size:12px;color:var(--gray-500)">Starting scan…</span>`;

  try {
    const res = await fetch(`/api/campaign/clients/${clientId}/scan`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).error || 'Scan start failed');
    const { auditId } = await res.json();
    activeScans.set(clientId, auditId);
    pollScan(clientId, auditId);
  } catch (err) {
    activeScans.delete(clientId);
    btn.disabled = false;
    btn.textContent = '▶ ADA';
    showToast(`ADA scan failed: ${err.message}`, true);
    if (scanCell) scanCell.innerHTML = `<span class="score-badge none">—</span><span style="font-size:12px;color:#dc2626">Scan failed</span>`;
  }
}

function pollScan(clientId, auditId) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/audit/${auditId}`);
      if (!res.ok) return;
      const data = await res.json();

      const scanCell = document.getElementById(`scan-cell-${clientId}`);
      const running = ['running','queued','crawling','auditing'].includes(data.status);
      if (running) {
        const p = data.progress || {};
        const pct = p.total > 0 ? Math.round(p.audited / p.total * 100) : 0;
        if (scanCell) scanCell.innerHTML = `<span class="scanning-dot"></span><span style="font-size:12px;color:var(--gray-500)">${pct > 0 ? pct + '%' : 'Scanning…'} (${p.audited || 0}/${p.total || '?'})</span>`;
        return;
      }

      clearInterval(interval);
      activeScans.delete(clientId);

      if (data.status === 'completed' && data.summary) {
        const s = data.summary;
        await fetch(`/api/campaign/clients/${clientId}/scan-results`, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({
            lastAuditId: auditId, avgScore: s.averageScore ?? 0,
            totalIssues: s.totalIssues ?? 0, criticalIssues: s.criticalIssues ?? 0,
            seriousIssues: s.seriousIssues ?? 0, moderateIssues: s.moderateIssues ?? 0,
            minorIssues: s.minorIssues ?? 0,
          }),
        });
        showToast('ADA scan complete — results saved');
      } else if (data.status === 'error') {
        showToast(`ADA scan ended with error: ${data.error || 'unknown'}`, 'warn');
      }
      await reloadTable();
    } catch { /* ignore transient errors */ }
  }, 4000);
}

// ===================== PDF SCAN =====================

async function startPdfScan(clientId, btn) {
  btn.disabled = true;
  btn.textContent = '…PDF';
  activePdfScans.set(clientId, true);

  const pdfCell = document.getElementById(`pdf-cell-${clientId}`);
  if (pdfCell) pdfCell.innerHTML = `<div class="pdf-scan-row"><span class="scanning-dot pdf"></span><span style="font-size:12px;color:#7c3aed">Starting PDF scan…</span></div>`;

  try {
    const res = await fetch(`/api/campaign/clients/${clientId}/pdf-scan`, {
      method: 'POST', headers: authHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `PDF scan failed (${data.code || res.status})`);
    activePdfScans.set(clientId, data.pdfAuditId);
    pollPdfScan(clientId, data.pdfAuditId);
  } catch (err) {
    activePdfScans.delete(clientId);
    btn.disabled = false;
    btn.textContent = '📄 PDF';
    showToast(`PDF scan failed: ${err.message}`, true);
    if (pdfCell) pdfCell.innerHTML = `<div class="pdf-scan-row"><span class="pdf-icon" style="opacity:.4">📄</span><span style="font-size:12px;color:#dc2626">Scan failed</span></div>`;
  }
}

function pollPdfScan(clientId, pdfAuditId) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/campaign/pdf-audit/${pdfAuditId}`, { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();

      const pdfCell = document.getElementById(`pdf-cell-${clientId}`);
      const terminal = data.status === 'completed' || data.status === 'failed';

      if (!terminal) {
        const msg = data.status === 'running'
          ? `Scanning… (${data.progress?.scanned ?? 0}/${data.progress?.total ?? '?'} PDFs)`
          : 'Queued…';
        if (pdfCell) pdfCell.innerHTML = `<div class="pdf-scan-row"><span class="scanning-dot pdf"></span><span style="font-size:12px;color:#7c3aed">${msg}</span></div>`;
        return;
      }

      clearInterval(interval);
      activePdfScans.delete(clientId);

      if (data.status === 'completed') {
        // Fetch the markdown report
        let markdown = null;
        try {
          const rptRes = await fetch(`/api/campaign/pdf-audit/${pdfAuditId}/report`, { headers: authHeaders() });
          if (rptRes.ok) markdown = await rptRes.text();
        } catch { /* report fetch failed, proceed without it */ }

        const totalPdfs = data.summary?.totalPdfs ?? data.scope?.maxPdfs ?? 0;
        await fetch(`/api/campaign/clients/${clientId}/pdf-scan-results`, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({ pdfAuditId, pdfTotalPdfs: totalPdfs, pdfReportMarkdown: markdown }),
        });
        showToast(`PDF scan complete — ${totalPdfs} PDFs found`);
      } else {
        showToast(`PDF scan failed: ${data.error || data.message || 'unknown error'}`, true);
      }
      await reloadTable();
    } catch { /* ignore transient errors */ }
  }, 5000);
}

// ===================== VIEW PDF REPORT =====================

let currentReportClientId = null;

function viewPdfReport(clientId) {
  currentReportClientId = clientId;
  // Fetch the client from DOM to get the report we already have stored
  // We'll re-fetch from API to get the markdown
  fetch('/api/campaign/clients', { headers: authHeaders() })
    .then(r => r.json())
    .then(clients => {
      const c = clients.find(x => x.id === clientId);
      if (!c || !c.pdfReportMarkdown) { showToast('No report available', true); return; }
      document.getElementById('pdf-report-title').textContent = `PDF Report — ${c.name}`;
      document.getElementById('pdf-report-content').textContent = c.pdfReportMarkdown;
      openModal('pdf-report-modal');
    })
    .catch(() => showToast('Failed to load report', true));
}

async function reparsePdf(clientId, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Re-parsing…';
  try {
    const res = await fetch(`/api/campaign/clients/${clientId}/reparse-pdf`, {
      method: 'POST', headers: authHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Re-parse failed');
    showToast('PDF stats re-parsed successfully');
    await reloadTable();
  } catch (err) {
    showToast(`Re-parse failed: ${err.message}`, true);
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function detectCms(clientId, btn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '🔍…';
  try {
    const res = await fetch(`/api/campaign/clients/${clientId}/detect-cms`, {
      method: 'POST', headers: authHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Detection failed');
    showToast(`CMS detected: ${data.cms}`);
    await reloadTable();
  } catch (err) {
    showToast(`CMS detection failed: ${err.message}`, true);
    btn.disabled = false;
    btn.textContent = orig;
  }
}

document.getElementById('pdf-report-close').addEventListener('click', () => closeModal('pdf-report-modal'));
document.getElementById('pdf-report-close-btn').addEventListener('click', () => closeModal('pdf-report-modal'));
document.getElementById('pdf-report-copy').addEventListener('click', () => {
  const content = document.getElementById('pdf-report-content').textContent;
  navigator.clipboard.writeText(content).then(() => showToast('Markdown copied to clipboard'));
});

// ===================== SEND EMAIL =====================

// State for the send-confirm modal
let pendingSendClientId  = null;
let pendingSendTemplateId = null;
let pendingSendBtn       = null;

async function sendEmail(clientId, btn) {
  const row = btn.closest('tr');
  const select = row.querySelector('.cmp-template-select');
  const templateId = select?.value;
  if (!templateId) { showToast('Please select a template first', true); return; }

  const clients = await (await fetch('/api/campaign/clients', { headers: authHeaders() })).json();
  const client = clients.find(c => c.id === clientId);
  if (!client) return;

  const recip = client.recipients || [];
  if (recip.length === 0) { showToast('No recipients configured for this client', true); return; }

  const tmpl = allTemplates.find(t => t.id === templateId);

  // Populate and open the send-confirm modal
  document.getElementById('sm-client-name').textContent   = client.name;
  document.getElementById('sm-template-name').textContent = tmpl?.name || templateId;
  document.getElementById('sm-recipients').textContent    =
    recip.map(r => [r.firstName, r.lastName].filter(Boolean).join(' ')
      ? `${r.email} (${[r.firstName, r.lastName].filter(Boolean).join(' ')})`
      : r.email
    ).join(', ');
  document.getElementById('sm-from-name').value  = tmpl?.fromName  || client.fromName  || 'Planeteria Media';
  document.getElementById('sm-from-email').value = tmpl?.fromEmail || client.fromEmail || 'noreply@planeteria.com';
  document.getElementById('sm-cc-email').value   = '';
  document.getElementById('sm-bcc-email').value  = tmpl?.bccEmail || '';

  pendingSendClientId   = clientId;
  pendingSendTemplateId = templateId;
  pendingSendBtn        = btn;
  openModal('cmp-send-modal');
}

async function executeSend() {
  const clientId   = pendingSendClientId;
  const templateId = pendingSendTemplateId;
  const btn        = pendingSendBtn;
  const fromName  = document.getElementById('sm-from-name').value.trim();
  const fromEmail = document.getElementById('sm-from-email').value.trim();
  const ccEmail   = document.getElementById('sm-cc-email').value.trim();
  const bccEmail  = document.getElementById('sm-bcc-email').value.trim();

  closeModal('cmp-send-modal');
  pendingSendClientId = pendingSendTemplateId = pendingSendBtn = null;

  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    const res = await fetch(`/api/campaign/clients/${clientId}/send-email`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        templateId,
        fromName:  fromName  || undefined,
        fromEmail: fromEmail || undefined,
        ccEmail:   ccEmail   || undefined,
        bccEmail:  bccEmail  || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    if (data.failed > 0) {
      showToast(`Sent ${data.sent}, failed ${data.failed}`, 'warn');
    } else {
      showToast(`Email sent to ${data.sent} recipient(s)`);
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
  }
}

document.getElementById('cmp-send-confirm').addEventListener('click', executeSend);
document.getElementById('cmp-send-close').addEventListener('click',  () => closeModal('cmp-send-modal'));
document.getElementById('cmp-send-cancel').addEventListener('click', () => closeModal('cmp-send-modal'));

// Allow pressing Enter in the CC field to confirm
document.getElementById('sm-cc-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); executeSend(); }
});

// ===================== MODAL HELPERS =====================

function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.getElementById('cmp-modal-close').addEventListener('click', () => closeModal('cmp-modal'));
document.getElementById('cmp-modal-cancel').addEventListener('click', () => closeModal('cmp-modal'));
document.getElementById('cmp-delete-close').addEventListener('click', () => closeModal('cmp-delete-modal'));
document.getElementById('cmp-delete-cancel').addEventListener('click', () => closeModal('cmp-delete-modal'));

document.querySelectorAll('.sch-modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeModal('cmp-modal');
    closeModal('cmp-delete-modal');
    closeModal('pdf-report-modal');
  }
});

// ===================== RECIPIENTS EDITOR =====================

function buildRecipRow(recip = {}) {
  const row = document.createElement('div');
  row.className = 'recip-row';
  row.innerHTML = `
    <input type="email" placeholder="email@example.com" class="recip-email" value="${escHtml(recip.email || '')}">
    <input type="text"  placeholder="First name"        class="recip-first" value="${escHtml(recip.firstName || '')}">
    <input type="text"  placeholder="Last name"         class="recip-last"  value="${escHtml(recip.lastName  || '')}">
    <button type="button" class="recip-remove-btn" title="Remove">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>`;
  row.querySelector('.recip-remove-btn').addEventListener('click', () => row.remove());
  return row;
}

document.getElementById('f-add-recip').addEventListener('click', () => {
  document.getElementById('f-recipients').appendChild(buildRecipRow());
});

function getRecipients() {
  return [...document.querySelectorAll('#f-recipients .recip-row')].map(row => ({
    email:     row.querySelector('.recip-email').value.trim(),
    firstName: row.querySelector('.recip-first').value.trim(),
    lastName:  row.querySelector('.recip-last').value.trim(),
  })).filter(r => r.email);
}

function setRecipients(recipients) {
  const container = document.getElementById('f-recipients');
  container.innerHTML = '';
  (recipients || []).forEach(r => container.appendChild(buildRecipRow(r)));
}

// ===================== ADD / EDIT MODAL =====================

let editingId = null;

function resetForm() {
  editingId = null;
  document.getElementById('cmp-modal-title').textContent = 'Add Client';
  document.getElementById('f-name').value = '';
  document.getElementById('f-url').value = '';
  document.getElementById('f-from-email').value = 'noreply@planeteria.com';
  document.getElementById('f-from-name').value = 'Planeteria Media';
  document.getElementById('f-cc-email').value = 'sales@planeteria.com';
  document.getElementById('f-notes').value = '';
  setRecipients([]);
}

document.getElementById('cmp-add-btn').addEventListener('click', () => {
  resetForm();
  openModal('cmp-modal');
});

async function openEditModal(id) {
  try {
    const res = await fetch('/api/campaign/clients', { headers: authHeaders() });
    const all = await res.json();
    const c = all.find(x => x.id === id);
    if (!c) return;
    editingId = id;
    document.getElementById('cmp-modal-title').textContent = 'Edit Client';
    document.getElementById('f-name').value       = c.name || '';
    document.getElementById('f-url').value        = c.url  || '';
    document.getElementById('f-from-email').value = c.fromEmail || 'noreply@planeteria.com';
    document.getElementById('f-from-name').value  = c.fromName  || 'Planeteria Media';
    document.getElementById('f-cc-email').value   = c.ccEmail   || 'sales@planeteria.com';
    document.getElementById('f-notes').value      = c.notes     || '';
    setRecipients(c.recipients || []);
    openModal('cmp-modal');
  } catch {
    showToast('Failed to load client', true);
  }
}

document.getElementById('cmp-modal-save').addEventListener('click', async () => {
  const name = document.getElementById('f-name').value.trim();
  const url  = document.getElementById('f-url').value.trim();
  if (!name) { showToast('Client name is required', true); return; }
  if (!url)  { showToast('Website URL is required', true); return; }
  try { new URL(url); } catch { showToast('Invalid website URL', true); return; }

  const payload = {
    name, url,
    fromEmail:  document.getElementById('f-from-email').value.trim() || 'noreply@planeteria.com',
    fromName:   document.getElementById('f-from-name').value.trim()  || 'Planeteria Media',
    ccEmail:    document.getElementById('f-cc-email').value.trim()   || '',
    notes:      document.getElementById('f-notes').value.trim(),
    recipients: getRecipients(),
  };

  const saveBtn = document.getElementById('cmp-modal-save');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const endpoint = editingId ? `/api/campaign/clients/${editingId}` : '/api/campaign/clients';
    const method   = editingId ? 'PUT' : 'POST';
    const res = await fetch(endpoint, { method, headers: authHeaders(), body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    closeModal('cmp-modal');
    showToast(editingId ? 'Client updated' : 'Client added');
    await reloadTable();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Client';
  }
});

// ===================== DELETE =====================

let pendingDeleteId = null;

function openDeleteModal(id, name) {
  pendingDeleteId = id;
  document.getElementById('cmp-delete-name').textContent = name || 'this client';
  openModal('cmp-delete-modal');
}

document.getElementById('cmp-delete-confirm').addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  try {
    const res = await fetch(`/api/campaign/clients/${pendingDeleteId}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    closeModal('cmp-delete-modal');
    showToast('Client deleted');
    await reloadTable();
  } catch (err) {
    showToast(`Error: ${err.message}`, true);
  } finally {
    pendingDeleteId = null;
  }
});

// ===================== TOAST =====================

function showToast(msg, type = false) {
  const el = document.createElement('div');
  el.className = `sch-toast${type === true ? ' error' : type === 'warn' ? ' warn' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

// ===================== BOOT =====================

init();
