import axios from 'axios';
import { crawlWebsite, fetchUrlsFromSitemaps } from './crawler.js';
import { launchBrowser, closeBrowser, runLighthouseAudit, killAllChrome } from './lighthouse-runner.js';
import { analyzeConsistency } from './consistency-checker.js';

const CHECK_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; ADA-Accessibility-Auditor/1.0)' };

// Errors caused by the page itself — retrying won't help.
function isNonRetryableError(error) {
  const msg = error.message || '';
  return (
    /\bstatus.?code\s+[45]\d\d\b/i.test(msg) ||   // HTTP 4xx / 5xx
    /too many redirects|ERR_TOO_MANY_REDIRECTS/i.test(msg) ||
    /ERR_NAME_NOT_RESOLVED/i.test(msg)              // DNS failure
  );
}

// Lighthouse internal errors caused by a stale Chrome instance — must replace
// the browser before retrying, otherwise the retry will fail identically.
function requiresBrowserReplace(error) {
  const msg = error.message || '';
  return /performance mark has not been set|lh:runner|lh:driver|webSocket URL|websocket|CDP|target closed|connection closed/i.test(msg);
}

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
export async function rescanPage(url, opts = {}) {
  // Quick HTTP check before launching Chrome — avoids a full browser session
  // for pages that are 404, permanently redirected, or access-denied.
  const urlStatus = await checkUrlStatus(url);
  if (urlStatus !== 'ok') {
    const reason = urlStatus === 'not-found' ? 'Page returned 404 or 410 — it no longer exists'
                 : urlStatus === 'redirect'  ? 'Page redirects to a different URL'
                 : urlStatus === 'forbidden' ? 'Page returned 403 Forbidden'
                 : `Page is not auditable (${urlStatus})`;
    return {
      url, status: 'error', error: reason,
      score: null, issues: [], issueCount: 0,
      timestamp: new Date().toISOString(),
    };
  }

  let browser = await launchBrowser();
  try {
    let pageResult;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        pageResult = await runLighthouseAudit(url, browser, opts);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          if (isNonRetryableError(error)) break;
          // Chrome is in a bad state — close and relaunch before retrying.
          if (requiresBrowserReplace(error)) {
            await closeBrowser(browser);
            browser = null;
            try {
              browser = await launchBrowser();
            } catch (launchErr) {
              lastError = launchErr;
              break; // Can't recover — give up
            }
          }
          await new Promise(r => setTimeout(r, attempt * 5000));
        }
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
    await closeBrowser(browser);
  }
}

// Global semaphore — caps total concurrent audits regardless of code path
// (manual queue + scheduled triggers combined).
let _globalAuditCount = 0;
const _MAX_GLOBAL_AUDITS = 2;
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

// Return the current number of held global audit slots (for diagnostics).
export function getGlobalAuditCount() {
  return _globalAuditCount;
}

