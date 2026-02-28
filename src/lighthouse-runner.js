import puppeteer from 'puppeteer';
import lighthouse from 'lighthouse';

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

const SEVERITY_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 };

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

export async function launchBrowser() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH || undefined;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
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
    ],
  });

  return browser;
}

export async function runLighthouseAudit(url, browser) {
  const port = parseInt(new URL(browser.wsEndpoint()).port);

  let result;
  try {
    result = await lighthouse(url, {
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
    });
  } catch (err) {
    throw new Error(`Lighthouse failed for ${url}: ${err.message}`);
  } finally {
    // Always close extra tabs — even when Lighthouse throws — so the browser
    // stays clean for the next page.
    try {
      const openPages = await browser.pages();
      for (const page of openPages) {
        const pageUrl = page.url();
        if (pageUrl !== 'about:blank' && pageUrl !== '') {
          await page.close().catch(() => {});
        }
      }
    } catch {}
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

  issues.sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 2) - (SEVERITY_ORDER[b.severity] ?? 2)
  );

  return {
    url,
    score,
    issues,
    issueCount: issues.length,
    status: 'completed',
    timestamp: new Date().toISOString(),
  };
}
