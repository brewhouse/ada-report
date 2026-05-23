/* global adaChecker */
(function () {
  'use strict';

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function post(action, extra) {
    const body = new URLSearchParams({ action, nonce: adaChecker.nonce, ...extra });
    return fetch(adaChecker.ajaxUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    }).then(r => r.json());
  }

  function show(id) {
    ['loading', 'none', 'scanning', 'results', 'error'].forEach(s => {
      const el = document.getElementById('ada-state-' + s);
      if (el) el.style.display = s === id ? '' : 'none';
    });
  }

  function scoreColor(s) {
    if (s >= 90) return '#16a34a';
    if (s >= 70) return '#ca8a04';
    if (s >= 50) return '#ea580c';
    return '#dc2626';
  }

  function drawGauge(canvasId, score) {
    const canvas = document.getElementById(canvasId);
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
    ctx.lineWidth = w * 0.09;
    ctx.stroke();

    if (pct > 0) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * pct);
      ctx.strokeStyle = color;
      ctx.lineWidth = w * 0.09;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.font = 'bold ' + Math.round(w * 0.22) + 'px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(score ?? 'N/A', cx, cy - h * 0.05);

    ctx.fillStyle = '#9ca3af';
    ctx.font = Math.round(w * 0.1) + 'px Arial, sans-serif';
    ctx.fillText('/100', cx, cy + h * 0.14);
  }

  function populateResults(data) {
    const $ = id => document.getElementById(id);
    $('ada-stat-pages').textContent   = (data.pagesAudited    ?? 0).toLocaleString();
    $('ada-stat-issues').textContent  = (data.issues?.total   ?? 0).toLocaleString();
    $('ada-sev-critical').textContent = (data.issues?.critical ?? 0).toLocaleString();
    $('ada-sev-serious').textContent  = (data.issues?.serious  ?? 0).toLocaleString();
    $('ada-sev-moderate').textContent = (data.issues?.moderate ?? 0).toLocaleString();
    $('ada-sev-minor').textContent    = (data.issues?.minor    ?? 0).toLocaleString();
    $('ada-sev-ignored').textContent  = (data.ignored ?? 0).toLocaleString();
    drawGauge('ada-score-canvas', data.score ?? 0);
    show('results');
  }

  /**
   * Convert the raw summary from GET /api/audit/:id into the populateResults format.
   * Used to show data immediately from the poll response while we wait for the
   * ignored-adjusted summary from scan-summary.
   */
  function rawSummaryToResults(auditId, summary) {
    return {
      auditId,
      pagesAudited: summary.totalPages      || 0,
      score:        Math.round(summary.averageScore || 0),
      issues: {
        total:    summary.totalIssues    || 0,
        critical: summary.criticalIssues || 0,
        serious:  summary.seriousIssues  || 0,
        moderate: summary.moderateIssues || 0,
        minor:    summary.minorIssues    || 0,
      },
      ignored: 0,  // will be updated by the following scan-summary call
    };
  }

  // ── Scan polling ──────────────────────────────────────────────────────────────

  let pollTimer = null;

  function startPolling(auditId) {
    show('scanning');
    const detail = document.getElementById('ada-scan-detail');
    if (detail) detail.textContent = 'Scanning: ' + adaChecker.scanUrl;
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      post('ada_get_scan_status', { auditId }).then(r => {
        if (!r.success) return;
        const d = r.data;

        // Update progress bar
        const prog = d.progress;
        if (prog) {
          const pct = prog.total > 0 ? Math.round((prog.audited / prog.total) * 100) : 0;
          const bar  = document.getElementById('ada-progress-bar');
          if (bar) bar.style.width = pct + '%';
          const lbl = document.getElementById('ada-scan-label');
          if (lbl) {
            if (d.status === 'crawling') {
              lbl.textContent = 'Crawling… found ' + (prog.crawled || 0) + ' pages';
            } else {
              lbl.textContent = 'Auditing… ' + (prog.audited || 0) + ' / ' + (prog.total || '?') + ' pages';
            }
          }
        }

        if (d.status === 'completed') {
          clearInterval(pollTimer);

          // Immediately show raw counts from the poll response — no waiting for DB.
          // This prevents the "all zeros" flash if scan-summary hits the DB before
          // the write lands (race condition right after scan completion).
          if (d.summary && d.summary.totalPages > 0) {
            populateResults(rawSummaryToResults(auditId, d.summary));
          }

          // Then fetch the ignored-adjusted summary (passes auditId so the API can
          // check in-memory sessions if the DB write is still in flight).
          post('ada_get_summary', { auditId }).then(sr => {
            if (sr.success && sr.data?.status !== 'not_scanned' && sr.data?.pagesAudited > 0) {
              populateResults(sr.data);
            }
            // If scan-summary returns not_scanned or 0 pages the raw data shown
            // above stays visible — don't blank the widget.
          });

        } else if (d.status === 'error') {
          clearInterval(pollTimer);
          const em = document.getElementById('ada-error-msg');
          if (em) {
            em.textContent = 'Scan encountered an error. '
              + (d.error || 'The site may not be publicly accessible from the scan server. '
              + 'Check that the URL is correct and not password-protected.');
          }
          const eu = document.getElementById('ada-error-url');
          if (eu) eu.textContent = 'URL scanned: ' + adaChecker.scanUrl;
          show('error');
        }
      });
    }, 5000);
  }

  // ── Init ──────────────────────────────────────────────────────────────────────

  function init() {
    post('ada_get_summary').then(r => {
      if (!r.success) {
        const em = document.getElementById('ada-error-msg');
        if (em) em.textContent = r.data?.message || 'Failed to load scan data.';
        show('error');
        return;
      }

      const d = r.data;
      if (d.status === 'not_scanned') {
        show('none');
      } else {
        populateResults(d);
      }
    }).catch(() => {
      const em = document.getElementById('ada-error-msg');
      if (em) em.textContent = 'Could not reach accessibility API.';
      show('error');
    });

    const rescanBtn   = document.getElementById('ada-btn-rescan');
    const firstScanBtn = document.getElementById('ada-btn-first-scan');
    const retryBtn    = document.getElementById('ada-btn-retry');

    if (rescanBtn)    rescanBtn.addEventListener('click',    () => startScan(rescanBtn));
    if (firstScanBtn) firstScanBtn.addEventListener('click', () => startScan(firstScanBtn));
    if (retryBtn)     retryBtn.addEventListener('click', () => { show('loading'); init(); });
  }

  function startScan(btn) {
    btn.disabled = true;
    show('scanning');
    const bar = document.getElementById('ada-progress-bar');
    if (bar) bar.style.width = '0%';

    post('ada_start_scan').then(r => {
      if (!r.success) {
        btn.disabled = false;
        const em = document.getElementById('ada-error-msg');
        if (em) em.textContent = r.data?.message || 'Failed to start scan.';
        show('error');
        return;
      }
      startPolling(r.data.auditId);
    }).catch(() => {
      btn.disabled = false;
      const em = document.getElementById('ada-error-msg');
      if (em) em.textContent = 'Request failed.';
      show('error');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
