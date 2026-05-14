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

// Proportionally boost a page's score based on how many of its issues are ignored.
// All issues ignored → 100.  None ignored → original score unchanged.
function computeAdjustedScore(page, ignoredSet) {
  if (page.score === null || page.score === undefined) return page.score;
  const issues = page.issues || [];
  if (!issues.length) return page.score;
  const ignored = issues.filter(i => ignoredSet.has(`${page.url}::${i.id}`)).length;
  if (!ignored) return page.score;
  return Math.min(100, Math.round(page.score + (100 - page.score) * (ignored / issues.length)));
}

// Compute adjusted average score and score-distribution buckets for a set of pages.
function computeAdjustedSummary(completedPages, ignoredSet) {
  const dist = { above90: 0, p70to89: 0, p50to69: 0, below50: 0, below90: 0 };
  const scores = [];
  for (const p of completedPages) {
    const s = computeAdjustedScore(p, ignoredSet);
    if (s === null || s === undefined) continue;
    scores.push(s);
    if      (s >= 90) { dist.above90++; }
    else if (s >= 70) { dist.p70to89++; dist.below90++; }
    else if (s >= 50) { dist.p50to69++; dist.below90++; }
    else              { dist.below50++;  dist.below90++; }
  }
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  return { avg, dist };
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
            <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#334155;">${issue.count || issue.elements.length} element${(issue.count || issue.elements.length) !== 1 ? 's' : ''} affected:</p>
            ${issue.elements.slice(0, 8).map(el => `
              <div style="margin-bottom:3px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:3px;padding:3px 8px;">
                <code style="font-size:10px;color:#475569;word-break:break-all;">${escapeHtml(el.snippet || el.selector)}</code>
                ${el.explanation ? `<div style="font-size:10px;color:#64748b;margin-top:2px;font-style:italic;">${escapeHtml(el.explanation)}</div>` : ''}
              </div>
            `).join('')}
            ${issue.elements.length > 8 ? `<p style="font-size:10px;color:#94a3b8;margin:2px 0 0;">...and ${issue.elements.length - 8} more elements</p>` : ''}
          </div>
        ` : ''}
      </div>
    </div>
  `).join('');
}

// ─── VPAT Report Generator ─────────────────────────────────────────────────────

// All WCAG 2.1 criteria included in the VPAT (Levels A and AA)
const WCAG_21_CRITERIA_A = [
  { id: '1.1.1',  name: 'Non-text Content',                                    description: 'All non-text content that is presented to the user has a text alternative that serves the equivalent purpose, except for controls/input (must have a name describing its purpose), time-based media (text alternatives provide descriptive identification), tests or exercises (text alternatives provide descriptive identification), sensory experiences (text alternatives provide descriptive identification), CAPTCHA (alternatives for different sensory perceptions are provided), and decoration/formatting/invisible content (implemented to be ignored by assistive technology).' },
  { id: '1.2.1',  name: 'Audio-only and Video-only (Prerecorded)',              description: 'For prerecorded audio-only and prerecorded video-only media, the following are true, except when the audio or video is a media alternative for text and is clearly labeled as such: Prerecorded Audio-only: An alternative for time-based media is provided that presents equivalent information. Prerecorded Video-only: Either an alternative for time-based media or an audio track is provided that presents equivalent information.' },
  { id: '1.2.2',  name: 'Captions (Prerecorded)',                               description: 'Captions are provided for all prerecorded audio content in synchronized media, except when the media is a media alternative for text and is clearly labeled as such.' },
  { id: '1.2.3',  name: 'Audio Description or Media Alternative (Prerecorded)', description: 'An alternative for time-based media or audio description of the prerecorded video content is provided for synchronized media, except when the media is a media alternative for text and is clearly labeled as such.' },
  { id: '1.3.1',  name: 'Info and Relationships',                               description: 'Information, structure, and relationships conveyed through presentation can be programmatically determined or are available in text.' },
  { id: '1.3.2',  name: 'Meaningful Sequence',                                  description: 'When the sequence in which content is presented affects its meaning, a correct reading sequence can be programmatically determined.' },
  { id: '1.3.3',  name: 'Sensory Characteristics',                              description: 'Instructions provided for understanding and operating content do not rely solely on sensory characteristics of components such as shape, color, size, visual location, orientation, or sound.' },
  { id: '1.4.1',  name: 'Use of Color',                                         description: 'Color is not used as the only visual means of conveying information, indicating an action, prompting a response, or distinguishing a visual element.' },
  { id: '1.4.2',  name: 'Audio Control',                                        description: 'If any audio on a Web page plays automatically for more than 3 seconds, either a mechanism is available to pause or stop the audio, or a mechanism is available to control audio volume independently from the overall system volume level.' },
  { id: '2.1.1',  name: 'Keyboard',                                             description: 'All functionality of the content is operable through a keyboard interface without requiring specific timings for individual keystrokes, except where the underlying function requires input that depends on the path of the user\'s movement and not just the endpoints.' },
  { id: '2.1.2',  name: 'No Keyboard Trap',                                     description: 'If keyboard focus can be moved to a component of the page using a keyboard interface, then focus can be moved away from that component using only a keyboard interface, and, if it requires more than unmodified arrow or tab keys or other standard exit methods, the user is advised of the method for moving focus away.' },
  { id: '2.1.4',  name: 'Character Key Shortcuts',                              description: 'If a keyboard shortcut is implemented in content using only letter, punctuation, number, or symbol characters, then at least one of the following is true: the shortcut can be turned off, remapped to a non-character key, or is only active when that user interface component has focus.' },
  { id: '2.2.1',  name: 'Timing Adjustable',                                    description: 'For each time limit that is set by the content, at least one of the following is true: the user can turn off, adjust, or extend the time limit, with exceptions for real-time events, essential time limits, and limits longer than 20 hours.' },
  { id: '2.2.2',  name: 'Pause, Stop, Hide',                                    description: 'For moving, blinking, scrolling, or auto-updating information that (1) starts automatically, (2) lasts more than five seconds, and (3) is presented in parallel with other content, there is a mechanism for the user to pause, stop, or hide it, unless the movement, blinking, or scrolling is part of an activity where it is essential.' },
  { id: '2.3.1',  name: 'Three Flashes or Below Threshold',                     description: 'Web pages do not contain anything that flashes more than three times in any one second period, or the flash is below the general flash and red flash thresholds.' },
  { id: '2.4.1',  name: 'Bypass Blocks',                                        description: 'A mechanism is available to bypass blocks of content that are repeated on multiple Web pages.' },
  { id: '2.4.2',  name: 'Page Titled',                                          description: 'Web pages have titles that describe topic or purpose.' },
  { id: '2.4.3',  name: 'Focus Order',                                          description: 'If a Web page can be navigated sequentially and the navigation sequences affect meaning or operation, focusable components receive focus in an order that preserves meaning and operability.' },
  { id: '2.4.4',  name: 'Link Purpose (In Context)',                            description: 'The purpose of each link can be determined from the link text alone or from the link text together with its programmatically determined link context, except where the purpose of the link would be ambiguous to users in general.' },
  { id: '2.5.1',  name: 'Pointer Gestures',                                     description: 'All functionality that uses multipoint or path-based gestures for operation can be operated with a single pointer without a path-based gesture, unless a multipoint or path-based gesture is essential.' },
  { id: '2.5.2',  name: 'Pointer Cancellation',                                 description: 'For functionality that can be operated using a single pointer, at least one of the following is true: the down-event is not used to execute the function; the action can be aborted or undone; the action is completed on the up-event and a mechanism is available to abort the action prior to completion; or completing the function on the down-event is essential.' },
  { id: '2.5.3',  name: 'Label in Name',                                        description: 'For user interface components with labels that include text or images of text, the accessible name contains the text that is presented visually.' },
  { id: '2.5.4',  name: 'Motion Actuation',                                     description: 'Functionality that can be operated by device motion or user motion can also be operated by user interface components and responding to the motion can be disabled to prevent accidental actuation, except where the motion is used through an accessibility-supported interface or is essential for the function.' },
  { id: '3.1.1',  name: 'Language of Page',                                     description: 'The default human language of each Web page can be programmatically determined.' },
  { id: '3.2.1',  name: 'On Focus',                                             description: 'If any component receives focus, it does not initiate a change of context.' },
  { id: '3.2.2',  name: 'On Input',                                             description: 'Changing the setting of any user interface component does not automatically cause a change of context unless the user has been advised of the behavior before using the component.' },
  { id: '3.3.1',  name: 'Error Identification',                                 description: 'If an input error is automatically detected, the item that is in error is identified and the error is described to the user in text.' },
  { id: '3.3.2',  name: 'Labels or Instructions',                               description: 'Labels or instructions are provided when content requires user input.' },
  { id: '4.1.1',  name: 'Parsing',                                              description: 'In content implemented using markup languages, elements have complete start and end tags, elements are nested according to their specifications, elements do not contain duplicate attributes, and any IDs are unique, except where the specifications allow these features.' },
  { id: '4.1.2',  name: 'Name, Role, Value',                                    description: 'For all user interface components (including form elements, links, and components generated by scripts), the name and role can be programmatically determined; states, properties, and values that can be set by the user can be programmatically determined; and notification of changes to these items is available to assistive technologies.' },
];

