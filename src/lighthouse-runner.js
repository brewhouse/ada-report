import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';
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

// axe-core rules that cover WCAG criteria Lighthouse does NOT test,
// plus supplemental checks for criteria Lighthouse tests with fewer rules.
// Rules already handled by Lighthouse are intentionally excluded to avoid duplicates.
const AXE_WCAG_MAPPING = {
  // ── NEW criteria (not covered by Lighthouse at all) ──────────────────────
  'autocomplete-valid':      { wcag: '1.3.5', level: 'AA', severity: 'serious'  },
  'avoid-inline-spacing':    { wcag: '1.4.12', level: 'AA', severity: 'serious'  },
  'blink':                   { wcag: '2.2.2', level: 'A',  severity: 'serious'  },
  'css-orientation-lock':    { wcag: '1.3.4', level: 'AA', severity: 'serious'  },
  'link-in-text-block':      { wcag: '1.4.1', level: 'A',  severity: 'serious'  },
  'marquee':                 { wcag: '2.2.2', level: 'A',  severity: 'serious'  },
  'no-autoplay-audio':       { wcag: '1.4.2', level: 'A',  severity: 'serious'  },
  // ── Supplemental checks for existing WCAG criteria ───────────────────────
  'area-alt':                { wcag: '2.4.4', level: 'A',  severity: 'serious'  },
  'aria-braille-equivalent': { wcag: '4.1.2', level: 'A',  severity: 'serious'  },
  'aria-command-name':       { wcag: '4.1.2', level: 'A',  severity: 'serious'  },
  'aria-conditional-attr':   { wcag: '4.1.2', level: 'A',  severity: 'serious'  },
  'aria-deprecated-role':    { wcag: '4.1.2', level: 'A',  severity: 'moderate' },
  'aria-prohibited-attr':    { wcag: '4.1.2', level: 'A',  severity: 'serious'  },
  'aria-roledescription':    { wcag: '4.1.2', level: 'A',  severity: 'moderate' },
  'aria-tooltip-name':       { wcag: '4.1.2', level: 'A',  severity: 'serious'  },
  'duplicate-id':            { wcag: '4.1.1', level: 'A',  severity: 'moderate' },
  'frame-focusable-content': { wcag: '2.1.1', level: 'A',  severity: 'serious'  },
  'frame-title-unique':      { wcag: '4.1.2', level: 'A',  severity: 'serious'  },
  'html-xml-lang-mismatch':  { wcag: '3.1.1', level: 'A',  severity: 'moderate' },
  'input-button-name':       { wcag: '4.1.2', level: 'A',  severity: 'critical' },
  'nested-interactive':      { wcag: '4.1.2', level: 'A',  severity: 'serious'  },
  'p-as-heading':            { wcag: '1.3.1', level: 'A',  severity: 'moderate' },
  'role-img-alt':            { wcag: '1.1.1', level: 'A',  severity: 'serious'  },
  'scrollable-region-focusable': { wcag: '2.1.1', level: 'A', severity: 'serious' },
  'server-side-image-map':   { wcag: '2.1.1', level: 'A',  severity: 'moderate' },
  'summary-name':            { wcag: '4.1.2', level: 'A',  severity: 'serious'  },
  'svg-img-alt':             { wcag: '1.1.1', level: 'A',  severity: 'serious'  },
  'td-has-header':           { wcag: '1.3.1', level: 'A',  severity: 'serious'  },
  // 3.3.2 Labels or Instructions — axe correctly maps this to 3.3.2
  // (Lighthouse has the same rule but maps it to 1.3.1)
  'form-field-multiple-labels': { wcag: '3.3.2', level: 'A', severity: 'moderate' },
};

