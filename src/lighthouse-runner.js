import puppeteer from 'puppeteer';
import { readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { extractLabelsFn } from './consistency-checker.js';

const _require = createRequire(import.meta.url);
// Load axe-core browser bundle once at startup
const axeSource = readFileSync(_require.resolve('axe-core/axe.min.js'), 'utf8');
// Load IBM Equal Access Checker engine once at startup (browser-injectable bundle)
const ibmAceSource = readFileSync(
  new URL('../node_modules/accessibility-checker-engine/ace.js', import.meta.url),
  'utf8'
);

// ── Combined axe-core WCAG rule mapping ───────────────────────────────────────
// All rules run in a single axe.run() call.  This replaces both the old
// Lighthouse WCAG_MAPPING and the supplemental AXE_WCAG_MAPPING.
// Lighthouse's accessibility checks are built on axe-core internally, so
// running axe directly gives equivalent coverage without the heavyweight
// Lighthouse gather/benchmark phase that caused Chrome OOM crashes.
const ALL_AXE_WCAG_MAPPING = {
  // ── 1.1 Text Alternatives ────────────────────────────────────────────────
  'image-alt':                    { wcag: '1.1.1',  level: 'A',   severity: 'critical'  },
  'input-image-alt':              { wcag: '1.1.1',  level: 'A',   severity: 'critical'  },
  'object-alt':                   { wcag: '1.1.1',  level: 'A',   severity: 'serious'   },
  'role-img-alt':                 { wcag: '1.1.1',  level: 'A',   severity: 'serious'   },
  'svg-img-alt':                  { wcag: '1.1.1',  level: 'A',   severity: 'serious'   },
  'aria-meter-name':              { wcag: '1.1.1',  level: 'A',   severity: 'serious'   },
  'aria-progressbar-name':        { wcag: '1.1.1',  level: 'A',   severity: 'serious'   },
  'image-redundant-alt':          { wcag: '1.1.1',  level: 'A',   severity: 'minor'     },
  // ── 1.2 Time-based Media ────────────────────────────────────────────────
  'audio-caption':                { wcag: '1.2.1',  level: 'A',   severity: 'critical'  },
  'video-caption':                { wcag: '1.2.2',  level: 'A',   severity: 'critical'  },
  // ── 1.3 Adaptable ───────────────────────────────────────────────────────
  'label':                        { wcag: '1.3.1',  level: 'A',   severity: 'critical'  },
  'aria-required-children':       { wcag: '1.3.1',  level: 'A',   severity: 'critical'  },
  'aria-required-parent':         { wcag: '1.3.1',  level: 'A',   severity: 'critical'  },
  'definition-list':              { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'dlitem':                       { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'heading-order':                { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'list':                         { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'listitem':                     { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'landmark-one-main':            { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'p-as-heading':                 { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'region':                       { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'table-duplicate-name':         { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'table-fake-caption':           { wcag: '1.3.1',  level: 'A',   severity: 'moderate'  },
  'td-headers-attr':              { wcag: '1.3.1',  level: 'A',   severity: 'serious'   },
  'td-has-header':                { wcag: '1.3.1',  level: 'A',   severity: 'serious'   },
  'th-has-data-cells':            { wcag: '1.3.1',  level: 'A',   severity: 'serious'   },
  'scope-attr-valid':             { wcag: '1.3.1',  level: 'A',   severity: 'serious'   },
  'css-orientation-lock':         { wcag: '1.3.4',  level: 'AA',  severity: 'serious'   },
  'autocomplete-valid':           { wcag: '1.3.5',  level: 'AA',  severity: 'serious'   },
  // ── 1.4 Distinguishable ─────────────────────────────────────────────────
  'link-in-text-block':           { wcag: '1.4.1',  level: 'A',   severity: 'serious'   },
  'no-autoplay-audio':            { wcag: '1.4.2',  level: 'A',   severity: 'serious'   },
  'color-contrast':               { wcag: '1.4.3',  level: 'AA',  severity: 'serious'   },
  'meta-viewport':                { wcag: '1.4.4',  level: 'AA',  severity: 'critical'  },
  'avoid-inline-spacing':         { wcag: '1.4.12', level: 'AA',  severity: 'serious'   },
  // ── 2.1 Keyboard ────────────────────────────────────────────────────────
  'frame-focusable-content':      { wcag: '2.1.1',  level: 'A',   severity: 'serious'   },
  'scrollable-region-focusable':  { wcag: '2.1.1',  level: 'A',   severity: 'serious'   },
  'server-side-image-map':        { wcag: '2.1.1',  level: 'A',   severity: 'moderate'  },
  // ── 2.2 Enough Time ─────────────────────────────────────────────────────
  'meta-refresh':                 { wcag: '2.2.1',  level: 'A',   severity: 'critical'  },
  'blink':                        { wcag: '2.2.2',  level: 'A',   severity: 'serious'   },
  'marquee':                      { wcag: '2.2.2',  level: 'A',   severity: 'serious'   },
  // ── 2.4 Navigable ───────────────────────────────────────────────────────
  'bypass':                       { wcag: '2.4.1',  level: 'A',   severity: 'moderate'  },
  'document-title':               { wcag: '2.4.2',  level: 'A',   severity: 'serious'   },
  'tabindex':                     { wcag: '2.4.3',  level: 'A',   severity: 'serious'   },
  'link-name':                    { wcag: '2.4.4',  level: 'A',   severity: 'serious'   },
  'area-alt':                     { wcag: '2.4.4',  level: 'A',   severity: 'serious'   },
  'identical-links-same-purpose': { wcag: '2.4.9',  level: 'AAA', severity: 'minor'     },
  // ── 2.5 Input Modalities ────────────────────────────────────────────────
  'label-content-name-mismatch':  { wcag: '2.5.3',  level: 'A',   severity: 'serious'   },
  // ── 3.1 Readable ────────────────────────────────────────────────────────
  'html-has-lang':                { wcag: '3.1.1',  level: 'A',   severity: 'serious'   },
  'html-lang-valid':              { wcag: '3.1.1',  level: 'A',   severity: 'serious'   },
  'html-xml-lang-mismatch':       { wcag: '3.1.1',  level: 'A',   severity: 'moderate'  },
  'valid-lang':                   { wcag: '3.1.2',  level: 'AA',  severity: 'moderate'  },
  // ── 3.3 Input Assistance ────────────────────────────────────────────────
  'form-field-multiple-labels':   { wcag: '3.3.2',  level: 'A',   severity: 'moderate'  },
  // ── 4.1 Compatible ──────────────────────────────────────────────────────
  'duplicate-id':                 { wcag: '4.1.1',  level: 'A',   severity: 'moderate'  },
  'duplicate-id-active':          { wcag: '4.1.1',  level: 'A',   severity: 'serious'   },
  'duplicate-id-aria':            { wcag: '4.1.1',  level: 'A',   severity: 'critical'  },
  'aria-allowed-attr':            { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-braille-equivalent':      { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-command-name':            { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-conditional-attr':        { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-deprecated-role':         { wcag: '4.1.2',  level: 'A',   severity: 'moderate'  },
  'aria-hidden-body':             { wcag: '4.1.2',  level: 'A',   severity: 'critical'  },
  'aria-hidden-focus':            { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-input-field-name':        { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-prohibited-attr':         { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-required-attr':           { wcag: '4.1.2',  level: 'A',   severity: 'critical'  },
  'aria-roles':                   { wcag: '4.1.2',  level: 'A',   severity: 'critical'  },
  'aria-roledescription':         { wcag: '4.1.2',  level: 'A',   severity: 'moderate'  },
  'aria-toggle-field-name':       { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-tooltip-name':            { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-treeitem-name':           { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'aria-valid-attr':              { wcag: '4.1.2',  level: 'A',   severity: 'critical'  },
  'aria-valid-attr-value':        { wcag: '4.1.2',  level: 'A',   severity: 'critical'  },
  'button-name':                  { wcag: '4.1.2',  level: 'A',   severity: 'critical'  },
  'frame-title':                  { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'frame-title-unique':           { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'input-button-name':            { wcag: '4.1.2',  level: 'A',   severity: 'critical'  },
  'nested-interactive':           { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
  'select-name':                  { wcag: '4.1.2',  level: 'A',   severity: 'critical'  },
  'summary-name':                 { wcag: '4.1.2',  level: 'A',   severity: 'serious'   },
};

// axe-core rule IDs derived from the mapping above
const ALL_AXE_RULE_IDS = Object.keys(ALL_AXE_WCAG_MAPPING);

// IBM Equal Access Checker rules for WCAG criteria not covered by axe-core.
const IBM_WCAG_MAPPING = {
  // ── WCAG 2.4.7 Focus Visible (Level AA) ─────────────────────────────────────
  'element_tabbable_visible': { wcag: '2.4.7', level: 'AA', severity: 'serious',
    title: 'Focusable element has no visible focus indicator' },
  // ── WCAG 1.4.13 Content on Hover or Focus (Level AA) ────────────────────────
  'style_hover_persistent':   { wcag: '1.4.13', level: 'AA', severity: 'serious',
    title: 'Content appearing on hover or focus is not persistent or dismissable' },
  // ── WCAG 3.2.1 On Focus (Level A) ───────────────────────────────────────────
  'script_focus_blur_review': { wcag: '3.2.1', level: 'A', severity: 'moderate',
    title: 'Verify focus change does not trigger an unexpected context change' },
  'script_select_review':     { wcag: '3.2.1', level: 'A', severity: 'moderate',
    title: 'Verify selection change does not trigger an unexpected context change' },
  // ── WCAG 3.2.2 On Input (Level A) ───────────────────────────────────────────
  'form_interaction_review':  { wcag: '3.2.2', level: 'A', severity: 'moderate',
    title: 'Verify form interaction does not cause an unexpected context change' },
  'input_onchange_review':    { wcag: '3.2.2', level: 'A', severity: 'moderate',
    title: 'Verify input change does not cause an unexpected context change' },
  // ── WCAG 3.3.1 Error Identification (Level A) ───────────────────────────────
  'error_message_exists':     { wcag: '3.3.1', level: 'A', severity: 'moderate',
    title: 'Error messages may not be programmatically associated with form fields' },
  // ── WCAG 1.4.10 Reflow (Level AA) ───────────────────────────────────────────
  'style_viewport_resizable': { wcag: '1.4.10', level: 'AA', severity: 'serious',
    title: 'Viewport meta tag may prevent content reflow at 320px width' },
};

const IBM_RULE_IDS = Object.keys(IBM_WCAG_MAPPING);
const IBM_TIMEOUT_MS = 150_000;

// ── WCAG 2.2 axe rule — only run when wcag22 option is enabled ────────────────
const AXE_WCAG22_MAPPING = {
  'target-size': { wcag: '2.5.8', level: 'AA', severity: 'serious' },
};
const AXE_WCAG22_RULE_IDS = Object.keys(AXE_WCAG22_MAPPING);

const SEVERITY_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

// Score penalty per issue (applied to a base of 100).
// Capped per severity so a single type can't crater the entire score.
const SCORE_PENALTY     = { critical: 5,  serious: 3,  moderate: 1,  minor: 0.5 };
const SCORE_PENALTY_CAP = { critical: 25, serious: 15, moderate: 8,  minor: 4   };

// axe timeout — color-contrast is CPU-intensive, so allow 2 minutes.
const AXE_TIMEOUT_MS = 120_000;

// ── WCAG 2.2 custom Puppeteer checks ─────────────────────────────────────────
// Covers 2.4.11 / 2.5.7 / 3.2.6 / 3.3.7 / 3.3.8 which axe-core does not test.
async function runWcag22Audit(url, browser) {
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(60_000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await new Promise(r => setTimeout(r, 500));

    const raw = await page.evaluate(() => {
      const issues = [];

      // ── 2.4.11 Focus Not Obscured ─────────────────────────────────────────
      const stickyEls = Array.from(document.querySelectorAll('*')).filter(el => {
        const cs = window.getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') return false;
        const r = el.getBoundingClientRect();
        return r.height > 0 && r.top < 10 && r.width > window.innerWidth * 0.4;
      });
      const topObstacleHeight = stickyEls.reduce(
        (max, el) => Math.max(max, el.getBoundingClientRect().bottom), 0
      );
      if (topObstacleHeight > 50) {
        const focusable = Array.from(document.querySelectorAll(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
        ));
        const obscured = focusable.filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.top < topObstacleHeight && r.bottom > 0;
        });
        if (obscured.length > 0) {
          issues.push({
            id: 'wcag22-focus-not-obscured', wcag: '2.4.11', wcagLevel: 'AA', severity: 'serious',
            title: 'Keyboard focus may be fully obscured by a sticky/fixed header',
            description: 'WCAG 2.4.11 requires that focusable components are not entirely hidden by author-created content.',
            count: obscured.length,
            elements: obscured.slice(0, 5).map(el => ({
              snippet: el.outerHTML.substring(0, 200), selector: '', label: '',
              explanation: `May be hidden behind sticky header (${Math.round(topObstacleHeight)}px)`,
            })),
          });
        }
      }

      // ── 2.5.7 Dragging Movements ──────────────────────────────────────────
      const draggables = Array.from(document.querySelectorAll(
        '[draggable="true"],[data-drag-handle],[class*="sortable-handle"],[class*="drag-handle"]'
      )).filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (draggables.length > 0) {
        issues.push({
          id: 'wcag22-dragging-movement', wcag: '2.5.7', wcagLevel: 'AA', severity: 'moderate',
          title: 'Draggable elements detected — ensure a single-pointer alternative exists',
          description: 'WCAG 2.5.7 requires that any functionality using a dragging movement can also be operated with a single pointer without dragging.',
          count: draggables.length,
          elements: draggables.slice(0, 5).map(el => ({
            snippet: el.outerHTML.substring(0, 200), selector: '', label: '',
            explanation: 'Verify that this element can be operated without dragging.',
          })),
        });
      }

      // ── 3.2.6 Consistent Help ─────────────────────────────────────────────
      const HELP_PATTERNS = [
        '[href*="contact"],[href*="support"],[href*="help"],[href*="faq"],[href*="feedback"]',
        '[aria-label*="chat" i],[aria-label*="help" i],[title*="live chat" i]',
        '[class*="live-chat"],[class*="help-button"],[class*="chat-widget"],[id*="chat-button"]',
      ].join(',');
      const helpEls = Array.from(document.querySelectorAll(HELP_PATTERNS))
        .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (helpEls.length > 0) {
        issues.push({
          id: 'wcag22-consistent-help', wcag: '3.2.6', wcagLevel: 'A', severity: 'minor',
          title: 'Help mechanism detected — verify it appears in a consistent location across all pages',
          description: 'WCAG 3.2.6 requires that help mechanisms appear in the same relative order on every page.',
          count: helpEls.length,
          elements: helpEls.slice(0, 3).map(el => ({
            snippet: el.outerHTML.substring(0, 200), selector: '', label: '',
            explanation: 'Check that this help mechanism is in the same relative location on every page.',
          })),
        });
      }

      // ── 3.3.7 Redundant Entry ─────────────────────────────────────────────
      const stepEls = Array.from(document.querySelectorAll(
        '[class*="step-"],[class*="wizard"],[class*="multi-step"],[data-step],[aria-label*="step" i],[class*="progress-step"]'
      )).filter(el => { const r = el.getBoundingClientRect(); return r.width > 0; });
      if (stepEls.length > 0) {
        issues.push({
          id: 'wcag22-redundant-entry', wcag: '3.3.7', wcagLevel: 'A', severity: 'moderate',
          title: 'Multi-step form detected — verify users are not required to re-enter previously provided information',
          description: 'WCAG 3.3.7 requires that information previously entered is auto-populated or available for selection in subsequent steps.',
          count: stepEls.length,
          elements: stepEls.slice(0, 3).map(el => ({
            snippet: el.outerHTML.substring(0, 200), selector: '', label: '',
            explanation: 'Ensure this step does not ask the user to re-enter information already submitted in a prior step.',
          })),
        });
      }

      // ── 3.3.8 Accessible Authentication ──────────────────────────────────
      const captchaEls = Array.from(document.querySelectorAll(
        '[class*="captcha" i],[id*="captcha" i],iframe[src*="captcha"],iframe[src*="recaptcha"],iframe[src*="hcaptcha"],[class*="g-recaptcha"],[class*="h-captcha"],[data-widget-type="CHECKBOX"]'
      ));
      const hasAuthForm = !!document.querySelector(
        'input[type="password"],input[name*="login" i],input[name*="email" i][form],form input[autocomplete="current-password"]'
      );
      if (captchaEls.length > 0 && hasAuthForm) {
        issues.push({
          id: 'wcag22-accessible-auth', wcag: '3.3.8', wcagLevel: 'AA', severity: 'serious',
          title: 'Authentication form contains a CAPTCHA that may require a cognitive function test',
          description: 'WCAG 3.3.8 prohibits cognitive function tests as the only authentication method unless an alternative is provided.',
          count: captchaEls.length,
          elements: captchaEls.slice(0, 3).map(el => ({
            snippet: el.outerHTML.substring(0, 200), selector: '', label: '',
            explanation: 'Ensure a CAPTCHA-free login method is also available.',
          })),
        });
      }

      return issues;
    });

    return raw;
  } finally {
    await Promise.race([
      page.close().catch(() => {}),
      new Promise(r => setTimeout(r, 5_000)),
    ]);
  }
}

// ── Mobile viewport audit (320px) ────────────────────────────────────────────
// Runs axe at 320 CSS pixels wide — the WCAG 1.4.10 Reflow reference width
// (equivalent to a 1280px display zoomed to 400%).  Catches issues that only
// appear at narrow widths: horizontal overflow, elements hidden by responsive
// CSS, contrast changes driven by media queries, etc.
// Returns { reflowIssues, violations } — raw violations so the caller can
// deduplicate against desktop findings before building issue objects.
async function runMobileAxeAudit(url, browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 320, height: 640, isMobile: true });
    await page.setDefaultNavigationTimeout(120_000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await new Promise(r => setTimeout(r, 1500));

    // ── WCAG 1.4.10 Reflow check ─────────────────────────────────────────
    // At 320px, content must not require horizontal scrolling.
    const reflowIssues = await page.evaluate(() => {
      const vw = window.innerWidth; // 320
      if (document.documentElement.scrollWidth <= vw) return [];

      // Find body children that extend beyond the viewport
      const offenders = Array.from(document.body.querySelectorAll('*')).filter(el => {
        const rect = el.getBoundingClientRect();
        const cs   = window.getComputedStyle(el);
        return (
          rect.right > vw &&
          rect.width  > 0 &&
          rect.height > 0 &&
          cs.display    !== 'none' &&
          cs.visibility !== 'hidden' &&
          cs.position   !== 'fixed' &&
          cs.overflowX  !== 'hidden'
        );
      }).slice(0, 8);

      return [{
        id:          'wcag14-reflow',
        title:       'Page requires horizontal scrolling at 320px width',
        description: 'WCAG 1.4.10 Reflow requires that content can be presented at 320 CSS pixels wide without horizontal scrolling or loss of content.',
        wcag:        '1.4.10',
        wcagLevel:   'AA',
        severity:    'serious',
        score:       0,
        displayValue: `${offenders.length || 1} element${offenders.length !== 1 ? 's' : ''} overflow`,
        count:       offenders.length || 1,
        elements:    offenders.map(el => ({
          snippet:     el.outerHTML.substring(0, 200),
          selector:    el.id ? `#${el.id}` : el.tagName.toLowerCase() + (el.className ? `.${[...el.classList][0] || ''}` : ''),
          label:       '',
          explanation: `Element extends to ${Math.round(el.getBoundingClientRect().right)}px at 320px viewport`,
        })),
      }];
    });

    // ── axe at mobile viewport ────────────────────────────────────────────
    await page.evaluate(axeSource);

    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('Mobile axe-core timed out after 120s')),
        AXE_TIMEOUT_MS
      );
    });
    let results;
    try {
      results = await Promise.race([
        page.evaluate(async (ruleIds) => {
          return await window.axe.run(document, {
            runOnly: { type: 'rule', values: ruleIds },
            resultTypes: ['violations'],
          });
        }, ALL_AXE_RULE_IDS),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    return { reflowIssues, violations: results?.violations || [] };
  } finally {
    await Promise.race([
      page.close().catch(() => {}),
      new Promise(r => setTimeout(r, 5_000)),
    ]);
  }
}

// ── axe-core audit (primary engine) ──────────────────────────────────────────
// Runs all WCAG rules in ALL_AXE_WCAG_MAPPING in a single pass.
// Also extracts interactive element labels for WCAG 3.2.4 cross-page analysis.
// Returns { issues, interactiveLabels }.
async function runFullAxeAudit(url, browser) {
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(120_000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    // Give JS frameworks time to render initial content.
    await new Promise(r => setTimeout(r, 1500));

    // Extract interactive labels for 3.2.4 BEFORE axe injection.
    let interactiveLabels = [];
    try {
      interactiveLabels = await page.evaluate(extractLabelsFn);
    } catch (e) {
      // Non-fatal — consistency check for this page will be skipped
    }

    // Extract supplemental page data: forms, iframes, and links.
    // Used to power the "List pages with forms/iframes" and "Check broken links" features.
    // isGlobal=true means the element lives in a site-wide header/footer/nav.
    let supplementalData = { forms: [], iframes: [], links: [] };
    try {
      supplementalData = await page.evaluate(() => {
        function isInGlobal(el) {
          let node = el.parentElement;
          while (node && node !== document.body) {
            const tag  = node.tagName?.toLowerCase();
            const role = node.getAttribute?.('role')?.toLowerCase();
            if (tag === 'header' || tag === 'footer' || tag === 'nav' ||
                role === 'banner' || role === 'contentinfo' || role === 'navigation') return true;
            node = node.parentElement;
          }
          return false;
        }

        const forms = Array.from(document.querySelectorAll('form')).map(f => ({
          snippet: f.outerHTML.substring(0, 150),
          isGlobal: isInGlobal(f),
        }));

        const iframes = Array.from(document.querySelectorAll('iframe')).map(fr => ({
          src: fr.src || fr.getAttribute('data-src') || '',
          title: fr.title || fr.getAttribute('aria-label') || '',
          isGlobal: isInGlobal(fr),
        }));

        const links = Array.from(document.querySelectorAll('a[href]'))
          .map(a => a.href)
          .filter(h => h && (h.startsWith('http://') || h.startsWith('https://')));

        return { forms, iframes, links };
      });
    } catch (e) {
      // Non-fatal — supplemental features will skip this page
    }

    // Inject axe-core
    await page.evaluate(axeSource);

    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('axe-core timed out after 120s')),
        AXE_TIMEOUT_MS
      );
    });

    let results;
    try {
      results = await Promise.race([
        page.evaluate(async (ruleIds) => {
          return await window.axe.run(document, {
            runOnly: { type: 'rule', values: ruleIds },
            resultTypes: ['violations'],
          });
        }, ALL_AXE_RULE_IDS),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    const issues = [];
    for (const violation of (results?.violations || [])) {
      const wcagInfo = ALL_AXE_WCAG_MAPPING[violation.id];
      if (!wcagInfo) continue;
      const elements = violation.nodes.slice(0, 8).map(node => ({
        snippet: node.html || '',
        selector: (node.target || []).join(', '),
        label: '',
        explanation: node.failureSummary || '',
      }));
      issues.push({
        id: violation.id,
        title: violation.help,
        description: violation.description || '',
        severity: wcagInfo.severity,
        wcag: wcagInfo.wcag,
        wcagLevel: wcagInfo.level,
        score: 0,
        displayValue: `${violation.nodes.length} element${violation.nodes.length !== 1 ? 's' : ''}`,
        elements,
        count: violation.nodes.length,
      });
    }
    return { issues, interactiveLabels, supplementalData };
  } finally {
    await Promise.race([
      page.close().catch(() => {}),
      new Promise(r => setTimeout(r, 5_000)),
    ]);
  }
}

// ── IBM Equal Access Checker audit ───────────────────────────────────────────
// Covers WCAG criteria not fully tested by axe-core (focus visible, hover
// content, on-focus/on-input, error identification, reflow).
async function runIbmAudit(url, browser) {
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(120_000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await new Promise(r => setTimeout(r, 1500));

    await page.evaluate((src) => {
      return new Promise((resolve, reject) => {
        try {
          eval(src); // eslint-disable-line no-eval
          globalThis.ace_ibma = ace;
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }, ibmAceSource);

    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('IBM ace timed out after 90s')),
        IBM_TIMEOUT_MS
      );
    });

    let rawResults;
    try {
      rawResults = await Promise.race([
        page.evaluate((ruleIds) => {
          return new Promise((resolve, reject) => {
            const checker = new window.ace_ibma.Checker();
            checker.check(document, ['WCAG_2_1']).then(report => {
              const ruleSet = new Set(ruleIds);
              const filtered = (report.results || []).filter(r =>
                ruleSet.has(r.ruleId) && r.value && r.value[1] !== 'PASS'
              );
              resolve(filtered.map(r => ({
                ruleId: r.ruleId,
                valueSeverity: r.value ? r.value[0] : 'VIOLATION',
                valueFail: r.value ? r.value[1] : 'FAIL',
                snippet: r.snippet || '',
                path: (r.path && r.path.dom) || '',
                message: r.message || '',
              })));
            }).catch(reject);
          });
        }, IBM_RULE_IDS),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    const byRule = {};
    for (const r of (rawResults || [])) {
      if (!byRule[r.ruleId]) byRule[r.ruleId] = [];
      byRule[r.ruleId].push(r);
    }

    const issues = [];
    for (const [ruleId, violations] of Object.entries(byRule)) {
      const wcagInfo = IBM_WCAG_MAPPING[ruleId];
      if (!wcagInfo) continue;
      const isFail = violations.some(v => v.valueFail === 'FAIL');
      const severity = isFail ? wcagInfo.severity : 'moderate';
      const elements = violations.slice(0, 8).map(v => ({
        snippet: v.snippet,
        selector: v.path,
        label: '',
        explanation: v.message,
      }));
      issues.push({
        id: `ibm-${ruleId}`,
        title: wcagInfo.title,
        description: '',
        severity,
        wcag: wcagInfo.wcag,
        wcagLevel: wcagInfo.level,
        score: 0,
        displayValue: `${violations.length} instance${violations.length !== 1 ? 's' : ''}`,
        elements,
        count: violations.length,
      });
    }
    return issues;
  } finally {
    await Promise.race([
      page.close().catch(() => {}),
      new Promise(r => setTimeout(r, 5_000)),
    ]);
  }
}

// ── Chrome process management ─────────────────────────────────────────────────
// On Render, /proc shows ALL processes on the shared host kernel — thousands
// of PIDs from other tenants' containers.  We can only see/kill processes
// owned by our own UID, so filter by Uid before doing anything.
const MY_UID = process.platform === 'linux' ? process.getuid() : -1;

function isOwnedByUs(pid) {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const line = status.split('\n').find(l => l.startsWith('Uid:'));
    if (!line) return false;
    return parseInt(line.split(/\s+/)[1]) === MY_UID;
  } catch { return false; }
}

function isChrome(pid) {
  try {
    const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    return /^(chrome|chromium|chrome-sandbox|chrome_crashpad)/.test(comm);
  } catch { return false; }
}

// Count Chrome/Chromium processes we own. Returns 0 on non-Linux.
export function countChromeProcesses() {
  if (process.platform !== 'linux') return 0;
  let count = 0;
  try {
    for (const f of readdirSync('/proc')) {
      if (!/^\d+$/.test(f)) continue;
      const pid = Number(f);
      if (isOwnedByUs(pid) && isChrome(pid)) count++;
    }
  } catch {}
  return count;
}

// Kill every Chrome/Chromium process we own before launching a new browser pool.
export function killAllChrome() {
  if (process.platform !== 'linux') return;
  try {
    const allPids = readdirSync('/proc').filter(f => /^\d+$/.test(f)).map(Number);
    let killed = 0;
    for (const pid of allPids) {
      if (isOwnedByUs(pid) && isChrome(pid)) {
        try { process.kill(pid, 'SIGKILL'); killed++; } catch {}
      }
    }
    if (killed > 0) console.log(`[browser] Pre-launch cleanup: killed ${killed} stray Chrome process(es)`);
  } catch {}
}

// Recursively collect all descendant PIDs of a process by reading /proc.
function collectDescendants(rootPid) {
  const descendants = [];
  try {
    const allPids = readdirSync('/proc').filter(f => /^\d+$/.test(f)).map(Number);
    const childMap = new Map();
    for (const pid of allPids) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const ppid = parseInt(stat.split(')')[1].trim().split(' ')[1]);
        if (!childMap.has(ppid)) childMap.set(ppid, []);
        childMap.get(ppid).push(pid);
      } catch {}
    }
    const queue = [rootPid];
    while (queue.length) {
      const pid = queue.shift();
      descendants.push(pid);
      for (const child of (childMap.get(pid) || [])) queue.push(child);
    }
  } catch {}
  return descendants;
}

// Force-kill a browser and ALL its descendant processes, then close via CDP.
export async function closeBrowser(browser) {
  if (!browser) return;
  const pid = browser.process()?.pid;
  if (pid) {
    if (process.platform === 'linux') {
      const pids = collectDescendants(pid);
      for (const p of pids.reverse()) {
        try { process.kill(p, 'SIGKILL'); } catch {}
      }
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }
  await browser.close().catch(() => {});
}

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-translate',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--safebrowsing-disable-auto-update',
  '--no-zygote',
  '--disable-crash-reporter',
  '--disable-features=site-per-process',
  '--renderer-process-limit=1',
];

export async function launchBrowser() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH || undefined;

  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('Browser launch timed out after 60 seconds')),
        60_000
      );
    });
    try {
      const browser = await Promise.race([
        puppeteer.launch({ headless: 'new', executablePath, args: CHROME_ARGS }),
        timeoutPromise,
      ]);
      clearTimeout(timeoutHandle);
      return browser;
    } catch (err) {
      clearTimeout(timeoutHandle);
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        console.warn(`[browser] Launch attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message} — retrying in ${attempt * 2}s`);
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
  }
  throw lastErr;
}

// Hard cap per page. axe + IBM run in parallel; total audit time is well
// under this, but a hung page shouldn't stall the queue indefinitely.
const AUDIT_PAGE_TIMEOUT_MS = 5 * 60 * 1000;

// ── Main audit entry point ────────────────────────────────────────────────────
// Replaces the old runLighthouseAudit.  Runs axe-core (primary, all WCAG
// rules) + IBM Equal Access Checker (supplemental) + optional WCAG 2.2 checks,
// then computes a 0–100 score using a penalty model.
export async function runLighthouseAudit(url, browser, opts = {}) {
  // Outer timeout so a completely hung page doesn't block the worker forever.
  let outerTimeoutHandle;
  const outerTimeoutPromise = new Promise((_, reject) => {
    outerTimeoutHandle = setTimeout(
      () => reject(new Error(`Audit timed out after 5 minutes for ${url}`)),
      AUDIT_PAGE_TIMEOUT_MS
    );
  });

  try {
    const result = await Promise.race([
      _runAxeIbmAudit(url, browser, opts),
      outerTimeoutPromise,
    ]);
    return result;
  } finally {
    clearTimeout(outerTimeoutHandle);
  }
}

async function _runAxeIbmAudit(url, browser, opts) {
  // Run desktop axe, mobile axe (320px), and IBM in parallel — each opens its own page.
  const [axeResult, mobileResult, ibmResult] = await Promise.allSettled([
    runFullAxeAudit(url, browser),
    runMobileAxeAudit(url, browser),
    runIbmAudit(url, browser),
  ]);

  // axe is the primary engine — a failure here is not ignorable.
  if (axeResult.status === 'rejected') {
    throw axeResult.reason;
  }

  const { issues: axeIssues, interactiveLabels, supplementalData } = axeResult.value;
  const ibmIssues = ibmResult.status === 'fulfilled'
    ? ibmResult.value
    : (console.warn(`[ibm] Skipped for ${url}: ${ibmResult.reason?.message}`), []);

  // ── Mobile deduplication ──────────────────────────────────────────────────
  // Only report mobile violations that are genuinely new vs desktop findings:
  // same rule firing on a different element (responsive CSS hiding/changing it).
  const mobileIssues = [];
  if (mobileResult.status === 'fulfilled') {
    const { reflowIssues, violations: mobileViolations } = mobileResult.value;

    // Reflow issues have no desktop equivalent — always include them.
    mobileIssues.push(...reflowIssues);

    // Build a lookup of desktop findings: ruleId → Set of element selectors.
    const desktopByRule = new Map();
    for (const issue of axeIssues) {
      if (!desktopByRule.has(issue.id)) desktopByRule.set(issue.id, new Set());
      for (const el of (issue.elements || [])) {
        if (el.selector) desktopByRule.get(issue.id).add(el.selector);
      }
    }

    for (const v of mobileViolations) {
      const wcagInfo = ALL_AXE_WCAG_MAPPING[v.id];
      if (!wcagInfo) continue;

      const desktopSelectors = desktopByRule.get(v.id) || new Set();
      const mobileOnlyNodes  = v.nodes.filter(n => {
        const sel = (n.target || []).join(', ');
        return !desktopSelectors.has(sel);
      });
      if (mobileOnlyNodes.length === 0) continue;

      mobileIssues.push({
        id:           v.id,
        title:        `${v.help} (mobile viewport)`,
        description:  v.description || '',
        severity:     wcagInfo.severity,
        wcag:         wcagInfo.wcag,
        wcagLevel:    wcagInfo.level,
        score:        0,
        displayValue: `${mobileOnlyNodes.length} element${mobileOnlyNodes.length !== 1 ? 's' : ''} (320px)`,
        elements:     mobileOnlyNodes.slice(0, 8).map(n => ({
          snippet:     n.html || '',
          selector:    (n.target || []).join(', '),
          label:       '',
          explanation: n.failureSummary || '',
        })),
        count: mobileOnlyNodes.length,
      });
    }
  } else {
    console.warn(`[mobile-axe] Skipped for ${url}: ${mobileResult.reason?.message}`);
  }

  // Optional WCAG 2.2 checks
  let wcag22Issues = [];
  if (opts.wcag22) {
    // axe target-size rule (2.5.8)
    try {
      const page22 = await browser.newPage();
      try {
        await page22.setDefaultNavigationTimeout(60_000);
        await page22.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page22.evaluate(axeSource);
        const r22 = await page22.evaluate(async (ruleIds) => {
          return await window.axe.run(document, {
            runOnly: { type: 'rule', values: ruleIds },
            resultTypes: ['violations'],
          });
        }, AXE_WCAG22_RULE_IDS);
        for (const v of (r22?.violations || [])) {
          const info = AXE_WCAG22_MAPPING[v.id];
          if (!info) continue;
          wcag22Issues.push({
            id: `axe22-${v.id}`,
            title: v.help,
            description: v.description || '',
            severity: info.severity,
            wcag: info.wcag,
            wcagLevel: info.level,
            score: 0,
            displayValue: `${v.nodes.length} element${v.nodes.length !== 1 ? 's' : ''}`,
            elements: v.nodes.slice(0, 8).map(n => ({
              snippet: n.html || '', selector: (n.target || []).join(', '),
              label: '', explanation: n.failureSummary || '',
            })),
            count: v.nodes.length,
          });
        }
      } finally {
        await page22.close().catch(() => {});
      }
    } catch (err) {
      console.warn(`[wcag22-axe] Skipped for ${url}: ${err.message}`);
    }

    // Custom Puppeteer checks for 2.4.11 / 2.5.7 / 3.2.6 / 3.3.7 / 3.3.8
    try {
      const custom22 = await runWcag22Audit(url, browser);
      wcag22Issues.push(...custom22);
    } catch (err) {
      console.warn(`[wcag22-custom] Skipped for ${url}: ${err.message}`);
    }
  }

  // Merge and sort all issues
  const allIssues = [...axeIssues, ...mobileIssues, ...ibmIssues, ...wcag22Issues];
  allIssues.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2)
  );

  // Compute 0–100 score: start at 100, apply per-severity penalties with caps.
  let score = 100;
  for (const sev of ['critical', 'serious', 'moderate', 'minor']) {
    const count = allIssues.filter(i => i.severity === sev).length;
    score -= Math.min(count * SCORE_PENALTY[sev], SCORE_PENALTY_CAP[sev]);
  }
  const finalScore = Math.max(0, Math.round(score));

  return {
    url,
    score: finalScore,
    issues: allIssues,
    issueCount: allIssues.length,
    status: 'completed',
    timestamp: new Date().toISOString(),
    interactiveLabels,
    supplementalData: supplementalData || { forms: [], iframes: [], links: [] },
  };
}
