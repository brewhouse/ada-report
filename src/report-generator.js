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
    <div style="margin-bottom:16px;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#f8fafc;border-bottom:1px solid #e2e8f0;">
        <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;background:${SEVERITY_BG[issue.severity]};color:${SEVERITY_COLORS[issue.severity]}">${escapeHtml(issue.severity)}</span>
        <strong style="font-size:14px;color:#1e293b;">${escapeHtml(issue.title)}</strong>
        <span style="margin-left:auto;font-size:12px;color:#64748b;">WCAG ${escapeHtml(issue.wcag)} (${escapeHtml(issue.wcagLevel)})</span>
        ${issue.count > 1 ? `<span style="font-size:12px;color:#64748b;">${issue.count} elements</span>` : ''}
      </div>
      <div style="padding:10px 14px;">
        <p style="margin:0 0 8px;font-size:13px;color:#475569;">${escapeHtml(issue.description)}</p>
        ${issue.elements && issue.elements.length > 0 ? `
          <div style="margin-top:8px;">
            ${issue.elements.slice(0, 3).map(el => `
              <div style="margin-bottom:6px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;padding:6px 10px;">
                <code style="font-size:11px;color:#475569;word-break:break-all;">${escapeHtml(el.snippet || el.selector)}</code>
                ${el.explanation ? `<div style="font-size:11px;color:#64748b;margin-top:2px;">${escapeHtml(el.explanation)}</div>` : ''}
              </div>
            `).join('')}
            ${issue.elements.length > 3 ? `<p style="font-size:12px;color:#94a3b8;margin:4px 0 0;">...and ${issue.elements.length - 3} more elements</p>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

// brandKey: 'planeteria' | 'digitaldeployment' | 'pensionx' | null
// autoprint: if true, adds a window.print() call on load
export function generateReport(session, brandKey = null, autoprint = false) {
  const brand = BRANDS[brandKey] || null;
  const accentColor = brand?.accentColor || '#107DC2';
  const brandName = brand?.name || 'Planeteria Inquiros ADA Checker';

  const { url, summary, pages, startTime, endTime } = session;
  const hostname = new URL(url).hostname;
  const auditDate = new Date(startTime).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const auditTime = endTime
    ? ((new Date(endTime) - new Date(startTime)) / 1000 / 60).toFixed(1)
    : 'N/A';

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
    @page { size: A4 portrait; margin: 10mm; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #1e293b; background: #fff; line-height: 1.45; }
    .page { max-width: 900px; margin: 0 auto; padding: 20px 24px; }
    h1 { font-size: 24px; font-weight: 700; color: #0f172a; }
    h2 { font-size: 17px; font-weight: 700; color: #0f172a; margin: 18px 0 10px; border-bottom: 2px solid #e2e8f0; padding-bottom: 6px; }
    h3 { font-size: 14px; font-weight: 600; color: #1e293b; margin: 12px 0 6px; }
    .cover { text-align: center; padding: 28px 0 20px; border-bottom: 3px solid ${accentColor}; margin-bottom: 20px; }
    .cover-logo { max-height: 48px; max-width: 200px; object-fit: contain; margin: 0 auto 16px; display: block; }
    .cover .logo-text { font-size: 12px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: ${accentColor}; margin-bottom: 14px; }
    .cover h1 { font-size: 26px; margin-bottom: 6px; }
    .cover .site-url { font-size: 15px; color: ${accentColor}; margin-bottom: 4px; }
    .cover .meta { font-size: 12px; color: #64748b; margin-bottom: 16px; }
    .cover .score-wrap { display: inline-block; margin: 12px auto; }
    .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0; }
    .stat-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px; text-align: center; }
    .stat-card .value { font-size: 22px; font-weight: 700; }
    .stat-card .label { font-size: 11px; color: #64748b; margin-top: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
    .severity-bar { display: flex; gap: 12px; margin: 8px 0; flex-wrap: wrap; }
    .sev-item { display: flex; align-items: center; gap: 5px; font-size: 12px; }
    .sev-dot { width: 10px; height: 10px; border-radius: 50%; }
    .score-dist { display: flex; gap: 6px; margin: 8px 0; align-items: center; }
    .dist-bar { height: 20px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; color: #fff; min-width: 28px; padding: 0 6px; }
    .issues-summary table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .issues-summary th { background: #f8fafc; padding: 6px 10px; text-align: left; border: 1px solid #e2e8f0; font-weight: 600; color: #475569; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .issues-summary td { padding: 6px 10px; border: 1px solid #e2e8f0; vertical-align: top; }
    .issues-summary tr:nth-child(even) td { background: #f8fafc; }
    .sev-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .page-section { margin-bottom: 10px; page-break-inside: avoid; }
    .page-header { display: flex; align-items: center; gap: 10px; padding: 7px 12px; border-radius: 6px; }
    .page-header.has-issues { margin-bottom: 8px; }
    .page-url { font-size: 12px; font-weight: 600; word-break: break-all; flex: 1; }
    .page-score-badge { font-size: 15px; font-weight: 700; padding: 3px 9px; border-radius: 5px; white-space: nowrap; flex-shrink: 0; }
    .no-issues-inline { margin-left: auto; font-size: 12px; color: #16a34a; font-weight: 600; white-space: nowrap; flex-shrink: 0; }
    .issue-count-label { margin-left: auto; font-size: 12px; color: #64748b; white-space: nowrap; flex-shrink: 0; }
    .print-btn { position: fixed; top: 16px; right: 16px; background: ${accentColor}; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.2); z-index: 1000; }
    .print-btn:hover { opacity: 0.9; }
    .footer { margin-top: 24px; padding-top: 12px; border-top: 1px solid #e2e8f0; text-align: center; font-size: 11px; color: #94a3b8; }
    @media print {
      .print-btn { display: none; }
      .page { padding: 0; }
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
      <h1>Accessibility Audit Report</h1>
      <div class="site-url">${escapeHtml(url)}</div>
      <div class="meta">Audited on ${auditDate} &bull; Powered by Google Lighthouse</div>
      <div class="score-wrap">${scoreGaugeSvg(avgScore, 140)}</div>
      <div style="font-size:14px;color:#64748b;margin-top:8px;">Overall Accessibility Score</div>
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
        <div class="value">${auditTime} min</div>
        <div class="label">Audit Duration</div>
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
    <div class="score-dist">
      ${summary?.pagesAbove90 ? `<div class="dist-bar" style="background:#16a34a;width:${Math.max(summary.pagesAbove90 * 30, 40)}px">${summary.pagesAbove90} pages ≥90</div>` : ''}
      ${summary?.pages70to89 ? `<div class="dist-bar" style="background:#65a30d;width:${Math.max(summary.pages70to89 * 30, 40)}px">${summary.pages70to89} pages 70–89</div>` : ''}
      ${summary?.pages50to69 ? `<div class="dist-bar" style="background:#d97706;width:${Math.max(summary.pages50to69 * 30, 40)}px">${summary.pages50to69} pages 50–69</div>` : ''}
      ${summary?.pagesBelow50 ? `<div class="dist-bar" style="background:#dc2626;width:${Math.max(summary.pagesBelow50 * 30, 40)}px">${summary.pagesBelow50} pages &lt;50</div>` : ''}
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
      Generated by ${escapeHtml(brandName)} &bull; Powered by Google Lighthouse<br>
      ${escapeHtml(url)} &bull; ${auditDate}
    </div>
  </div>
  ${autoprint ? `<script>window.addEventListener('load', function(){ setTimeout(window.print, 900); });</script>` : ''}
</body>
</html>`;
}