// WCAG mapping for common Lighthouse accessibility audits
const WCAG_MAPPING = {
  'color-contrast': { wcag: '1.4.3', level: 'AA', severity: 'serious' },
  'color-contrast-enhanced': { wcag: '1.4.6', level: 'AAA', severity: 'moderate' },
  'image-alt': { wcag: '1.1.1', level: 'A', severity: 'critical' },
  'input-image-alt': { wcag: '1.1.1', level: 'A', severity: 'critical' },
  'object-alt': { wcag: '1.1.1', level: 'A', severity: 'serious' },
  'video-caption': { wcag: '1.2.2', level: 'A', severity: 'critical' },
  'audio-caption': { wcag: '1.2.1', level: 'A', severity: 'critical' },
  'button-name': { wcag: '4.1.2', level: 'A', severity: 'critical' },
  'link-name': { wcag: '2.4.4', level: 'A', severity: 'serious' },
  'label': { wcag: '1.3.1', level: 'A', severity: 'critical' },
  'select-name': { wcag: '4.1.2', level: 'A', severity: 'critical' },
  'frame-title': { wcag: '4.1.2', level: 'A', severity: 'serious' },
  'document-title': { wcag: '2.4.2', level: 'A', severity: 'serious' },
  'heading-order': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'html-has-lang': { wcag: '3.1.1', level: 'A', severity: 'serious' },
  'html-lang-valid': { wcag: '3.1.1', level: 'A', severity: 'serious' },
  'valid-lang': { wcag: '3.1.2', level: 'AA', severity: 'moderate' },
  'meta-viewport': { wcag: '1.4.4', level: 'AA', severity: 'critical' },
  'tabindex': { wcag: '2.4.3', level: 'A', severity: 'serious' },
  'focusable-controls': { wcag: '2.1.1', level: 'A', severity: 'serious' },
  'interactive-element-affordance': { wcag: '1.3.3', level: 'A', severity: 'moderate' },
  'managed-focus': { wcag: '2.4.3', level: 'A', severity: 'moderate' },
  'focus-traps': { wcag: '2.1.2', level: 'A', severity: 'serious' },
  'custom-controls-labels': { wcag: '1.3.1', level: 'A', severity: 'serious' },
  'custom-controls-roles': { wcag: '4.1.2', level: 'A', severity: 'serious' },
  'aria-required-attr': { wcag: '4.1.2', level: 'A', severity: 'critical' },
  'aria-valid-attr': { wcag: '4.1.2', level: 'A', severity: 'critical' },
  'aria-valid-attr-value': { wcag: '4.1.2', level: 'A', severity: 'critical' },
  'aria-allowed-attr': { wcag: '4.1.2', level: 'A', severity: 'serious' },
  'aria-required-children': { wcag: '1.3.1', level: 'A', severity: 'critical' },
  'aria-required-parent': { wcag: '1.3.1', level: 'A', severity: 'critical' },
  'aria-roles': { wcag: '4.1.2', level: 'A', severity: 'critical' },
  'aria-hidden-body': { wcag: '4.1.2', level: 'A', severity: 'critical' },
  'aria-hidden-focus': { wcag: '4.1.2', level: 'A', severity: 'serious' },
  'aria-input-field-name': { wcag: '4.1.2', level: 'A', severity: 'serious' },
  'aria-meter-name': { wcag: '1.1.1', level: 'A', severity: 'serious' },
  'aria-progressbar-name': { wcag: '1.1.1', level: 'A', severity: 'serious' },
  'aria-toggle-field-name': { wcag: '4.1.2', level: 'A', severity: 'serious' },
  'aria-treeitem-name': { wcag: '4.1.2', level: 'A', severity: 'serious' },
  'definition-list': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'dlitem': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'list': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'listitem': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'td-headers-attr': { wcag: '1.3.1', level: 'A', severity: 'serious' },
  'th-has-data-cells': { wcag: '1.3.1', level: 'A', severity: 'serious' },
  'scope-attr-valid': { wcag: '1.3.1', level: 'A', severity: 'serious' },
  'table-duplicate-name': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'table-fake-caption': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'duplicate-id-active': { wcag: '4.1.1', level: 'A', severity: 'serious' },
  'duplicate-id-aria': { wcag: '4.1.1', level: 'A', severity: 'critical' },
  'form-field-multiple-labels': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'identical-links-same-purpose': { wcag: '2.4.9', level: 'AAA', severity: 'minor' },
  'image-redundant-alt': { wcag: '1.1.1', level: 'A', severity: 'minor' },
  'label-content-name-mismatch': { wcag: '2.5.3', level: 'A', severity: 'serious' },
  'landmark-one-main': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'meta-refresh': { wcag: '2.2.1', level: 'A', severity: 'critical' },
  'skip-link': { wcag: '2.4.1', level: 'A', severity: 'moderate' },
  'use-landmarks': { wcag: '1.3.1', level: 'A', severity: 'moderate' },
  'visual-order-follows-dom': { wcag: '1.3.2', level: 'A', severity: 'moderate' },
  'offscreen-content-hidden': { wcag: '1.3.2', level: 'A', severity: 'moderate' },
  'logical-tab-order': { wcag: '2.4.3', level: 'A', severity: 'moderate' },
};