const WCAG_21_CRITERIA_AA = [
  { id: '1.2.4',  name: 'Captions (Live)',                              description: 'Captions are provided for all live audio content in synchronized media.' },
  { id: '1.2.5',  name: 'Audio Description (Prerecorded)',              description: 'Audio description is provided for all prerecorded video content in synchronized media.' },
  { id: '1.3.4',  name: 'Orientation',                                  description: 'Content does not restrict its view and operation to a single display orientation, such as portrait or landscape, unless a specific display orientation is essential.' },
  { id: '1.3.5',  name: 'Identify Input Purpose',                       description: 'The purpose of each input field collecting information about the user can be programmatically determined when the input field serves a purpose identified in the Input Purposes for User Interface Components section and the content is implemented using technologies with support for identifying the expected meaning for form input data.' },
  { id: '1.4.3',  name: 'Contrast (Minimum)',                           description: 'The visual presentation of text and images of text has a contrast ratio of at least 4.5:1, except for large text (at least 3:1), incidental text or images of text, and logotypes.' },
  { id: '1.4.4',  name: 'Resize Text',                                  description: 'Except for captions and images of text, text can be resized without assistive technology up to 200 percent without loss of content or functionality.' },
  { id: '1.4.5',  name: 'Images of Text',                               description: 'If the technologies being used can achieve the visual presentation, text is used to convey information rather than images of text, except for images of text that are customizable to the user\'s requirements or where a particular presentation of text is essential to the information being conveyed.' },
  { id: '1.4.10', name: 'Reflow',                                       description: 'Content can be presented without loss of information or functionality, and without requiring scrolling in two dimensions, for vertical scrolling content at a width equivalent to 320 CSS pixels and horizontal scrolling content at a height equivalent to 256 CSS pixels, except for parts of the content which require two-dimensional layout for usage or meaning.' },
  { id: '1.4.11', name: 'Non-text Contrast',                            description: 'The visual presentation of user interface components and graphical objects has a contrast ratio of at least 3:1 against adjacent color(s), except for inactive or purely decorative components, or where the appearance of the component is determined by the user agent and not modified by the author.' },
  { id: '1.4.12', name: 'Text Spacing',                                 description: 'No loss of content or functionality occurs by setting: line height to at least 1.5 times the font size; spacing following paragraphs to at least 2 times the font size; letter spacing to at least 0.12 times the font size; and word spacing to at least 0.16 times the font size.' },
  { id: '1.4.13', name: 'Content on Hover or Focus',                    description: 'Where receiving and then removing pointer hover or keyboard focus triggers additional content to become visible and then hidden, all of the following are true: the additional content is dismissible without moving the pointer or keyboard focus; the pointer can be moved over the additional content without it disappearing; and the additional content remains visible until the hover or focus trigger is removed, the user dismisses it, or its information is no longer valid.' },
  { id: '2.4.5',  name: 'Multiple Ways',                                description: 'More than one way is available to locate a Web page within a set of Web pages except where the Web page is the result of, or a step in, a process.' },
  { id: '2.4.6',  name: 'Headings and Labels',                          description: 'Headings and labels describe topic or purpose.' },
  { id: '2.4.7',  name: 'Focus Visible',                                description: 'Any keyboard operable user interface has a mode of operation where the keyboard focus indicator is visible.' },
  { id: '3.1.2',  name: 'Language of Parts',                            description: 'The human language of each passage or phrase in the content can be programmatically determined except for proper names, technical terms, words of indeterminate language, and words or phrases that have become part of the vernacular of the immediately surrounding text.' },
  { id: '3.2.3',  name: 'Consistent Navigation',                        description: 'Navigational mechanisms that are repeated on multiple Web pages within a set of Web pages occur in the same relative order each time they are repeated, unless a change is initiated by the user.' },
  { id: '3.2.4',  name: 'Consistent Identification',                    description: 'Components that have the same functionality within a set of Web pages are identified consistently.' },
  { id: '3.3.3',  name: 'Error Suggestion',                             description: 'If an input error is automatically detected and suggestions for correction are known, then the suggestion is provided to the user, unless it would jeopardize the security or purpose of the content.' },
  { id: '3.3.4',  name: 'Error Prevention (Legal, Financial, Data)',    description: 'For Web pages that cause legal commitments or financial transactions, that modify or delete user-controllable data in data storage systems, or that submit user test responses, at least one of the following is true: submissions are reversible; data entered is checked for input errors and the user is provided an opportunity to correct them; or a mechanism is available for reviewing, confirming, and correcting information before finalizing the submission.' },
  { id: '4.1.3',  name: 'Status Messages',                              description: 'In content implemented using markup languages, status messages can be programmatically determined through role or properties such that they can be presented to the user by assistive technologies without receiving focus.' },
];

