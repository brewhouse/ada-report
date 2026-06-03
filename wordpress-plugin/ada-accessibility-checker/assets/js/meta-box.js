/* global adaChecker */
(function () {
  'use strict';

  let _auditId = '';

  function post(action, extra) {
    const body = new URLSearchParams({ action, nonce: adaChecker.nonce, ...extra });
    return fetch(adaChecker.ajaxUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }).then(r => r.json());
  }

  function show(id) {
    ['loading', 'none', 'results', 'scanning', 'error'].forEach(s => {
      const el = document.getElementById('ada-mb-' + s);
      if (el) el.style.display = s === id ? '' : 'none';
    });
  }

  function scoreColor(s) {
    if (s >= 90) return '#16a34a';
    if (s >= 70) return '#ca8a04';
    if (s >= 50) return '#ea580c';
    return '#dc2626';
  }

  function drawGauge(score) {
    const canvas = document.getElementById('ada-mb-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const cx = w / 2, cy = h / 2, r = w * 0.42;
    const pct = Math.max(0, Math.min(100, score || 0)) / 100;
    const color = scoreColor(score);

    ctx.clearRect(0, 0, w, h);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = w * 0.1;
    ctx.stroke();

    if (pct > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * pct);
      ctx.strokeStyle = color;
      ctx.lineWidth = w * 0.1;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.font = 'bold ' + Math.round(w * 0.26) + 'px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(score ?? 'N/A', cx, cy - h * 0.05);

    ctx.fillStyle = '#9ca3af';
    ctx.font = Math.round(w * 0.13) + 'px Arial, sans-serif';
    ctx.fillText('/100', cx, cy + h * 0.17);
  }

  function populateResults(data) {
    const $ = id => document.getElementById(id);

    $('ada-mb-score').textContent    = (data.score ?? 'N/A') + '/100';
    $('ada-mb-critical').textContent = (data.issues?.critical ?? 0);
    $('ada-mb-serious').textContent  = (data.issues?.serious  ?? 0);
    $('ada-mb-moderate').textContent = (data.issues?.moderate ?? 0);
    $('ada-mb-minor').textContent    = (data.issues?.minor    ?? 0);
    $('ada-mb-ignored').textContent  = (data.ignored ?? 0);
    drawGauge(data.score);

    if (data.auditedAt) {
      const d = new Date(data.auditedAt);
      $('ada-mb-audited').textContent = 'Scanned ' + d.toLocaleDateString();
    }

    show('results');
  }

  function startPageRescan(pageUrl) {
    show('scanning');
    const lbl = document.getElementById('ada-mb-scan-label');
    if (lbl) lbl.textContent = 'Rescanning this page… (may take up to 2 minutes)';

    // The rescan API is synchronous — the AJAX response only arrives when done.
    post('ada_rescan_page', { pageUrl, auditId: _auditId }).then(r => {
      if (!r.success) {
        document.getElementById('ada-mb-error-msg').textContent = r.data?.message || 'Rescan failed.';
        show('error');
        return;
      }
      // If the page itself errored during rescan (e.g. redirect, 403), show the reason.
      const page = r.data?.page;
      if (page && page.status === 'error') {
        document.getElementById('ada-mb-error-msg').textContent = page.error || 'Page could not be audited.';
        show('error');
        return;
      }
      // Rescan finished — reload the updated page results
      loadPageResults(pageUrl, _auditId);
    }).catch(() => {
      document.getElementById('ada-mb-error-msg').textContent = 'Request failed or timed out.';
      show('error');
    });
  }

  function loadPageResults(pageUrl, auditId) {
    post('ada_get_page_results', { pageUrl, auditId }).then(r => {
      if (!r.success) {
        document.getElementById('ada-mb-error-msg').textContent = r.data?.message || 'Failed to load.';
        show('error');
        return;
      }
      const d = r.data;
      if (d.status === 'no_audit' || d.status === 'not_found') {
        show('none');
      } else {
        populateResults(d);
      }
    }).catch(() => {
      document.getElementById('ada-mb-error-msg').textContent = 'Request failed.';
      show('error');
    });
  }

  function init() {
    const wrap = document.getElementById('ada-meta-box');
    if (!wrap) return;

    const pageUrl = wrap.dataset.pageUrl;
    const auditId = wrap.dataset.auditId;
    if (!pageUrl || !auditId) return; // handled by PHP (no audit / not published)

    // Keep module-level reference so rescan can forward it to AJAX handlers.
    _auditId = auditId;

    loadPageResults(pageUrl, auditId);

    const btn = document.getElementById('ada-mb-rescan-btn');
    if (btn) {
      btn.addEventListener('click', () => startPageRescan(pageUrl));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
