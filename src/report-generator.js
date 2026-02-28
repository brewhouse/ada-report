const BRANDS = {
  planeteria: {
    name: 'Planeteria',
    logoUrl: 'https://www.planeteria.com/wp-content/uploads/2024/11/logo-1.svg',
    accentColor: '#107DC2',
  },
  digitaldeployment: {
    name: 'Digital Deployment',
    logoUrl: 'https://www.digitaldeployment.com/sites/default/themes/dtheme/img/logo.svg',
    accentColor: '#2563eb',
  },
  pensionx: {
    name: 'PensionX',
    logoUrl: 'https://www.pensionx.com/hubfs/RGB_Pensionx_Logo_FullColor.svg',
    accentColor: '#1e293b',
  },
};

const SEVERITY_COLORS = {
  critical: '#dc2626',
  serious: '#ea580c',
  moderate: '#d97706',
  minor: '#2563eb',
};

const SEVERITY_BG = {
  critical: '#fef2f2',
  serious: '#fff7ed',
  moderate: '#fffbeb',
  minor: '#eff6ff',
};

function scoreColor(score) {
  if (score === null || score === undefined) return '#94a3b8';
  if (score >= 90) return '#16a34a';
  if (score >= 70) return '#65a30d';
  if (score >= 50) return '#d97706';
  return '#dc2626';
}