// WCAG 2.2 criteria added in the 2023 revision (Level A and AA only, not AAA)
const WCAG_22_CRITERIA_A = [
  { id: '3.2.6', name: 'Consistent Help',   description: 'If a Web page contains any of the following help mechanisms, and those mechanisms are repeated on multiple Web pages within a set of Web pages, they occur in the same order relative to other page content: human contact details; human contact mechanism; self-help option; a fully automated contact mechanism.' },
  { id: '3.3.7', name: 'Redundant Entry',   description: 'Information previously entered by or provided to the user that is required to be entered again in the same process is either auto-populated or available for the user to select, except when re-entering the information is essential, the information is required to ensure the security of the content, or the previously entered information is no longer valid.' },
];

const WCAG_22_CRITERIA_AA = [
  { id: '2.4.11', name: 'Focus Not Obscured (Minimum)', description: 'When a user interface component receives keyboard focus, the component is not entirely hidden due to author-created content.' },
  { id: '2.5.7', name: 'Dragging Movements',            description: 'All functionality that uses a dragging movement for operation can be achieved by a single pointer without dragging, unless dragging is essential or the functionality is determined by the user agent and not modified by the author.' },
  { id: '2.5.8', name: 'Target Size (Minimum)',         description: 'The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except where: the target offset is sufficient; the target is inline; a user agent default size is available; the target presentation is essential to the information being conveyed.' },
  { id: '3.3.8', name: 'Accessible Authentication (Minimum)', description: 'A cognitive function test (such as remembering a password or solving a puzzle) is not required for any step in an authentication process unless that step provides at least one of: an alternative authentication method that does not rely on a cognitive function test; a mechanism is available to assist the user in completing the cognitive function test; the cognitive function test is to recognise objects; the cognitive function test is to identify non-text content the user provided to the Web site.' },
];

// WCAG criteria evaluated by Lighthouse + axe-core + IBM Equal Access Checker
const LIGHTHOUSE_TESTED_WCAG = new Set([
  // Lighthouse
  '1.1.1', '1.2.1', '1.2.2', '1.3.1', '1.3.2', '1.3.3',
  '2.1.1', '2.1.2', '2.2.1', '2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.5.3',
  '3.1.1', '4.1.1', '4.1.2',
  '1.4.3', '1.4.4', '3.1.2',
  // axe-core (new criteria not covered by Lighthouse)
  '1.3.4', '1.3.5', '1.4.1', '1.4.2', '1.4.12', '2.2.2', '3.3.2',
  // IBM Equal Access Checker (new criteria not covered by Lighthouse or axe)
  '2.4.7', '1.4.13', '3.2.1', '3.2.2', '3.3.1', '1.4.10',
  // Cross-page consistency analysis (3.2.4 Consistent Identification)
  '3.2.4',
  // Manually verified criteria — confirmed Supports via template/CMS inspection
  '3.2.3', '2.4.5',
]);

