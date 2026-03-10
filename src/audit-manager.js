import axios from 'axios';
import { crawlWebsite, fetchUrlsFromSitemaps } from './crawler.js';
import { launchBrowser, runLighthouseAudit } from './lighthouse-runner.js';

const CHECK_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; ADA-Accessibility-Auditor/1.0)' };

// Normalize a pathname for comparison: strip trailing slash, lowercase.
function normPath(pathname) {
  return (pathname || '/').replace(/\/$/, '').toLowerCase() || '/';
}

// Returns 'redirect', 'not-found', or 'ok'.
// Follows redirects (so http→https and www→non-www are transparent) but
// flags as 'redirect' only when the final path is different from the original
// — indicating the URL was moved to unrelated content (e.g. redirects to home).
async function checkUrlStatus(url) {
  const origPath = normPath(new URL(url).pathname);
  const opts = {
    maxRedirects: 5,
    timeout: 10000,
    validateStatus: () => true,
    headers: CHECK_HEADERS,
  };

  for (const method of ['head', 'get']) {
    let res;
    try {
      res = await axios[method](url, opts);
    } catch (err) {
      if (method === 'get') return 'ok'; // network error — let Lighthouse try
      continue; // HEAD failed, try GET
    }

    const status = res.status;
    if (status === 404 || status === 410) return 'not-found';
    if (status === 403) return 'forbidden';
    if (status === 405 && method === 'head') continue; // HEAD not allowed, try GET

    // Detect content-redirect: the server followed redirects and landed on a
    // different path (e.g. /old-post → /). Protocol and host changes are fine.
    const finalUrl = res.request?.res?.responseUrl;
    if (finalUrl) {
      try {
        const finalPath = normPath(new URL(finalUrl).pathname);
        if (finalPath !== origPath) return 'redirect';
      } catch {}
    }

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

// Global semaphore — caps total concurrent audits regardless of code path
// (manual queue + scheduled triggers combined).
let _globalAuditCount = 0;
const _MAX_GLOBAL_AUDITS = 4;
const _globalWaiters = [];

function _acquireGlobalSlot() {
  return new Promise(resolve => {
    if (_globalAuditCount < _MAX_GLOBAL_AUDITS) { _globalAuditCount++; resolve(); }
    else _globalWaiters.push(resolve);
  });
}

function _releaseGlobalSlot() {
  if (_globalWaiters.length > 0) _globalWaiters.shift()();
  else _globalAuditCount--;
}

// Force-release a global slot — used when a timed-out audit left the semaphore stuck.
export function forceReleaseGlobalSlot() {
  if (_globalAuditCount > 0) _releaseGlobalSlot();
}

// Number of pages to audit in parallel within a single audit (each page = one browser).
const CONCURRENT_PAGES = 2;

export async function startAudit(session, onUpdate) {
  await _acquireGlobalSlot();
  try {
    return await _runAudit(session, onUpdate);
  } finally {
    _releaseGlobalSlot();
  }
}

async function _runAudit(session, onUpdate) {
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

    let excludeUrls = null;
    if (session.excludeSitemaps && session.excludeSitemaps.length > 0) {
      console.log(`[audit] Fetching ${session.excludeSitemaps.length} exclude sitemap(s)…`);
      excludeUrls = await fetchUrlsFromSitemaps(session.excludeSitemaps);
      console.log(`[audit] Excluding ${excludeUrls.size} URL(s) from audit`);
    }

    pages = await crawlWebsite(session.url, session.maxPages, (count) => {
      onUpdate({ progress: { crawled: count, total: count, audited: 0 } });
    }, excludeUrls);

    if (pages.length === 0) {
      throw new Error('No pages found to audit. The site may be inaccessible or block crawlers.');
    }
  }

  // Filter out URLs that redirect to a different location (3xx) or return 404/410.
  // Run checks in batches of 25 to avoid saturating connections on large sitemaps.
  {
    const BATCH = 25;
    const statuses = [];
    for (let i = 0; i < pages.length; i += BATCH) {
      const batch = pages.slice(i, i + BATCH);
      statuses.push(...await Promise.all(batch.map(u => checkUrlStatus(u))));
    }
    const before = pages.length;
    pages = pages.filter((_, i) => statuses[i] === 'ok');
    const skipped = before - pages.length;
    if (skipped > 0) {
      const forbidden = statuses.filter(s => s === 'forbidden').length;
      const notFound = statuses.filter(s => s === 'not-found').length;
      const redirected = statuses.filter(s => s === 'redirect').length;
      const parts = [];
      if (redirected > 0) parts.push(`${redirected} redirect`);
      if (notFound > 0) parts.push(`${notFound} not-found`);
      if (forbidden > 0) parts.push(`${forbidden} forbidden (403)`);
      console.log(`[audit] Skipped ${skipped} URL(s) — ${parts.join(', ')}`);
    }
  }

  if (pages.length === 0) {
    throw new Error('No auditable pages found — all discovered URLs either redirect, return 404, or are access-denied (403).');
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
        // Emit single page rather than full pages array on every update (avoids O(n²) work)
        onUpdate({
          completedPage: pageResult,
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
