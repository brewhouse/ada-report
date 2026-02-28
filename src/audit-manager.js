import axios from 'axios';
import { crawlWebsite } from './crawler.js';
import { launchBrowser, runLighthouseAudit } from './lighthouse-runner.js';

const CHECK_OPTS = {
  maxRedirects: 0,
  timeout: 10000,
  validateStatus: () => true,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ADA-Accessibility-Auditor/1.0)' },
};

// Returns 'redirect', 'not-found', or 'ok'.
// Uses HEAD first (no body download), falls back to GET if HEAD is unsupported.
async function checkUrlStatus(url) {
  for (const method of ['head', 'get']) {
    let status;
    try {
      const res = await axios[method](url, CHECK_OPTS);
      status = res.status;
    } catch (err) {
      status = err.response?.status;
      if (!status) {
        if (method === 'get') return 'ok'; // true network error — let Lighthouse try
        continue; // HEAD failed without a response, try GET
      }
    }
    if (status === 404 || status === 410) return 'not-found';
    if (status >= 300 && status < 400) return 'redirect';
    if (status === 405 && method === 'head') continue; // HEAD not allowed, try GET
    return 'ok';
  }
  return 'ok';
}

// Re-audit a single URL and return the updated page result.
// Used by the /rescan endpoint to retry a previously errored page.
export async function rescanPage(url) {
  const browser = await launchBrowser();
  try {
    let pageResult;
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        pageResult = await runLighthouseAudit(url, browser);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(r => setTimeout(r, 4000));
      }
    }
    if (lastError) {
      return {
        url,
        status: 'error',
        error: lastError.message,
        score: null,
        issues: [],
        issueCount: 0,
        timestamp: new Date().toISOString(),
      };
    }
    return pageResult;
  } finally {
    await browser.close().catch((err) => {
      if (process.env.DEBUG) console.warn('Browser close error:', err.message);
    });
  }
}

// Number of pages to audit in parallel (each gets its own browser instance)
const CONCURRENT_PAGES = 4;

export async function startAudit(session, onUpdate) {
  let pages;

  if (session.urlList && session.urlList.length > 0) {
    // URL-list mode: audit exactly the provided URLs, no crawling
    pages = session.urlList;
  } else if (session.maxPages === 1) {
    // Single-page mode: skip crawl entirely, audit only the given URL
    pages = [session.url];
  } else {
    // Phase 1: Crawl
    onUpdate({ status: 'crawling', progress: { crawled: 0, total: 0, audited: 0 } });

    pages = await crawlWebsite(session.url, session.maxPages, (count) => {
      onUpdate({ progress: { crawled: count, total: count, audited: 0 } });
    });

    if (pages.length === 0) {
      throw new Error('No pages found to audit. The site may be inaccessible or block crawlers.');
    }
  }

  // Filter out URLs that redirect to a different location (3xx) or return 404/410.
  // Run checks in parallel so this step is fast even for large page lists.
  {
    const statuses = await Promise.all(pages.map(url => checkUrlStatus(url)));
    const before = pages.length;
    pages = pages.filter((_, i) => statuses[i] === 'ok');
    const skipped = before - pages.length;
    if (skipped > 0) console.log(`[audit] Skipped ${skipped} URL(s) — redirect or 404`);
  }

  if (pages.length === 0) {
    throw new Error('No auditable pages found — all discovered URLs either redirect or return 404.');
  }

  onUpdate({
    status: 'auditing',
    crawledUrls: pages,
    progress: { crawled: pages.length, total: pages.length, audited: 0 },
  });

  // Phase 2: Launch a pool of browsers for parallel auditing.
  // Launch sequentially so partial failures still get cleaned up in finally.
  const concurrency = Math.min(CONCURRENT_PAGES, pages.length);
  const browsers = [];
  try {
    for (let k = 0; k < concurrency; k++) {
      browsers.push(await launchBrowser());
    }

    // Phase 3: Audit pages in parallel using a shared queue index.
    // In JavaScript's single-threaded event loop, `pageIndex++` is atomic
    // (no await between check and increment), so this pattern is race-free.
    const auditedPages = new Array(pages.length).fill(null);
    let pageIndex = 0;
    let auditedCount = 0;

    async function auditWorker(workerBrowser) {
      while (pageIndex < pages.length) {
        const i = pageIndex++;
        if (i >= pages.length) break;

        const pageUrl = pages[i];
        onUpdate({ currentPage: pageUrl });

        let pageResult;
        // Retry once on failure — transient Chrome issues, slow-loading SPA pages,
        // and tabs left dirty from a previous error can all cause false failures.
        let lastError;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            pageResult = await runLighthouseAudit(pageUrl, workerBrowser);
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            if (attempt < 2) {
              // Give Chrome 4 s to settle before retrying
              await new Promise(r => setTimeout(r, 4000));
            }
          }
        }

        if (lastError) {
          pageResult = {
            url: pageUrl,
            status: 'error',
            error: lastError.message,
            score: null,
            issues: [],
            issueCount: 0,
            timestamp: new Date().toISOString(),
          };
        }

        auditedPages[i] = pageResult;
        auditedCount++;
        onUpdate({
          pages: auditedPages.filter(Boolean),
          progress: {
            crawled: pages.length,
            total: pages.length,
            audited: auditedCount,
          },
        });
      }
    }

    await Promise.all(browsers.map(b => auditWorker(b)));

    // Phase 4: Compute summary
    const completed = auditedPages.filter(p => p && p.status === 'completed');
    const scores = completed.map(p => p.score).filter(s => s !== null);
    const allIssues = completed.flatMap(p => p.issues);

    const summary = {
      totalPages: pages.length,
      successfulPages: completed.length,
      errorPages: auditedPages.filter(p => p && p.status === 'error').length,
      averageScore: scores.length
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0,
      minScore: scores.length ? Math.min(...scores) : 0,
      maxScore: scores.length ? Math.max(...scores) : 0,
      totalIssues: allIssues.length,
      criticalIssues: allIssues.filter(i => i.severity === 'critical').length,
      seriousIssues: allIssues.filter(i => i.severity === 'serious').length,
      moderateIssues: allIssues.filter(i => i.severity === 'moderate').length,
      minorIssues: allIssues.filter(i => i.severity === 'minor').length,
      pagesAbove90: scores.filter(s => s >= 90).length,
      pages70to89: scores.filter(s => s >= 70 && s < 90).length,
      pages50to69: scores.filter(s => s >= 50 && s < 70).length,
      pagesBelow50: scores.filter(s => s < 50).length,
    };

    onUpdate({
      status: 'completed',
      summary,
      endTime: new Date().toISOString(),
      currentPage: null,
    });

  } finally {
    await Promise.all(browsers.map(b => b.close().catch((err) => {
      if (process.env.DEBUG) console.warn('Browser close error:', err.message);
    })));
  }
}