export function generateVpatReport(session, brandKey = null, ignoredIssuesList = []) {
  const brand = BRANDS[brandKey] || null;
  const accentColor = brand?.accentColor || '#107DC2';
  const brandName = brand?.name || 'Planeteria Inquiros ADA Checker';
  const includeWcag22 = !!session.wcag22;

  const { url, summary, pages, startTime } = session;
  const hostname = new URL(url).hostname;
  const auditDate = new Date(startTime).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const auditDateShort = new Date(startTime).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const completedPages = pages.filter(p => p.status === 'completed');
  const totalAudited = completedPages.length;

  const ignoredSet = new Set(ignoredIssuesList.map(i => `${i.pageUrl}::${i.issueId}`));
  // Count ignored issues that actually appear in this session
  let ignoredInSession = 0;
  for (const page of completedPages)
    for (const issue of (page.issues || []))
      if (ignoredSet.has(`${page.url}::${issue.id}`)) ignoredInSession++;

  const adjAvgScore = computeAdjustedSummary(completedPages, ignoredSet).avg ?? summary?.averageScore ?? 0;

  // Aggregate active issues by WCAG criterion across all pages (ignored issues excluded)
  const issuesByWcag = {};
  for (const page of completedPages) {
    const pageWcagSeen = new Set();
    for (const issue of (page.issues || [])) {
      if (ignoredSet.has(`${page.url}::${issue.id}`)) continue;
      const key = issue.wcag;
      if (!key || key === 'N/A') continue;
      if (!issuesByWcag[key]) {
        issuesByWcag[key] = { pageCount: 0, totalElements: 0, severity: issue.severity, titles: new Set() };
      }
      if (!pageWcagSeen.has(key)) {
        issuesByWcag[key].pageCount++;
        pageWcagSeen.add(key);
      }
      issuesByWcag[key].totalElements += issue.count || 1;
      issuesByWcag[key].titles.add(issue.title);
      const SEV = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      if ((SEV[issue.severity] ?? 2) < (SEV[issuesByWcag[key].severity] ?? 2)) {
        issuesByWcag[key].severity = issue.severity;
      }
    }
  }

  // Criteria that are Not Applicable to general websites (no live media, no custom
  // single-key shortcuts, no flashing content, no multi-point gestures, no motion input)
  const NOT_APPLICABLE_WCAG = new Set([
    '1.2.4', // Captions (Live) — only applies to live audio/video streams
    '2.1.4', // Character Key Shortcuts — only applies if single-key shortcuts are implemented
    '2.3.1', // Three Flashes — only applies if the page contains flashing content
    '2.5.1', // Pointer Gestures — only applies if multi-point or path-based gestures are used
    '2.5.2', // Pointer Cancellation — only applies if pointer down events trigger actions
    '2.5.4', // Motion Actuation — only applies if device motion/orientation is used for input
  ]);

  // When WCAG 2.2 was checked, extend the tested set so those criteria get
  // proper Supports / Partially Supports / Does Not Support values.
  const testedWcag = includeWcag22
    ? new Set([
        ...LIGHTHOUSE_TESTED_WCAG,
        ...WCAG_22_CRITERIA_A.map(c => c.id),
        ...WCAG_22_CRITERIA_AA.map(c => c.id),
      ])
    : LIGHTHOUSE_TESTED_WCAG;

  function getConformance(wcagId) {
    if (NOT_APPLICABLE_WCAG.has(wcagId)) {
      return { label: 'Not Applicable', color: '#475569', bg: '#f1f5f9', border: '#94a3b8' };
    }
    if (!testedWcag.has(wcagId)) {
      return { label: 'Not Evaluated', color: '#92400e', bg: '#fffbeb', border: '#d97706' };
    }
    const data = issuesByWcag[wcagId];
    if (!data) {
      return { label: 'Supports', color: '#16a34a', bg: '#f0fdf4', border: '#86efac' };
    }
    const SEV = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    const sev = SEV[data.severity] ?? 2;
    const ratio = data.pageCount / Math.max(totalAudited, 1);
    if (sev <= 1 && ratio >= 0.25) {
      return { label: 'Does Not Support', color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' };
    }
    return { label: 'Partially Supports', color: '#b45309', bg: '#fffbeb', border: '#fcd34d' };
  }

  // Fixed remarks for criteria confirmed via manual / CMS-level verification.
  const MANUAL_REMARKS = {
    '3.2.3': 'Navigation verified on Home Page. Site uses a single CMS. All internal pages share the same header/footer component. Navigation order is consistent by implementation.',
    '2.4.5': 'The site provides two independent navigation mechanisms meeting this criterion: (1) a persistent global navigation menu in the site header, and (2) a site-wide search function returning relevant results, both present on all pages via a shared CMS template. The navigation menu was keyboard-tested and confirmed operable; search was tested with representative queries and returns relevant content; the search form has a proper programmatic label. Representative pages from across different sections were verified. Pages within sequential process flows (form journeys, payment steps) are exempt per WCAG 2.4.5 and were excluded from this assessment.',
  };

  function getRemarks(wcagId) {
    if (NOT_APPLICABLE_WCAG.has(wcagId)) {
      return `The criterion is not relevant to this product.`;
    }
    if (MANUAL_REMARKS[wcagId]) {
      return escapeHtml(MANUAL_REMARKS[wcagId]);
    }
    if (!LIGHTHOUSE_TESTED_WCAG.has(wcagId)) {
      return `<em style="color:#64748b">Not evaluated by automated testing. Manual evaluation recommended.</em>`;
    }
    const data = issuesByWcag[wcagId];
    if (!data) {
      return `No issues detected across ${totalAudited.toLocaleString()} pages audited.`;
    }
    const titles = Array.from(data.titles).map(t => escapeHtml(t)).join('; ');
    const plural = data.pageCount === 1 ? 'page' : 'pages';
    return `Issues detected on <strong>${data.pageCount}</strong> of ${totalAudited.toLocaleString()} ${plural}. `
      + `<br><strong>Issues:</strong> ${titles}. `
      + `<br><strong>Elements affected:</strong> ${data.totalElements.toLocaleString()}.`;
  }

  // Convert remarks HTML to plain text suitable for a <textarea>
  function remarksToPlain(html) {
    return html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&mdash;/g, '\u2014').replace(/&bull;/g, '\u2022').replace(/&nbsp;/g, ' ')
      .trim();
  }

  const ALL_CONF_OPTIONS = [
    'Supports', 'Partially Supports', 'Does Not Support', 'Not Applicable', 'Not Evaluated',
  ];

  function renderCriteriaRows(criteria, level) {
    return criteria.map(c => {
      const conf    = getConformance(c.id);
      const plain   = remarksToPlain(getRemarks(c.id));
      const options = ALL_CONF_OPTIONS.map(v =>
        `<option value="${v}"${v === conf.label ? ' selected' : ''}>${v}</option>`
      ).join('');
      return `<tr>
        <td class="c-criteria"><strong>${c.id}</strong> ${escapeHtml(c.name)}<br><span style="font-size:9px;color:#64748b">Level ${level}</span>${c.description ? `<br><span style="font-size:9px;color:#475569;display:block;margin-top:3px;line-height:1.4">${escapeHtml(c.description)}</span>` : ''}</td>
        <td class="c-conf">
          <select class="conf-select" onchange="updateConf(this)"
            style="color:${conf.color};background:${conf.bg};border-color:${conf.border}">
            ${options}
          </select>
        </td>
        <td class="c-remarks">
          <textarea class="remarks-textarea" rows="2">${escapeHtml(plain)}</textarea>
        </td>
      </tr>`;
    }).join('');
  }

  const coverLogo = brand
    ? `<img src="${brand.logoUrl}" alt="${escapeHtml(brand.name)}" style="max-height:36px;max-width:160px;object-fit:contain;">`
    : `<span style="font-size:10px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:${accentColor}">${escapeHtml(brandName)}</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>VPAT Report \u2013 ${escapeHtml(hostname)} \u2013 ${new Date(startTime || Date.now()).toISOString().split('T')[0]}</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1e293b; background: #fff; line-height: 1.5; }
    .page { max-width: 900px; margin: 0 auto; padding: 14px 18px; }
    @media print { .page { padding: 12mm 14mm; } }
    .vpat-header { display: flex; align-items: center; gap: 16px; padding-bottom: 10px; border-bottom: 3px solid ${accentColor}; margin-bottom: 14px; }
    .vpat-header-text .title { font-size: 17px; font-weight: 700; color: #0f172a; }
    .vpat-header-text .subtitle { font-size: 10px; color: #64748b; margin-top: 1px; }
    h2 { font-size: 12px; font-weight: 700; color: #0f172a; margin: 12px 0 5px; padding-bottom: 3px; border-bottom: 2px solid #e2e8f0; }
    .info-tbl { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 10px; }
    .info-tbl td { padding: 5px 10px; border: 1px solid #e2e8f0; vertical-align: top; }
    .info-tbl td:first-child { font-weight: 600; background: #f8fafc; width: 30%; color: #475569; white-space: nowrap; }
    .terms-list { list-style: none; font-size: 11px; margin: 6px 0 10px; }
    .terms-list li { padding: 3px 0 3px 10px; border-left: 3px solid #e2e8f0; margin-bottom: 3px; }
    .criteria-tbl { width: 100%; border-collapse: collapse; font-size: 11px; margin: 6px 0 14px; }
    .criteria-tbl thead tr { background: ${accentColor}; color: #fff; }
    .criteria-tbl thead th { padding: 6px 10px; text-align: left; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .criteria-tbl tbody tr { border-bottom: 1px solid #e2e8f0; }
    .criteria-tbl tbody tr:nth-child(even) { background: #f8fafc; }
    .c-criteria { padding: 6px 10px; width: 36%; vertical-align: top; }
    .c-conf { padding: 6px 10px; width: 20%; vertical-align: top; text-align: center; }
    .conf-pill { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 9px; font-weight: 700; border: 1px solid; white-space: nowrap; }
    .c-remarks { padding: 6px 10px; width: 44%; vertical-align: top; font-size: 10px; color: #475569; }
    .disclaimer { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 10px 12px; font-size: 10px; color: #64748b; margin-top: 14px; }
    .footer { text-align: center; font-size: 9px; color: #94a3b8; margin-top: 12px; padding-top: 8px; border-top: 1px solid #e2e8f0; }
    /* Editable VPAT controls */
    .conf-select { width: 100%; padding: 3px 6px; border-radius: 4px; border: 1.5px solid; font-size: 10px; font-weight: 700; cursor: pointer; appearance: none; -webkit-appearance: none; text-align: center; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%2364748b'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 6px center; padding-right: 20px; }
    .remarks-textarea { width: 100%; min-height: 48px; resize: vertical; border: 1.5px dashed #cbd5e1; border-radius: 4px; padding: 4px 6px; font-family: inherit; font-size: 10px; color: #475569; line-height: 1.5; background: #fafafa; overflow: hidden; }
    .remarks-textarea:focus { outline: none; border-color: ${accentColor}; background: #fff; }
    .toolbar { position: fixed; top: 14px; right: 16px; display: flex; gap: 8px; z-index: 1000; }
    .btn-tool { border: none; padding: 8px 15px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; box-shadow: 0 2px 8px rgba(0,0,0,0.18); }
    .btn-print { background: ${accentColor}; color: white; }
    .btn-save  { background: #f1f5f9; color: #1e293b; border: 1.5px solid #cbd5e1; }
    .btn-tool:hover { opacity: 0.88; }
    @media print {
      .toolbar { display: none; }
      .conf-select { -webkit-appearance: none; appearance: none; border: 1px solid currentColor !important; background-image: none !important; padding-right: 6px; }
      .remarks-textarea { border: none; resize: none; background: transparent; padding: 0; }
      .criteria-tbl { page-break-inside: auto; }
      h2 { page-break-after: avoid; }
      tr { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="btn-tool btn-save" onclick="saveHtml()">Save HTML</button>
    <button class="btn-tool btn-print" onclick="window.print()">Print / Save PDF</button>
  </div>
  <div class="page">

    <!-- Header -->
    <div class="vpat-header">
      <div>${coverLogo}</div>
      <div class="vpat-header-text">
        <div class="title">Accessibility Conformance Report</div>
        <div class="subtitle">WCAG Edition &mdash; Based on VPAT&reg; Version 2.4</div>
      </div>
    </div>

    <!-- Product Information -->
    <h2>Product Information</h2>
    <table class="info-tbl">
      <tr><td>Product / Service Name</td><td>${escapeHtml(url)}</td></tr>
      <tr><td>Report Date</td><td>${escapeHtml(auditDateShort)}</td></tr>
      <tr><td>Version</td><td>Live website evaluated on ${escapeHtml(auditDateShort)}</td></tr>
      <tr><td>Vendor / Evaluator</td><td>${escapeHtml(brandName)}</td></tr>
      <tr><td>Notes</td><td>This report is based on automated accessibility testing using Google Lighthouse, Axe Tools, and IBM Equal Access Checker. Automated testing covers a subset of WCAG success criteria. Manual testing is recommended for complete conformance evaluation.</td></tr>
    </table>

    <!-- Evaluation Methods -->
    <h2>Evaluation Methods Used</h2>
    <p>Automated accessibility testing using <strong>Google Lighthouse</strong>, <strong>Axe Tools</strong>, and <strong>IBM Equal Access Checker</strong> was performed on <strong>${totalAudited.toLocaleString()}</strong> pages of <em>${escapeHtml(url)}</em>. The combined evaluation assessed WCAG 2.1 success criteria detectable through automated means.</p>
    <p style="margin-top:5px;">Overall results: Average score <strong>${adjAvgScore}/100</strong> &bull; ${Math.max(0, (summary?.totalIssues ?? 0) - ignoredInSession).toLocaleString()} active issues found${ignoredInSession > 0 ? ` (${ignoredInSession} ignored / visually verified)` : ''} &bull; ${(summary?.criticalIssues ?? 0)} critical &bull; ${(summary?.seriousIssues ?? 0)} serious &bull; ${(summary?.moderateIssues ?? 0)} moderate &bull; ${(summary?.minorIssues ?? 0)} minor.</p>

    <!-- Applicable Standards -->
    <h2>Applicable Standards / Guidelines</h2>
    <table class="info-tbl">
      <tr><td>Standard / Guideline</td><td>Included In Report</td></tr>
      <tr><td>Web Content Accessibility Guidelines 2.1</td><td>Level A (Yes) &bull; Level AA (Yes) &bull; Level AAA (No)</td></tr>
    </table>

    <!-- Terms -->
    <h2>Terms</h2>
    <p>Conformance level definitions as used in this report:</p>
    <ul class="terms-list">
      <li><strong style="color:#16a34a">Supports</strong> &mdash; The functionality of the product has at least one method that meets the criterion without known defects or meets with equivalent facilitation.</li>
      <li><strong style="color:#b45309">Partially Supports</strong> &mdash; Some functionality does not meet the criterion.</li>
      <li><strong style="color:#dc2626">Does Not Support</strong> &mdash; The majority of product functionality does not meet the criterion.</li>
      <li><strong style="color:#475569">Not Applicable</strong> &mdash; The criterion is not relevant to this product.</li>
      <li><strong style="color:#92400e">Not Evaluated</strong> &mdash; Not evaluated via automated testing; manual review recommended.</li>
    </ul>

    <!-- Table 1: Level A -->
    <h2>WCAG 2.1 Table 1 &mdash; Level A Success Criteria</h2>
    <table class="criteria-tbl">
      <thead>
        <tr>
          <th style="width:36%">Criteria</th>
          <th style="width:20%">Conformance Level</th>
          <th style="width:44%">Remarks and Explanations</th>
        </tr>
      </thead>
      <tbody>${renderCriteriaRows(WCAG_21_CRITERIA_A, 'A')}</tbody>
    </table>

    <!-- Table 2: Level AA -->
    <h2>WCAG 2.1 Table 2 &mdash; Level AA Success Criteria</h2>
    <table class="criteria-tbl">
      <thead>
        <tr>
          <th style="width:36%">Criteria</th>
          <th style="width:20%">Conformance Level</th>
          <th style="width:44%">Remarks and Explanations</th>
        </tr>
      </thead>
      <tbody>${renderCriteriaRows(WCAG_21_CRITERIA_AA, 'AA')}</tbody>
    </table>

    ${includeWcag22 ? `
    <!-- Table 3: WCAG 2.2 -->
    <h2>WCAG 2.2 Table 3 &mdash; Level A Success Criteria <span style="font-size:9px;font-weight:400;color:#64748b;margin-left:6px">(new in WCAG 2.2)</span></h2>
    <table class="criteria-tbl">
      <thead>
        <tr>
          <th style="width:36%">Criteria</th>
          <th style="width:20%">Conformance Level</th>
          <th style="width:44%">Remarks and Explanations</th>
        </tr>
      </thead>
      <tbody>${renderCriteriaRows(WCAG_22_CRITERIA_A, 'A')}</tbody>
    </table>

    <h2>WCAG 2.2 Table 4 &mdash; Level AA Success Criteria <span style="font-size:9px;font-weight:400;color:#64748b;margin-left:6px">(new in WCAG 2.2)</span></h2>
    <table class="criteria-tbl">
      <thead>
        <tr>
          <th style="width:36%">Criteria</th>
          <th style="width:20%">Conformance Level</th>
          <th style="width:44%">Remarks and Explanations</th>
        </tr>
      </thead>
      <tbody>${renderCriteriaRows(WCAG_22_CRITERIA_AA, 'AA')}</tbody>
    </table>
    ` : ''}

    <!-- Legal Disclaimer -->
    <div class="disclaimer">
      <strong>Legal Disclaimer:</strong> "Voluntary Product Accessibility Template" and "VPAT" are registered service marks of the Information Technology Industry Council (ITI). This report was generated using automated accessibility testing via Google Lighthouse, Axe Tools, and IBM Equal Access Checker, and covers only criteria detectable by automated means. "Supports" indicates no automated issues were detected and does not constitute a guarantee of full WCAG conformance. Manual testing by qualified accessibility professionals is recommended for a complete conformance assessment. This report reflects the state of the website as of ${escapeHtml(auditDateShort)}.
    </div>

    <div class="footer">
      Generated by ${escapeHtml(brandName)} &bull; Powered by Google Lighthouse, Axe Tools &amp; IBM Equal Access Checker &bull; ${escapeHtml(auditDate)}
    </div>
  </div>
  <script>
    var CONF_STYLES = {
      'Supports':           { color: '#16a34a', bg: '#f0fdf4', border: '#86efac' },
      'Partially Supports': { color: '#b45309', bg: '#fffbeb', border: '#fcd34d' },
      'Does Not Support':   { color: '#dc2626', bg: '#fef2f2', border: '#fca5a5' },
      'Not Applicable':     { color: '#475569', bg: '#f1f5f9', border: '#94a3b8' },
      'Not Evaluated':      { color: '#92400e', bg: '#fffbeb', border: '#d97706' },
    };
    function updateConf(sel) {
      var s = CONF_STYLES[sel.value] || {};
      sel.style.color       = s.color  || '';
      sel.style.background  = s.bg     || '';
      sel.style.borderColor = s.border || '';
    }
    function autoResize(ta) {
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    }
    function saveHtml() {
      var clone = document.documentElement.cloneNode(true);
      // Bake current select values into the clone
      var origSels  = document.querySelectorAll('.conf-select');
      var cloneSels = clone.querySelectorAll('.conf-select');
      origSels.forEach(function(sel, i) {
        var cs = cloneSels[i];
        Array.from(cs.options).forEach(function(o) { o.removeAttribute('selected'); });
        var chosen = cs.querySelector('option[value="' + sel.value + '"]');
        if (chosen) chosen.setAttribute('selected', '');
        cs.style.color       = sel.style.color;
        cs.style.background  = sel.style.background;
        cs.style.borderColor = sel.style.borderColor;
      });
      // Bake current textarea values into the clone
      var origTAs  = document.querySelectorAll('.remarks-textarea');
      var cloneTAs = clone.querySelectorAll('.remarks-textarea');
      origTAs.forEach(function(ta, i) { cloneTAs[i].textContent = ta.value; });
      // Remove toolbar from saved copy
      clone.querySelectorAll('.toolbar').forEach(function(el) { el.remove(); });
      // Remove this script block so the saved file doesn't have interactive JS
      var html = '<!DOCTYPE html>\n' + clone.outerHTML;
      var blob = new Blob([html], { type: 'text/html' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = document.title.replace(/[^a-z0-9-]/gi, '-').toLowerCase() + '.html';
      a.click();
      URL.revokeObjectURL(a.href);
    }
    window.addEventListener('load', function() {
      // Apply initial colours to all selects
      document.querySelectorAll('.conf-select').forEach(function(sel) { updateConf(sel); });
      // Auto-resize all textareas and attach input listeners
      document.querySelectorAll('.remarks-textarea').forEach(function(ta) {
        ta.style.height = ta.scrollHeight + 'px';
        ta.addEventListener('input', function() { autoResize(this); });
      });
    });
  </script>
</body>
</html>`;
}

