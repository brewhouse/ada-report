import { crawlWebsite } from './crawler.js';
import { launchBrowser, runLighthouseAudit } from './lighthouse-runner.js';

export async function startAudit(session, onUpdate) {
  let browser;

  try {
    let pages;

    if (session.maxPages === 1) {
      // Single-page mode: skip crawl entirely, audit only the given URL
      pages = [session.url];
      onUpdate({ status: 'auditing', crawledUrls: pages, progress: { crawled: 1, total: 1, audited: 0 } });
    } else {
      // Phase 1: Crawl
      onUpdate({ status: 'crawling', progress: { crawled: 0, total: 0, audited: 0 } });

      pages = await crawlWebsite(session.url, session.maxPages, (count) => {
        onUpdate({ progress: { crawled: count, total: count, audited: 0 } });
      });

      if (pages.length === 0) {
        throw new Error('No pages found to audit. The site may be inaccessible or block crawlers.');
      }

      onUpdate({
        status: 'auditing',
        crawledUrls: pages,
        progress: { crawled: pages.length, total: pages.length, audited: 0 },
      });
    }

    // Phase 2: Launch browser
    browser = await launchBrowser();

    // Phase 3: Audit each page sequentially
    const auditedPages = [];

    for (let i = 0; i < pages.length; i++) {
      const pageUrl = pages[i];
      onUpdate({ currentPage: pageUrl });

      let pageResult;
      try {
        pageResult = await runLighthouseAudit(pageUrl, browser);
      } catch (error) {
        pageResult = {
          url: pageUrl,
          status: 'error',
          error: error.message,
          score: null,
          issues: [],
          issueCount: 0,
          timestamp: new Date().toISOString(),
        };
      }

      auditedPages.push(pageResult);
      onUpdate({
        pages: [...auditedPages],
        progress: {
          crawled: pages.length,
          total: pages.length,
          audited: i + 1,
        },
      });
    }

    // Phase 4: Compute summary
    const completed = auditedPages.filter(p => p.status === 'completed');
    const scores = completed.map(p => p.score).filter(s => s !== null);
    const allIssues = completed.flatMap(p => p.issues);

    const summary = {
      totalPages: pages.length,
      successfulPages: completed.length,
      errorPages: auditedPages.filter(p => p.status === 'error').length,
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
    if (browser) {
      await browser.close().catch((err) => {
        if (process.env.DEBUG) console.warn('Browser close error:', err.message);
      });
    }
  }
}