// Number of pages to audit in parallel within a single audit (each page = one browser).
// 2 pages × up to 2 simultaneous audits = 4 Chrome instances max on Render.
// Keeping this low is critical — Lighthouse's gather phase is CPU-intensive and
// Chrome will OOM-crash or fail to initialize if too many instances compete.
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
  // Kill stray Chrome from a previous crashed run only when this is the sole
  // running audit — calling killAllChrome() with concurrent audits active would
  // kill their live browsers and cause cascading failures.
  if (_globalAuditCount === 1) {
    killAllChrome();
  }
  // Launch sequentially with a short stagger so Chrome instances don't all
  // compete for OS resources simultaneously (causes fork failures on Render).
  const concurrency = Math.min(CONCURRENT_PAGES, pages.length);
  const browsers = [];
  try {
    for (let i = 0; i < concurrency; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1500));
      try {
        browsers.push(await launchBrowser());
      } catch (err) {
        console.warn('[audit] Browser launch failed:', err.message);
      }
    }
    if (browsers.length === 0) {
      // Pool launch failed entirely — kill any lingering Chrome, wait 5 s,
      // then try one last time with a single browser before giving up.
      console.warn('[audit] All pool launches failed — running emergency cleanup and retrying with 1 browser');
      killAllChrome();
      await new Promise(r => setTimeout(r, 5000));
      try {
        browsers.push(await launchBrowser());
      } catch (err) {
        throw new Error(`Failed to launch any browsers: ${err.message}`);
      }
    }

    // Phase 3: Audit pages in parallel using a shared queue index.
    // In JavaScript's single-threaded event loop, `pageIndex++` is atomic
    // (no await between check and increment), so this pattern is race-free.
    const auditedPages = new Array(pages.length).fill(null);
    let pageIndex = 0;
    let auditedCount = 0;

    // Kill a browser by index and replace it with a fresh one.
    // Called whenever a page error/timeout leaves Chrome in a bad state.
    async function replaceBrowser(idx) {
      await closeBrowser(browsers[idx]);
      browsers[idx] = null; // Mark slot unavailable before attempting restart
      try {
        browsers[idx] = await launchBrowser();
      } catch (err) {
        console.warn(`[audit] Browser restart failed for worker ${idx}: ${err.message}`);
        // browsers[idx] stays null — worker detects this and errors pages cleanly
        // instead of looping against a dead Chrome process
      }
    }

    // Use index into browsers[] so auditWorker can replace a hung browser.
    async function auditWorker(workerIdx) {
      while (pageIndex < pages.length) {
        const i = pageIndex++;
        if (i >= pages.length) break;

        const pageUrl = pages[i];
        onUpdate({ currentPage: pageUrl });

        const MAX_ATTEMPTS = 3;
        let pageResult;
        let lastError;

        // If this worker's browser slot is null (a prior restart failed), skip
        // the retry loop entirely — attempting runLighthouseAudit against a null
        // browser hammers Chrome with 3× 30 s launch timeouts per page.
        if (!browsers[workerIdx]) {
          lastError = new Error('Browser unavailable — Chrome could not be restarted');
        } else {
          for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
              pageResult = await runLighthouseAudit(pageUrl, browsers[workerIdx], { wcag22: !!session.wcag22 });
              lastError = null;
              break;
            } catch (error) {
              lastError = error;
              console.warn(`[audit] Page error (attempt ${attempt}/${MAX_ATTEMPTS}) — ${pageUrl}: ${error.message}`);
              if (attempt < MAX_ATTEMPTS) {
                // Don't retry errors caused by the page itself (HTTP errors, bad redirects, DNS).
                if (isNonRetryableError(error)) break;
                // Lighthouse internal mark errors mean Chrome is in a bad state —
                // replace the browser before retrying so the next attempt gets a
                // clean instance. Cap at 20 s so a failed restart doesn't stall.
                if (requiresBrowserReplace(error)) {
                  await Promise.race([replaceBrowser(workerIdx), new Promise(r => setTimeout(r, 20_000))]);
                }
                // Progressive back-off: 5 s after attempt 1, 10 s after attempt 2.
                await new Promise(r => setTimeout(r, attempt * 5000));
              }
            }
          }
        }

        // After all attempts failed, replace the browser so the NEXT page
        // gets a clean Chrome instance. Cap at 20 s so a slow/failed restart
        // never stalls the entire audit — the worker carries on regardless.
        // Only attempt replacement if the slot isn't already null (restart was
        // already tried and failed — don't hammer Chrome again).
        if (lastError) {
          if (browsers[workerIdx]) {
            await Promise.race([replaceBrowser(workerIdx), new Promise(r => setTimeout(r, 20_000))]);
          }
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
          completedPage: pageResult,
          progress: {
            crawled: pages.length,
            total: pages.length,
            audited: auditedCount,
          },
        });
      }
    }

    await Promise.all(browsers.map((_, idx) => auditWorker(idx)));

    // Phase 4: Cross-page consistency check for WCAG 3.2.4
    const completed = auditedPages.filter(p => p && p.status === 'completed');
    try {
      const consistencyResults = analyzeConsistency(completed);
      for (const { issue, primaryUrl } of consistencyResults) {
        const targetPage = completed.find(p => p.url === primaryUrl);
        if (targetPage) {
          targetPage.issues.push(issue);
          targetPage.issueCount = targetPage.issues.length;
        }
      }
      if (consistencyResults.length > 0) {
        console.log(`[consistency] ${consistencyResults.length} WCAG 3.2.4 inconsistency group(s) detected`);
      }
    } catch (err) {
      console.warn('[consistency] Skipped:', err.message);
    }

    // Phase 5: Compute summary
    const scores = completed.map(p => p.score).filter(s => s !== null);
    const allIssues = completed.flatMap(p => p.issues || []);

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
    await Promise.all(browsers.map(b => closeBrowser(b)));
  }
}