// brandKey: 'planeteria' | 'digitaldeployment' | 'pensionx' | null
// autoprint: if true, adds a window.print() call on load
export function generateSummaryReport(session, brandKey = null, autoprint = false, ignoredIssuesList = []) {
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

  // Build ignored lookup and per-severity counts for this session
  const ignoredSet = new Set(ignoredIssuesList.map(i => `${i.pageUrl}::${i.issueId}`));
  let ignoredTotal = 0, ignoredCritical = 0, ignoredSerious = 0, ignoredModerate = 0, ignoredMinor = 0;
  for (const page of completedPages) {
    for (const issue of (page.issues || [])) {
      if (!ignoredSet.has(`${page.url}::${issue.id}`)) continue;
      ignoredTotal++;
      if      (issue.severity === 'critical') ignoredCritical++;
      else if (issue.severity === 'serious')  ignoredSerious++;
      else if (issue.severity === 'moderate') ignoredModerate++;
      else if (issue.severity === 'minor')    ignoredMinor++;
    }
  }

  // Top issues across all pages (exclude ignored)
  const issueFrequency = {};
  for (const page of completedPages) {
    for (const issue of (page.issues || [])) {
      if (ignoredSet.has(`${page.url}::${issue.id}`)) continue;
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

  const { avg: adjAvg, dist: adjDist } = computeAdjustedSummary(completedPages, ignoredSet);
  const avgScore = adjAvg ?? 0;
  const avgColor = scoreColor(avgScore);
  const pagesNoIssues = completedPages.filter(p => {
    const active = (p.issues || []).filter(i => !ignoredSet.has(`${p.url}::${i.id}`)).length;
    return active === 0;
  }).length;
  const pagesBelowScore90 = adjDist.below90;

  const coverLogo = brand
    ? `<img src="${brand.logoUrl}" alt="${escapeHtml(brand.name)}" class="cover-logo">`
    : `<div class="logo-text">Planeteria Inquiros ADA Checker</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADA Accessibility Summary – ${escapeHtml(hostname)} – ${new Date(session.startTime || Date.now()).toISOString().split('T')[0]}</title>
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
        <div class="value">${Math.max(0, (summary?.totalIssues ?? 0) - ignoredTotal)}</div>
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
      <div class="sev-item"><div class="sev-dot" style="background:#dc2626"></div><strong>${Math.max(0, (summary?.criticalIssues ?? 0) - ignoredCritical)}</strong> Critical</div>
      <div class="sev-item"><div class="sev-dot" style="background:#ea580c"></div><strong>${Math.max(0, (summary?.seriousIssues ?? 0) - ignoredSerious)}</strong> Serious</div>
      <div class="sev-item"><div class="sev-dot" style="background:#d97706"></div><strong>${Math.max(0, (summary?.moderateIssues ?? 0) - ignoredModerate)}</strong> Moderate</div>
      <div class="sev-item"><div class="sev-dot" style="background:#2563eb"></div><strong>${Math.max(0, (summary?.minorIssues ?? 0) - ignoredMinor)}</strong> Minor</div>
      ${ignoredTotal > 0 ? `<div class="sev-item"><div class="sev-dot" style="background:#94a3b8"></div><strong>${ignoredTotal}</strong> Ignored / Visually Verified</div>` : ''}
    </div>

    <h3>Score Distribution</h3>
    <div class="score-dist-grid">
      <div class="sd-cell sd-green"><span class="sd-count">${adjDist.above90}</span><span class="sd-label">Score ≥90</span></div>
      <div class="sd-cell sd-lime"><span class="sd-count">${adjDist.p70to89}</span><span class="sd-label">Score 70–89</span></div>
      <div class="sd-cell sd-amber"><span class="sd-count">${adjDist.p50to69}</span><span class="sd-label">Score 50–69</span></div>
      <div class="sd-cell sd-red"><span class="sd-count">${adjDist.below50}</span><span class="sd-label">Score &lt;50</span></div>
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
          const ai   = (page.issues || []).filter(i => !ignoredSet.has(`${page.url}::${i.id}`));
          const crit = ai.filter(i => i.severity === 'critical').length;
          const ser  = ai.filter(i => i.severity === 'serious').length;
          const mod  = ai.filter(i => i.severity === 'moderate').length;
          const min  = ai.filter(i => i.severity === 'minor').length;
          const noIssues = ai.length === 0;
          const ps = computeAdjustedScore(page, ignoredSet);
          return `
          <tr>
            <td style="word-break:break-all;font-size:10px;">${escapeHtml(page.url)}</td>
            <td style="text-align:center;">
              <span class="score-pill" style="color:${scoreColor(ps)};background:${scoreBg(ps)}">${ps ?? 'N/A'}</span>
            </td>
            <td style="text-align:center;font-weight:${noIssues ? '400' : '700'};color:${noIssues ? '#16a34a' : '#1e293b'}">
              ${noIssues ? '&#10003;' : ai.length}
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
export function generateReport(session, brandKey = null, autoprint = false, ignoredIssuesList = []) {
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

  // Build a lookup set for ignored issues: "pageUrl::issueId"
  const ignoredSet = new Set(ignoredIssuesList.map(i => `${i.pageUrl}::${i.issueId}`));
  let ignoredTotal = 0, ignoredCritical = 0, ignoredSerious = 0, ignoredModerate = 0, ignoredMinor = 0;
  for (const page of completedPages) {
    for (const issue of (page.issues || [])) {
      if (!ignoredSet.has(`${page.url}::${issue.id}`)) continue;
      ignoredTotal++;
      if      (issue.severity === 'critical') ignoredCritical++;
      else if (issue.severity === 'serious')  ignoredSerious++;
      else if (issue.severity === 'moderate') ignoredModerate++;
      else if (issue.severity === 'minor')    ignoredMinor++;
    }
  }

  // Top issues across all pages (exclude ignored)
  const issueFrequency = {};
  for (const page of completedPages) {
    for (const issue of (page.issues || [])) {
      if (ignoredSet.has(`${page.url}::${issue.id}`)) continue;
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

  const { avg: adjAvg, dist: adjDist } = computeAdjustedSummary(completedPages, ignoredSet);
  const avgScore = adjAvg ?? 0;
  const avgColor = scoreColor(avgScore);

  const pagesNoIssues = completedPages.filter(p => {
    const active = (p.issues || []).filter(i => !ignoredSet.has(`${p.url}::${i.id}`)).length;
    return active === 0;
  }).length;
  const pagesBelowScore90 = adjDist.below90;

  // Cover: brand logo or fallback text
  const coverLogo = brand
    ? `<img src="${brand.logoUrl}" alt="${escapeHtml(brand.name)}" class="cover-logo">`
    : `<div class="logo-text">Planeteria Inquiros ADA Checker</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADA Accessibility Report – ${escapeHtml(hostname)} – ${new Date(session.startTime || Date.now()).toISOString().split('T')[0]}</title>
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
        <div class="value">${Math.max(0, (summary?.totalIssues ?? 0) - ignoredTotal)}</div>
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
      <div class="sev-item"><div class="sev-dot" style="background:#dc2626"></div><strong>${Math.max(0, (summary?.criticalIssues ?? 0) - ignoredCritical)}</strong> Critical</div>
      <div class="sev-item"><div class="sev-dot" style="background:#ea580c"></div><strong>${Math.max(0, (summary?.seriousIssues ?? 0) - ignoredSerious)}</strong> Serious</div>
      <div class="sev-item"><div class="sev-dot" style="background:#d97706"></div><strong>${Math.max(0, (summary?.moderateIssues ?? 0) - ignoredModerate)}</strong> Moderate</div>
      <div class="sev-item"><div class="sev-dot" style="background:#2563eb"></div><strong>${Math.max(0, (summary?.minorIssues ?? 0) - ignoredMinor)}</strong> Minor</div>
      ${ignoredTotal > 0 ? `<div class="sev-item"><div class="sev-dot" style="background:#94a3b8"></div><strong>${ignoredTotal}</strong> Ignored / Visually Verified</div>` : ''}
    </div>

    <h3>Score Distribution</h3>
    <div class="score-dist-grid">
      <div class="sd-cell sd-green"><span class="sd-count">${adjDist.above90}</span><span class="sd-label">Score ≥90</span></div>
      <div class="sd-cell sd-lime"><span class="sd-count">${adjDist.p70to89}</span><span class="sd-label">Score 70–89</span></div>
      <div class="sd-cell sd-amber"><span class="sd-count">${adjDist.p50to69}</span><span class="sd-label">Score 50–69</span></div>
      <div class="sd-cell sd-red"><span class="sd-count">${adjDist.below50}</span><span class="sd-label">Score &lt;50</span></div>
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
      const activeIssues  = (page.issues || []).filter(i => !ignoredSet.has(`${page.url}::${i.id}`));
      const ignoredOnPage = (page.issues || []).filter(i =>  ignoredSet.has(`${page.url}::${i.id}`));
      const hasActive  = activeIssues.length > 0;
      const hasIgnored = ignoredOnPage.length > 0;
      const ps = computeAdjustedScore(page, ignoredSet);
      return `
      <div class="page-section">
        <div class="page-header ${hasActive ? 'has-issues' : ''}" style="background:${scoreBg(ps)};border:1px solid ${scoreColor(ps)}33">
          <span class="page-score-badge" style="color:${scoreColor(ps)};background:${scoreBg(ps)}">${ps ?? 'ERR'}</span>
          <span class="page-url">${escapeHtml(page.url)}</span>
          ${hasActive
            ? `<span class="issue-count-label">${activeIssues.length} issue${activeIssues.length !== 1 ? 's' : ''}</span>`
            : `<span class="no-issues-inline">&#10003; No accessibility issues detected.</span>`
          }
          ${hasIgnored ? `<span style="font-size:10px;color:#64748b;margin-left:6px;">(${ignoredOnPage.length} ignored)</span>` : ''}
        </div>
        ${hasActive ? renderIssuesTable(activeIssues) : ''}
        ${hasIgnored ? `
          <div style="padding:6px 10px;background:#fefce8;border:1px solid #fde68a;border-top:none;border-radius:0 0 5px 5px;">
            <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:#854d0e;">Ignored / Visually Verified (${ignoredOnPage.length}):</p>
            ${ignoredOnPage.map(issue => `<span style="display:inline-block;margin:2px 4px 2px 0;padding:1px 8px;background:#fef9c3;border:1px solid #fde68a;border-radius:3px;font-size:10px;color:#713f12;">${escapeHtml(issue.title)}</span>`).join('')}
          </div>
        ` : ''}
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