function scoreBg(score) {
  if (score === null || score === undefined) return '#f1f5f9';
  if (score >= 90) return '#f0fdf4';
  if (score >= 70) return '#f7fee7';
  if (score >= 50) return '#fffbeb';
  return '#fef2f2';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function scoreGaugeSvg(score, size = 120) {
  const color = scoreColor(score);
  const pct = score ?? 0;
  const r = 45;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const dash = (pct / 100) * circumference;
  const gap = circumference - dash;

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="10"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10"
      stroke-dasharray="${dash.toFixed(1)} ${gap.toFixed(1)}"
      stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="22" font-weight="700" fill="${color}" font-family="Arial,sans-serif">${score ?? 'N/A'}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="11" fill="#64748b" font-family="Arial,sans-serif">/ 100</text>
  </svg>`;
}

function renderIssuesTable(issues) {
  if (!issues || issues.length === 0) {
    return '<p style="color:#64748b;font-style:italic;">No accessibility issues detected.</p>';
  }
  return issues.map(issue => `
    <div style="margin-bottom:5px;border:1px solid #e2e8f0;border-radius:5px;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:8px;padding:5px 10px;background:#f8fafc;border-bottom:1px solid #e2e8f0;">
        <span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;background:${SEVERITY_BG[issue.severity]};color:${SEVERITY_COLORS[issue.severity]}">${escapeHtml(issue.severity)}</span>
        <strong style="font-size:12px;color:#1e293b;">${escapeHtml(issue.title)}</strong>
        <span style="margin-left:auto;font-size:10px;color:#64748b;">WCAG ${escapeHtml(issue.wcag)} (${escapeHtml(issue.wcagLevel)})</span>
        ${issue.count > 1 ? `<span style="font-size:10px;color:#64748b;">${issue.count} elements</span>` : ''}
      </div>
      <div style="padding:5px 10px;">
        <p style="margin:0 0 4px;font-size:11px;color:#475569;">${escapeHtml(issue.description)}</p>
        ${issue.elements && issue.elements.length > 0 ? `
          <div style="margin-top:4px;">
            ${issue.elements.slice(0, 3).map(el => `
              <div style="margin-bottom:3px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:3px;padding:3px 8px;">
                <code style="font-size:10px;color:#475569;word-break:break-all;">${escapeHtml(el.snippet || el.selector)}</code>
                ${el.explanation ? `<div style="font-size:10px;color:#64748b;margin-top:1px;">${escapeHtml(el.explanation)}</div>` : ''}
              </div>
            `).join('')}
            ${issue.elements.length > 3 ? `<p style="font-size:10px;color:#94a3b8;margin:2px 0 0;">...and ${issue.elements.length - 3} more elements</p>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

// brandKey: 'planeteria' | 'digitaldeployment' | 'pensionx' | null
// autoprint: if true, adds a window.print() call on load
export function generateSummaryReport(session, brandKey = null, autoprint = false) {
  const brand = BRANDS[brandKey] || null;
  const accentColor = brand?.accentColor || '#107DC2';
  const brandName = brand?.name || 'Planeteria Inquiros ADA Checker';

  const { url, summary, pages, startTime } = session;
  const hostname = new URL(url).hostname;
  const auditDate = new Date(startTime).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const completedPages = pages.filter(p => p.status === 'completed');
  // Sort worst score first so clients see priority pages at top
  const sortedPages = [...completedPages].sort((a, b) => (a.score ?? 101) - (b.score ?? 101));

  // Top issues across all pages (same logic as detail report)
  const issueFrequency = {};
  for (const page of completedPages) {
    for (const issue of (page.issues || [])) {
      if (!issueFrequency[issue.id]) {
        issueFrequency[issue.id] = { ...issue, pageCount: 0, totalElements: 0 };
      }
      issueFrequency[issue.id].pageCount++;
      issueFrequency[issue.id].totalElements += issue.count || 1;
    }
  }
  const topIssues = Object.values(issueFrequency)
    .sort((a, b) => {
      const sev = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      return (sev[a.severity] - sev[b.severity]) || (b.pageCount - a.pageCount);
    })
    .slice(0, 20);

  const avgScore = summary?.averageScore ?? 0;
  const avgColor = scoreColor(avgScore);
  const pagesNoIssues = completedPages.filter(p => !p.issues || p.issues.length === 0).length;
  const pagesBelowScore90 = completedPages.filter(p => p.score !== null && p.score !== undefined && p.score < 90).length;

  const coverLogo = brand
    ? `<img src="${brand.logoUrl}" alt="${escapeHtml(brand.name)}" class="cover-logo">`
    : `<div class="logo-text">Planeteria Inquiros ADA Checker</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADA Accessibility Summary – ${escapeHtml(hostname)}</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1e293b; background: #fff; line-height: 1.4; }
    .page { max-width: 900px; margin: 0 auto; padding: 10px 16px; }
    h2 { font-size: 14px; font-weight: 700; color: #0f172a; margin: 8px 0 5px; border-bottom: 2px solid #e2e8f0; padding-bottom: 3px; }
    h3 { font-size: 12px; font-weight: 600; color: #1e293b; margin: 6px 0 3px; }
    .cover { text-align: center; padding: 14px 0 10px; border-bottom: 3px solid ${accentColor}; margin-bottom: 10px; }
    .cover-logo { max-height: 40px; max-width: 180px; object-fit: contain; margin: 0 auto 8px; display: block; }
    .cover .logo-text { font-size: 11px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: ${accentColor}; margin-bottom: 8px; }
    .cover-title { font-size: 20px; font-weight: 700; color: #0f172a; padding: 14px 24px 10px; display: inline-block; }
    .cover-subtitle { display: block; font-size: 13px; font-weight: 400; color: #64748b; margin-top: 2px; letter-spacing: 0.5px; }
    .cover-site { display: block; font-size: 14px; font-weight: 400; color: ${accentColor}; margin-top: 3px; }
    .cover .meta { font-size: 11px; color: #64748b; margin: 6px 0 8px; }
    .cover .score-wrap { display: inline-block; margin: 6px auto 0; }
    .cover .score-label { font-size: 11px; color: #64748b; margin-top: 4px; }
    .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; margin: 5px 0; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 5px 6px; text-align: center; }
    .stat-card .value { font-size: 17px; font-weight: 700; }
    .stat-card .label { font-size: 9px; color: #64748b; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.4px; }
    .severity-bar { display: flex; gap: 14px; margin: 3px 0; flex-wrap: wrap; }
    .sev-item { display: flex; align-items: center; gap: 5px; font-size: 11px; }
    .sev-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .score-dist-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin: 4px 0; }
    .sd-cell { padding: 7px 6px; text-align: center; border-radius: 4px; }
    .sd-cell .sd-count { display: block; font-size: 20px; font-weight: 700; line-height: 1; }
    .sd-cell .sd-label { display: block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 3px; }
    .sd-green { background: #f0fdf4; color: #16a34a; }
    .sd-lime { background: #f7fee7; color: #65a30d; }
    .sd-amber { background: #fffbeb; color: #d97706; }
    .sd-red { background: #fef2f2; color: #dc2626; }
    .issues-summary table { width: 100%; border-collapse: collapse; font-size: 11px; }
    .issues-summary th { background: #f8fafc; padding: 4px 8px; text-align: left; border: 1px solid #e2e8f0; font-weight: 600; color: #475569; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
    .issues-summary td { padding: 4px 8px; border: 1px solid #e2e8f0; vertical-align: top; }
    .issues-summary tr:nth-child(even) td { background: #f8fafc; }
    .sev-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
    /* Page summary table */
    .pages-table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 4px; }
    .pages-table th { background: #f8fafc; padding: 5px 8px; text-align: left; border: 1px solid #e2e8f0; font-weight: 600; color: #475569; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
    .pages-table td { padding: 5px 8px; border: 1px solid #e2e8f0; vertical-align: middle; }
    .pages-table tr:nth-child(even) td { background: #f8fafc; }
    .score-pill { display: inline-block; padding: 1px 7px; border-radius: 4px; font-weight: 700; font-size: 12px; }
    .print-btn { position: fixed; top: 16px; right: 16px; background: ${accentColor}; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.2); z-index: 1000; }
    .print-btn:hover { opacity: 0.9; }
    .summary-note { font-size: 10px; color: #64748b; font-style: italic; margin: 4px 0 8px; }
    .footer { margin-top: 16px; padding: 14px 0 12px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 10px; color: #94a3b8; }
    @media print {
      .print-btn { display: none; }
      .page { padding: 10mm 12mm; }
    }
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
  <div class="page">

    <!-- Cover -->
    <div class="cover">
      ${coverLogo}
      <div class="cover-title">
        ADA Accessibility Report
        <span class="cover-subtitle">Client Summary</span>
        <span class="cover-site">${escapeHtml(url)}</span>
      </div>
      <div class="meta">Audited on ${auditDate} &bull; Powered by Google Lighthouse</div>
      <div class="score-wrap">${scoreGaugeSvg(avgScore, 120)}</div>
      <div class="score-label">Overall Accessibility Score</div>
    </div>

    <!-- Executive Summary -->
    <h2>Executive Summary</h2>
    <div class="summary-grid">
      <div class="stat-card">
        <div class="value" style="color:${avgColor}">${avgScore}</div>
        <div class="label">Average Score</div>
      </div>
      <div class="stat-card">
        <div class="value">${summary?.totalPages ?? 0}</div>
        <div class="label">Pages Audited</div>
      </div>
      <div class="stat-card">
        <div class="value">${summary?.totalIssues ?? 0}</div>
        <div class="label">Total Issues</div>
      </div>
      <div class="stat-card">
        <div class="value" style="color:#16a34a">${pagesNoIssues}</div>
        <div class="label">Pages No Issues</div>
      </div>
      <div class="stat-card">
        <div class="value" style="color:#dc2626">${pagesBelowScore90}</div>
        <div class="label">Pages Score &lt;90</div>
      </div>
    </div>

    <h3>Issues by Severity</h3>
    <div class="severity-bar">
      <div class="sev-item"><div class="sev-dot" style="background:#dc2626"></div><strong>${summary?.criticalIssues ?? 0}</strong> Critical</div>
      <div class="sev-item"><div class="sev-dot" style="background:#ea580c"></div><strong>${summary?.seriousIssues ?? 0}</strong> Serious</div>
      <div class="sev-item"><div class="sev-dot" style="background:#d97706"></div><strong>${summary?.moderateIssues ?? 0}</strong> Moderate</div>
      <div class="sev-item"><div class="sev-dot" style="background:#2563eb"></div><strong>${summary?.minorIssues ?? 0}</strong> Minor</div>
    </div>

    <h3>Score Distribution</h3>
    <div class="score-dist-grid">
      <div class="sd-cell sd-green"><span class="sd-count">${summary?.pagesAbove90 ?? 0}</span><span class="sd-label">Score ≥90</span></div>
      <div class="sd-cell sd-lime"><span class="sd-count">${summary?.pages70to89 ?? 0}</span><span class="sd-label">Score 70–89</span></div>
      <div class="sd-cell sd-amber"><span class="sd-count">${summary?.pages50to69 ?? 0}</span><span class="sd-label">Score 50–69</span></div>
      <div class="sd-cell sd-red"><span class="sd-count">${summary?.pagesBelow50 ?? 0}</span><span class="sd-label">Score &lt;50</span></div>
    </div>

    <!-- Most Common Issues -->
    ${topIssues.length > 0 ? `
    <h2>Most Common Issues</h2>
    <p class="summary-note">Issues occurring across multiple pages, ranked by severity and frequency.</p>
    <div class="issues-summary">
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Issue</th>
            <th>WCAG</th>
            <th>Pages Affected</th>
            <th>Total Elements</th>
          </tr>
        </thead>
        <tbody>
          ${topIssues.map(issue => `
            <tr>
              <td><span class="sev-badge" style="background:${SEVERITY_BG[issue.severity]};color:${SEVERITY_COLORS[issue.severity]}">${escapeHtml(issue.severity)}</span></td>
              <td>${escapeHtml(issue.title)}</td>
              <td>${escapeHtml(issue.wcag)} (${escapeHtml(issue.wcagLevel)})</td>
              <td>${issue.pageCount}</td>
              <td>${issue.totalElements}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    <!-- Page-by-Page Summary -->
    <h2>Page-by-Page Summary</h2>
    <p class="summary-note">Pages sorted by score (lowest first). For detailed issue breakdowns per page, refer to the Developer Detail Report.</p>
    <table class="pages-table">
      <thead>
        <tr>
          <th style="width:44%">Page URL</th>
          <th style="text-align:center">Score</th>
          <th style="text-align:center">Issues</th>
          <th style="text-align:center;color:#dc2626">Critical</th>
          <th style="text-align:center;color:#ea580c">Serious</th>
          <th style="text-align:center;color:#d97706">Moderate</th>
          <th style="text-align:center;color:#2563eb">Minor</th>
        </tr>
      </thead>
      <tbody>
        ${sortedPages.map(page => {
          const crit = page.issues?.filter(i => i.severity === 'critical').length ?? 0;
          const ser  = page.issues?.filter(i => i.severity === 'serious').length ?? 0;
          const mod  = page.issues?.filter(i => i.severity === 'moderate').length ?? 0;
          const min  = page.issues?.filter(i => i.severity === 'minor').length ?? 0;
          const noIssues = page.issueCount === 0;
          return `
          <tr>
            <td style="word-break:break-all;font-size:10px;">${escapeHtml(page.url)}</td>
            <td style="text-align:center;">
              <span class="score-pill" style="color:${scoreColor(page.score)};background:${scoreBg(page.score)}">${page.score ?? 'N/A'}</span>
            </td>
            <td style="text-align:center;font-weight:${noIssues ? '400' : '700'};color:${noIssues ? '#16a34a' : '#1e293b'}">
              ${noIssues ? '&#10003;' : page.issueCount}
            </td>
            <td style="text-align:center;color:#dc2626;font-weight:${crit > 0 ? '700' : '400'}">${crit > 0 ? crit : '—'}</td>
            <td style="text-align:center;color:#ea580c;font-weight:${ser > 0 ? '700' : '400'}">${ser > 0 ? ser : '—'}</td>
            <td style="text-align:center;color:#d97706;font-weight:${mod > 0 ? '700' : '400'}">${mod > 0 ? mod : '—'}</td>
            <td style="text-align:center;color:#2563eb;font-weight:${min > 0 ? '700' : '400'}">${min > 0 ? min : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>

    ${pages.filter(p => p.status === 'error').length > 0 ? `
    <h2>Pages with Errors</h2>
    <table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:4px;">
      <thead><tr>
        <th style="background:#fef2f2;padding:5px 8px;text-align:left;border:1px solid #fecaca;color:#991b1b;font-size:10px;">URL</th>
        <th style="background:#fef2f2;padding:5px 8px;text-align:left;border:1px solid #fecaca;color:#991b1b;font-size:10px;">Error</th>
      </tr></thead>
      <tbody>
        ${pages.filter(p => p.status === 'error').map(p => `
          <tr>
            <td style="padding:5px 8px;border:1px solid #e2e8f0;word-break:break-all;font-size:10px;">${escapeHtml(p.url)}</td>
            <td style="padding:5px 8px;border:1px solid #e2e8f0;color:#64748b;font-size:10px;">${escapeHtml(p.error || 'Unknown error')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ` : ''}

    <div class="footer">
      Generated by ${escapeHtml(brandName)} &bull; Powered by Google Lighthouse &bull; ${auditDate}
    </div>
  </div>
  ${autoprint ? `<script>window.addEventListener('load', function(){ setTimeout(window.print, 900); });</script>` : ''}
</body>
</html>`;
}

// brandKey: 'planeteria' | 'digitaldeployment' | 'pensionx' | null
// autoprint: if true, adds a window.print() call on load
export function generateReport(session, brandKey = null, autoprint = false) {
  const brand = BRANDS[brandKey] || null;
  const accentColor = brand?.accentColor || '#107DC2';
  const brandName = brand?.name || 'Planeteria Inquiros ADA Checker';

  const { url, summary, pages, startTime } = session;
  const hostname = new URL(url).hostname;
  const auditDate = new Date(startTime).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const completedPages = pages.filter(p => p.status === 'completed');
  const sortedPages = [...completedPages].sort((a, b) => (a.score ?? 101) - (b.score ?? 101));

  // Top issues across all pages
  const issueFrequency = {};
  for (const page of completedPages) {
    for (const issue of (page.issues || [])) {
      if (!issueFrequency[issue.id]) {
        issueFrequency[issue.id] = { ...issue, pageCount: 0, totalElements: 0 };
      }
      issueFrequency[issue.id].pageCount++;
      issueFrequency[issue.id].totalElements += issue.count || 1;
    }
  }
  const topIssues = Object.values(issueFrequency)
    .sort((a, b) => {
      const sev = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      return (sev[a.severity] - sev[b.severity]) || (b.pageCount - a.pageCount);
    })
    .slice(0, 20);

  const avgScore = summary?.averageScore ?? 0;
  const avgColor = scoreColor(avgScore);

  const pagesNoIssues = completedPages.filter(p => !p.issues || p.issues.length === 0).length;
  const pagesBelowScore90 = completedPages.filter(p => p.score !== null && p.score !== undefined && p.score < 90).length;

  // Cover: brand logo or fallback text
  const coverLogo = brand
    ? `<img src="${brand.logoUrl}" alt="${escapeHtml(brand.name)}" class="cover-logo">`
    : `<div class="logo-text">Planeteria Inquiros ADA Checker</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADA Accessibility Report – ${escapeHtml(hostname)}</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1e293b; background: #fff; line-height: 1.4; }
    .page { max-width: 900px; margin: 0 auto; padding: 10px 16px; }
    h2 { font-size: 14px; font-weight: 700; color: #0f172a; margin: 8px 0 5px; border-bottom: 2px solid #e2e8f0; padding-bottom: 3px; }
    h3 { font-size: 12px; font-weight: 600; color: #1e293b; margin: 6px 0 3px; }
    .cover { text-align: center; padding: 14px 0 10px; border-bottom: 3px solid ${accentColor}; margin-bottom: 10px; }
    .cover-logo { max-height: 40px; max-width: 180px; object-fit: contain; margin: 0 auto 8px; display: block; }
    .cover .logo-text { font-size: 11px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: ${accentColor}; margin-bottom: 8px; }
    .cover-title { font-size: 20px; font-weight: 700; color: #0f172a; padding: 14px 24px 10px; display: inline-block; }
    .cover-site { display: block; font-size: 14px; font-weight: 400; color: ${accentColor}; margin-top: 3px; }
    .cover .meta { font-size: 11px; color: #64748b; margin: 6px 0 8px; }
    .cover .score-wrap { display: inline-block; margin: 6px auto 0; }
    .cover .score-label { font-size: 11px; color: #64748b; margin-top: 4px; }
    .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; margin: 5px 0; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 5px 6px; text-align: center; }
    .stat-card .value { font-size: 17px; font-weight: 700; }
    .stat-card .label { font-size: 9px; color: #64748b; margin-top: 2px; text-transform: uppercase; letter-spacing: 0.4px; }
    .severity-bar { display: flex; gap: 14px; margin: 3px 0; flex-wrap: wrap; }
    .sev-item { display: flex; align-items: center; gap: 5px; font-size: 11px; }
    .sev-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .score-dist-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; margin: 4px 0; }
    .sd-cell { padding: 7px 6px; text-align: center; border-radius: 4px; }
    .sd-cell .sd-count { display: block; font-size: 20px; font-weight: 700; line-height: 1; }
    .sd-cell .sd-label { display: block; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 3px; }
    .sd-green { background: #f0fdf4; color: #16a34a; }
    .sd-lime { background: #f7fee7; color: #65a30d; }
    .sd-amber { background: #fffbeb; color: #d97706; }
    .sd-red { background: #fef2f2; color: #dc2626; }
    .issues-summary table { width: 100%; border-collapse: collapse; font-size: 11px; }
    .issues-summary th { background: #f8fafc; padding: 4px 8px; text-align: left; border: 1px solid #e2e8f0; font-weight: 600; color: #475569; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
    .issues-summary td { padding: 4px 8px; border: 1px solid #e2e8f0; vertical-align: top; }
    .issues-summary tr:nth-child(even) td { background: #f8fafc; }
    .sev-badge { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
    .page-section { margin-bottom: 5px; page-break-inside: avoid; }
    .page-header { display: flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 5px; }
    .page-header.has-issues { margin-bottom: 3px; }
    .page-url { font-size: 11px; font-weight: 600; word-break: break-all; flex: 1; }
    .page-score-badge { font-size: 12px; font-weight: 700; padding: 2px 7px; border-radius: 4px; white-space: nowrap; flex-shrink: 0; }
    .no-issues-inline { margin-left: auto; font-size: 11px; color: #16a34a; font-weight: 600; white-space: nowrap; flex-shrink: 0; }
    .issue-count-label { margin-left: auto; font-size: 11px; color: #64748b; white-space: nowrap; flex-shrink: 0; }
    .print-btn { position: fixed; top: 16px; right: 16px; background: ${accentColor}; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.2); z-index: 1000; }
    .print-btn:hover { opacity: 0.9; }
    .footer { margin-top: 16px; padding: 14px 0 12px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 10px; color: #94a3b8; }
    @media print {
      .print-btn { display: none; }
      .page { padding: 10mm 12mm; }
      .page-section { page-break-inside: avoid; }
      h2 { page-break-after: avoid; }
    }
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
  <div class="page">

    <!-- Cover -->
    <div class="cover">
      ${coverLogo}
      <div class="cover-title">ADA Accessibility Report<span class="cover-site">${escapeHtml(url)}</span></div>
      <div class="meta">Audited on ${auditDate} &bull; Powered by Google Lighthouse</div>
      <div class="score-wrap">${scoreGaugeSvg(avgScore, 120)}</div>
      <div class="score-label">Overall Accessibility Score</div>
    </div>

    <!-- Executive Summary -->
    <h2>Executive Summary</h2>
    <div class="summary-grid">
      <div class="stat-card">
        <div class="value" style="color:${avgColor}">${avgScore}</div>
        <div class="label">Average Score</div>
      </div>
      <div class="stat-card">
        <div class="value">${summary?.totalPages ?? 0}</div>
        <div class="label">Pages Audited</div>
      </div>
      <div class="stat-card">
        <div class="value">${summary?.totalIssues ?? 0}</div>
        <div class="label">Total Issues</div>
      </div>
      <div class="stat-card">
        <div class="value" style="color:#16a34a">${pagesNoIssues}</div>
        <div class="label">Pages No Issues</div>
      </div>
      <div class="stat-card">
        <div class="value" style="color:#dc2626">${pagesBelowScore90}</div>
        <div class="label">Pages Score &lt;90</div>
      </div>
    </div>

    <h3>Issues by Severity</h3>
    <div class="severity-bar">
      <div class="sev-item"><div class="sev-dot" style="background:#dc2626"></div><strong>${summary?.criticalIssues ?? 0}</strong> Critical</div>
      <div class="sev-item"><div class="sev-dot" style="background:#ea580c"></div><strong>${summary?.seriousIssues ?? 0}</strong> Serious</div>
      <div class="sev-item"><div class="sev-dot" style="background:#d97706"></div><strong>${summary?.moderateIssues ?? 0}</strong> Moderate</div>
      <div class="sev-item"><div class="sev-dot" style="background:#2563eb"></div><strong>${summary?.minorIssues ?? 0}</strong> Minor</div>
    </div>

    <h3>Score Distribution</h3>
    <div class="score-dist-grid">
      <div class="sd-cell sd-green"><span class="sd-count">${summary?.pagesAbove90 ?? 0}</span><span class="sd-label">Score ≥90</span></div>
      <div class="sd-cell sd-lime"><span class="sd-count">${summary?.pages70to89 ?? 0}</span><span class="sd-label">Score 70–89</span></div>
      <div class="sd-cell sd-amber"><span class="sd-count">${summary?.pages50to69 ?? 0}</span><span class="sd-label">Score 50–69</span></div>
      <div class="sd-cell sd-red"><span class="sd-count">${summary?.pagesBelow50 ?? 0}</span><span class="sd-label">Score &lt;50</span></div>
    </div>

    <!-- Top Issues -->
    ${topIssues.length > 0 ? `
    <h2>Most Common Issues</h2>
    <div class="issues-summary">
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Issue</th>
            <th>WCAG</th>
            <th>Pages Affected</th>
            <th>Total Elements</th>
          </tr>
        </thead>
        <tbody>
          ${topIssues.map(issue => `
            <tr>
              <td><span class="sev-badge" style="background:${SEVERITY_BG[issue.severity]};color:${SEVERITY_COLORS[issue.severity]}">${escapeHtml(issue.severity)}</span></td>
              <td>${escapeHtml(issue.title)}</td>
              <td>${escapeHtml(issue.wcag)} (${escapeHtml(issue.wcagLevel)})</td>
              <td>${issue.pageCount}</td>
              <td>${issue.totalElements}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}

    <!-- Page-by-page Results -->
    <h2>Page-by-Page Results</h2>
    ${sortedPages.map(page => {
      const hasIssues = page.issues && page.issues.length > 0;
      return `
      <div class="page-section">
        <div class="page-header ${hasIssues ? 'has-issues' : ''}" style="background:${scoreBg(page.score)};border:1px solid ${scoreColor(page.score)}33">
          <span class="page-score-badge" style="color:${scoreColor(page.score)};background:${scoreBg(page.score)}">${page.score ?? 'ERR'}</span>
          <span class="page-url">${escapeHtml(page.url)}</span>
          ${hasIssues
            ? `<span class="issue-count-label">${page.issueCount} issue${page.issueCount !== 1 ? 's' : ''}</span>`
            : `<span class="no-issues-inline">&#10003; No accessibility issues detected.</span>`
          }
        </div>
        ${hasIssues ? renderIssuesTable(page.issues) : ''}
      </div>`;
    }).join('')}

    ${pages.filter(p => p.status === 'error').length > 0 ? `
    <h2>Pages with Errors</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead><tr>
        <th style="background:#fef2f2;padding:8px 12px;text-align:left;border:1px solid #fecaca;color:#991b1b;">URL</th>
        <th style="background:#fef2f2;padding:8px 12px;text-align:left;border:1px solid #fecaca;color:#991b1b;">Error</th>
      </tr></thead>
      <tbody>
        ${pages.filter(p => p.status === 'error').map(p => `
          <tr>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;word-break:break-all;">${escapeHtml(p.url)}</td>
            <td style="padding:8px 12px;border:1px solid #e2e8f0;color:#64748b;">${escapeHtml(p.error || 'Unknown error')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    ` : ''}

    <div class="footer">
      Generated by ${escapeHtml(brandName)} &bull; Powered by Google Lighthouse &bull; ${auditDate}
    </div>
  </div>
  ${autoprint ? `<script>window.addEventListener('load', function(){ setTimeout(window.print, 900); });</script>` : ''}
</body>
</html>`;
}