// IBM Equal Access Checker rules for WCAG criteria not covered by Lighthouse or axe-core.
// Rule IDs verified against accessibility-checker-engine v4.0.13 checkpoint definitions.
// Only VIOLATION-level rules are mapped; _review rules may return potentialviolation.
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

const SEVERITY_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const AXE_RULE_IDS = Object.keys(AXE_WCAG_MAPPING);
const AXE_TIMEOUT_MS = 120_000;

// ── WCAG 2.2 axe rule — only run when wcag22 option is enabled ────────────────
// axe-core 4.8+ includes target-size; the other WCAG 2.2 criteria are checked
// via custom Puppeteer logic in runWcag22Audit() below.
const AXE_WCAG22_MAPPING = {
  'target-size': { wcag: '2.5.8', level: 'AA', severity: 'serious' },
};
const AXE_WCAG22_RULE_IDS = Object.keys(AXE_WCAG22_MAPPING);

// Custom Puppeteer-based checks for the five WCAG 2.2 criteria that axe-core
// does not cover.  Returns an array of issue objects (same shape as axe issues).
async function runWcag22Audit(url, browser) {
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(60_000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await new Promise(r => setTimeout(r, 500));

    const raw = await page.evaluate(() => {
      const issues = [];

      // ── 2.4.11 Focus Not Obscured ─────────────────────────────────────────
      // Find fixed/sticky elements at the top of the viewport and collect any
      // focusable elements whose top edge sits beneath them.
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
            explanation: 'Verify that this element can be operated without dragging (e.g. up/down buttons or click-to-select).',
          })),
        });
      }

      // ── 3.2.6 Consistent Help ─────────────────────────────────────────────
      // Detect the presence of help mechanisms and flag for cross-page review.
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
          description: 'WCAG 3.2.6 requires that help mechanisms such as contact information or live chat appear in the same relative order on every page.',
          count: helpEls.length,
          elements: helpEls.slice(0, 3).map(el => ({
            snippet: el.outerHTML.substring(0, 200), selector: '', label: '',
            explanation: 'Check that this help mechanism is in the same relative location on every page of the site.',
          })),
        });
      }

      // ── 3.3.7 Redundant Entry ─────────────────────────────────────────────
      // Detect multi-step form patterns.
      const stepEls = Array.from(document.querySelectorAll(
        '[class*="step-"],[class*="wizard"],[class*="multi-step"],[data-step],[aria-label*="step" i],[class*="progress-step"]'
      )).filter(el => { const r = el.getBoundingClientRect(); return r.width > 0; });
      if (stepEls.length > 0) {
        issues.push({
          id: 'wcag22-redundant-entry', wcag: '3.3.7', wcagLevel: 'A', severity: 'moderate',
          title: 'Multi-step form detected — verify users are not required to re-enter previously provided information',
          description: 'WCAG 3.3.7 requires that information previously entered by the user is auto-populated or available for selection in subsequent steps.',
          count: stepEls.length,
          elements: stepEls.slice(0, 3).map(el => ({
            snippet: el.outerHTML.substring(0, 200), selector: '', label: '',
            explanation: 'Ensure this step does not ask the user to re-enter information already submitted in a prior step.',
          })),
        });
      }

      // ── 3.3.8 Accessible Authentication ──────────────────────────────────
      // Detect CAPTCHA elements on pages that appear to be auth flows.
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
          description: 'WCAG 3.3.8 prohibits cognitive function tests (such as image CAPTCHAs) as the only authentication method unless an alternative is provided.',
          count: captchaEls.length,
          elements: captchaEls.slice(0, 3).map(el => ({
            snippet: el.outerHTML.substring(0, 200), selector: '', label: '',
            explanation: 'Ensure a CAPTCHA-free login method (e.g. magic link, passkey, or image + audio alternative) is also available.',
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

// Runs axe-core on the given URL using an existing Puppeteer browser instance.
// Also extracts interactive element labels for WCAG 3.2.4 cross-page analysis.
// Returns { issues, interactiveLabels }.
async function runAxeAudit(url, browser) {
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(120_000);
    // domcontentloaded is sufficient for axe; browser cache makes this fast
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    // Brief pause for JS frameworks to initialize
    await new Promise(r => setTimeout(r, 800));

    // Extract interactive labels for 3.2.4 BEFORE axe injection — pure DOM
    // query, never blocked by CSP.
    let interactiveLabels = [];
    try {
      interactiveLabels = await page.evaluate(extractLabelsFn);
    } catch (e) {
      // Non-fatal — consistency check for this page will be skipped
    }

    // Inject axe-core into the page
    await page.evaluate(axeSource);

    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error('axe-core timed out after 60s')),
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
        }, AXE_RULE_IDS),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }

    const issues = [];
    for (const violation of (results?.violations || [])) {
      const wcagInfo = AXE_WCAG_MAPPING[violation.id];
      if (!wcagInfo) continue;
      const elements = violation.nodes.slice(0, 8).map(node => ({
        snippet: node.html || '',
        selector: (node.target || []).join(', '),
        label: '',
        explanation: node.failureSummary || '',
      }));
      issues.push({
        id: `axe-${violation.id}`,
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
    return { issues, interactiveLabels };
  } finally {
    await Promise.race([
      page.close().catch(() => {}),
      new Promise(r => setTimeout(r, 5_000)),
    ]);
  }
}

// Runs IBM Equal Access Checker on the given URL using an existing Puppeteer browser instance.
// Injects the locally-installed ace.js engine (no CDN download required).
// Returns issues for WCAG criteria not covered by Lighthouse or axe-core.
async function runIbmAudit(url, browser) {
  const page = await browser.newPage();
  try {
    await page.setDefaultNavigationTimeout(120_000);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await new Promise(r => setTimeout(r, 800));

    // Inject IBM ace.js engine; eval sets `var ace` in the eval scope,
    // then we copy it to globalThis.ace_ibma so the Checker is accessible.
    await page.evaluate((src) => {
      return new Promise((resolve, reject) => {
        try {
          eval(src); // eslint-disable-line no-eval
          globalThis.ace_ibma = ace; // ace declared by `var ace;` in ace.js
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

    // Group by ruleId, then convert to issue format
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

function extractElements(audit) {
  if (!audit.details || !audit.details.items) return [];
  return audit.details.items.slice(0, 8).map(item => {
    if (item.node) {
      return {
        snippet: item.node.snippet || '',
        selector: item.node.selector || '',
        label: item.node.nodeLabel || '',
        explanation: item.node.explanation || '',
      };
    }
    if (item.url) {
      return { snippet: item.url, selector: '', label: '', explanation: '' };
    }
    if (typeof item === 'string') {
      return { snippet: item, selector: '', label: '', explanation: '' };
    }
    return null;
  }).filter(Boolean);
}

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
// On Linux, Chrome spawns renderer/network/GPU helper child processes that
// become orphaned when only the parent is killed. This walks the full tree.
function collectDescendants(rootPid) {
  const descendants = [];
  try {
    // Build a ppid→[children] map from /proc
    const allPids = readdirSync('/proc').filter(f => /^\d+$/.test(f)).map(Number);
    const childMap = new Map();
    for (const pid of allPids) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        // stat format: pid (comm) state ppid ...
        const ppid = parseInt(stat.split(')')[1].trim().split(' ')[1]);
        if (!childMap.has(ppid)) childMap.set(ppid, []);
        childMap.get(ppid).push(pid);
      } catch {}
    }
    // BFS from rootPid
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
//
// On Linux (Render), killing only the Chrome parent leaves renderer,
// network-service, and GPU helper children as orphans — they accumulate
// across audits until the container process limit is hit.
//
// We walk /proc to find every descendant of the Chrome PID and SIGKILL
// them all (children first, parent last) before calling browser.close().
export async function closeBrowser(browser) {
  if (!browser) return;
  const pid = browser.process()?.pid;
  if (pid) {
    if (process.platform === 'linux') {
      const pids = collectDescendants(pid);
      // Kill children before parent so they can't be re-spawned
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
  // Reduce child process count per Chrome instance on Linux/Render:
  // site-per-process spawns a renderer per origin — disable it so all
  // content shares one renderer process instead of many.
  '--disable-features=site-per-process',
  // Cap renderer processes to 1 per browser instance.
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

// Hard cap per page so a hung Chrome (e.g. OOM-killed while another audit starts)
// can't freeze the entire audit indefinitely.  5 minutes >> maxWaitForLoad (2 min).
const LIGHTHOUSE_PAGE_TIMEOUT_MS = 7 * 60 * 1000;

export async function runLighthouseAudit(url, browser, opts = {}) {
  const port = parseInt(new URL(browser.wsEndpoint()).port);

  let result;
  try {
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Lighthouse timed out after 7 minutes`)),
        LIGHTHOUSE_PAGE_TIMEOUT_MS
      );
    });
    try {
      result = await Promise.race([
        lighthouse(url, {
          port,
          onlyCategories: ['accessibility'],
          output: 'json',
          logLevel: 'error',
          formFactor: 'desktop',
          screenEmulation: {
            mobile: false,
            width: 1350,
            height: 940,
            deviceScaleFactor: 1,
            disabled: false,
          },
          throttlingMethod: 'provided',
          disableFullPageScreenshot: true,
          maxWaitForLoad: 120000, // 120 s — allow slow/SPA/gov pages to finish loading
        }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (err) {
    throw new Error(`Lighthouse failed for ${url}: ${err.message}`);
  } finally {
    // Close extra tabs so the browser stays clean for the next page.
    // Cap at 10 s — if Chrome is stuck (e.g. a hung page), browser.pages()
    // or page.close() can itself hang forever, freezing the entire audit.
    await Promise.race([
      (async () => {
        try {
          const openPages = await browser.pages();
          for (const page of openPages) {
            const pageUrl = page.url();
            if (pageUrl !== 'about:blank' && pageUrl !== '') {
              await page.close().catch(() => {});
            }
          }
        } catch {}
      })(),
      new Promise(r => setTimeout(r, 10_000)),
    ]);
  }

  const lhr = result.lhr;
  const rawScore = lhr.categories?.accessibility?.score;

  // A null score means Lighthouse ran but couldn't evaluate the page
  // (typically a React/SPA page whose API calls never settled, or a login-
  // gated page that rendered empty). Treat it as an auditable error rather
  // than silently reporting 0.
  if (rawScore === null || rawScore === undefined) {
    throw new Error(
      'Lighthouse returned no accessibility score — the page may not have fully rendered ' +
      '(JavaScript-heavy page whose API calls did not complete in time, or the page requires login).'
    );
  }

  const score = Math.round(rawScore * 100);
  const auditRefs = lhr.categories?.accessibility?.auditRefs ?? [];
  const issues = [];

  for (const ref of auditRefs) {
    const audit = lhr.audits?.[ref.id];
    if (!audit) continue;

    // Skip passed, not applicable, informative, and manual audits
    if (
      audit.score === 1 ||
      audit.score === null ||
      audit.scoreDisplayMode === 'notApplicable' ||
      audit.scoreDisplayMode === 'informative' ||
      audit.scoreDisplayMode === 'manual'
    ) continue;

    const wcagInfo = WCAG_MAPPING[audit.id] || {
      wcag: 'N/A', level: 'N/A', severity: 'moderate'
    };

    const elements = extractElements(audit);
    const totalCount = audit.details?.items?.length ?? 1;

    issues.push({
      id: audit.id,
      title: audit.title,
      description: audit.description?.replace(/\[Learn[^\]]*\]\([^)]*\)/g, '').trim() || '',
      severity: wcagInfo.severity,
      wcag: wcagInfo.wcag,
      wcagLevel: wcagInfo.level,
      score: audit.score,
      displayValue: audit.displayValue || '',
      elements,
      count: totalCount,
    });
  }

  // Run axe-core and IBM Equal Access Checker in parallel — each opens its own
  // page in the same browser, so they don't block each other.
  let axeIssues = [];
  let interactiveLabels = [];
  let ibmIssues = [];

  const [axeResult, ibmResult] = await Promise.allSettled([
    runAxeAudit(url, browser),
    runIbmAudit(url, browser),
  ]);

  if (axeResult.status === 'fulfilled') {
    axeIssues = axeResult.value.issues;
    interactiveLabels = axeResult.value.interactiveLabels || [];
  } else {
    console.warn(`[axe] Skipped for ${url}: ${axeResult.reason?.message}`);
  }

  if (ibmResult.status === 'fulfilled') {
    ibmIssues = ibmResult.value;
  } else {
    console.warn(`[ibm] Skipped for ${url}: ${ibmResult.reason?.message}`);
  }

  // Optionally run WCAG 2.2 checks (axe target-size + custom Puppeteer heuristics)
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

  // Merge and sort — axe IDs use 'axe-' prefix, IBM IDs use 'ibm-' prefix, WCAG 2.2 use 'wcag22-'/'axe22-'
  const allIssues = [...issues, ...axeIssues, ...ibmIssues, ...wcag22Issues];
  allIssues.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2)
  );

  // Adjust Lighthouse score downward for additional issues found by axe/IBM.
  // Lighthouse already reflects its own findings, so only extra issues penalise.
  const extraIssues = [...axeIssues, ...ibmIssues, ...wcag22Issues];
  const PENALTY   = { critical: 5, serious: 3, moderate: 1, minor: 0.5 };
  const PENALTY_CAP = { critical: 20, serious: 12, moderate: 6, minor: 3 };
  let totalPenalty = 0;
  for (const sev of ['critical', 'serious', 'moderate', 'minor']) {
    const count = extraIssues.filter(i => i.severity === sev).length;
    totalPenalty += Math.min(count * PENALTY[sev], PENALTY_CAP[sev]);
  }
  const adjustedScore = Math.max(0, Math.round(score - totalPenalty));

  return {
    url,
    score: adjustedScore,
    issues: allIssues,
    issueCount: allIssues.length,
    status: 'completed',
    timestamp: new Date().toISOString(),
    interactiveLabels,  // used by cross-page 3.2.4 consistency check
  };
}
