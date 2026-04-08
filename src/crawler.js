import axios from 'axios';
import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';

const SKIP_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv',
  'zip', 'tar', 'gz', 'rar', '7z',
  'css', 'js', 'json', 'xml', 'rss', 'atom',
  'mp4', 'mp3', 'wav', 'avi', 'mov', 'wmv', 'flv', 'mkv',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'exe', 'dmg', 'apk', 'ipa',
]);

const SKIP_PATTERNS = [
  /\/(wp-json|wp-admin|wp-includes)\//i,
  /\/(feed|rss)\/?$/i,
  /\.(php)$/i,
  /[?&](s|search|q|query)=/i,
  /\/(tag|category|author)\//i,
];

function normalizeUrl(baseUrl, href) {
  if (!href || typeof href !== 'string') return null;
  href = href.trim();
  if (!href || href.startsWith('#') || href.startsWith('mailto:') ||
      href.startsWith('tel:') || href.startsWith('javascript:') ||
      href.startsWith('data:')) return null;

  try {
    const base = new URL(baseUrl);
    const resolved = new URL(href, baseUrl);

    // Treat www.example.com and example.com as the same site
    const bareBase = base.hostname.replace(/^www\./, '');
    const bareResolved = resolved.hostname.replace(/^www\./, '');
    if (bareResolved !== bareBase) return null;
    // Normalize to the root URL's hostname form to eliminate www/non-www duplicates
    if (resolved.hostname !== base.hostname) {
      resolved.hostname = base.hostname;
    }

    const pathParts = resolved.pathname.split('.');
    if (pathParts.length > 1) {
      const ext = pathParts[pathParts.length - 1].toLowerCase().split('?')[0];
      if (SKIP_EXTENSIONS.has(ext)) return null;
    }

    resolved.hash = '';

    if (resolved.pathname !== '/' && resolved.pathname.endsWith('/')) {
      resolved.pathname = resolved.pathname.slice(0, -1);
    }

    const normalized = resolved.href;

    if (SKIP_PATTERNS.some(p => p.test(normalized))) return null;

    return normalized;
  } catch {
    return null;
  }
}

// ── HTTP client ────────────────────────────────────────────────────────────────

const HTTP = axios.create({
  timeout: 45000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; ADA-Accessibility-Auditor/1.0)',
    'Accept': 'text/html,application/xhtml+xml,application/xml,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  },
  validateStatus: s => s < 400,
});

// ── Sitemap discovery ──────────────────────────────────────────────────────────

async function fetchXml(url) {
  try {
    const res = await HTTP.get(url);
    // Accept XML or plain text (some servers misconfigure content-type)
    if (typeof res.data === 'string' && res.data.trim().startsWith('<')) {
      return res.data;
    }
    return null;
  } catch {
    return null;
  }
}

async function parseSitemap(xml, origin, depth = 0) {
  if (!xml || depth > 4) return [];
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = [];

  // Sitemap index — contains <sitemap><loc> entries pointing to child sitemaps
  const childSitemaps = [];
  $('sitemap > loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) childSitemaps.push(loc);
  });

  if (childSitemaps.length > 0) {
    // Fetch all child sitemaps in parallel for faster discovery.
    const childXmls = await Promise.all(childSitemaps.map(u => fetchXml(u)));
    const childResults = await Promise.all(
      childXmls.map(xml => parseSitemap(xml, origin, depth + 1))
    );
    for (const childUrls of childResults) urls.push(...childUrls);
    return urls;
  }

  // Regular sitemap — contains <url><loc> entries
  $('url > loc').each((_, el) => {
    const loc = $(el).text().trim();
    try {
      const u = new URL(loc);
      // Accept same origin, or same hostname with different protocol or www/non-www variant
      const originHost = new URL(origin).hostname;
      if (u.hostname.replace(/^www\./, '') === originHost.replace(/^www\./, '')) {
        // Normalize hostname to origin's form to eliminate www/non-www duplicates
        u.hostname = originHost;
        // Normalize trailing slash, remove fragment
        u.hash = '';
        if (u.pathname !== '/' && u.pathname.endsWith('/')) {
          u.pathname = u.pathname.slice(0, -1);
        }
        urls.push(u.href);
      }
    } catch {}
  });

  return urls;
}

async function discoverFromSitemap(rootUrl) {
  const { origin } = new URL(rootUrl);
  const candidates = [];

  // 1. Check robots.txt for Sitemap: directives (highest priority)
  try {
    const res = await HTTP.get(`${origin}/robots.txt`);
    const lines = String(res.data || '').split('\n');
    for (const line of lines) {
      const m = line.match(/^Sitemap:\s*(.+)/i);
      if (m) {
        const loc = m[1].trim();
        if (!candidates.includes(loc)) candidates.push(loc);
      }
    }
  } catch {}

  // 2. Standard fallback locations
  for (const path of [
    '/sitemap_index.xml',
    '/sitemap.xml',
    '/sitemap-index.xml',
    '/wp-sitemap.xml',
    '/page-sitemap.xml',
  ]) {
    const url = `${origin}${path}`;
    if (!candidates.includes(url)) candidates.push(url);
  }

  for (const candidate of candidates) {
    const xml = await fetchXml(candidate);
    if (!xml) continue;
    const urls = await parseSitemap(xml, origin);
    if (urls.length > 0) {
      console.log(`[crawler] Sitemap found at ${candidate} — ${urls.length} URLs`);
      return urls;
    }
  }

  return [];
}

// ── Puppeteer crawler (fallback for JS-heavy / decoupled sites) ────────────────

async function crawlWithBrowser(rootUrl, maxPages, onProgress, excludeUrls = null) {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const CRAWL_CONCURRENCY = 3;

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--disable-crash-reporter',
      '--disable-extensions',
    ],
  });

  const visited = new Set();
  const queued = new Set([rootUrl]);
  const queue = [rootUrl];
  const pages = [];

  async function crawlPage(url) {
    const page = await browser.newPage();
    try {
      await page.setUserAgent(
        'Mozilla/5.0 (compatible; ADA-Accessibility-Auditor/1.0)'
      );

      // Fast initial load — DOMContentLoaded is enough for PHP/server-rendered pages
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Detect whether this is a server-rendered page (PHP/WordPress) or a JS SPA.
      const [initialLinks, initialTextLen] = await Promise.all([
        page.$$eval('a[href]', els => els.length).catch(() => 0),
        page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0),
      ]);
      const isServerRendered = initialLinks >= 5 || initialTextLen > 400;

      if (!isServerRendered) {
        // SPA / JS-rendered — wait for network to go quiet then give React time to paint
        await page.waitForNetworkIdle({ idleTime: 500, timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
      }

      const finalUrl = page.url();
      const normFinal = normalizeUrl(rootUrl, finalUrl) || url;
      visited.add(normFinal);

      if (!pages.includes(normFinal) && !(excludeUrls && excludeUrls.has(normFinal))) {
        pages.push(normFinal);
        if (onProgress) onProgress(pages.length);
      }

      // Extract links from fully-rendered DOM
      const hrefs = await page.$$eval('a[href]', els =>
        els.map(e => e.getAttribute('href'))
      );

      for (const href of hrefs) {
        const norm = normalizeUrl(rootUrl, href);
        if (norm && !visited.has(norm) && !queued.has(norm) && !(excludeUrls && excludeUrls.has(norm))) {
          queued.add(norm);
          queue.push(norm);
        }
      }
    } catch (err) {
      if (process.env.DEBUG) console.warn(`[crawler] skip ${url}: ${err.message}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  try {
    // Process queue with up to CRAWL_CONCURRENCY parallel page loads.
    while (queue.length > 0 && pages.length < maxPages) {
      const batch = [];
      while (batch.length < CRAWL_CONCURRENCY && queue.length > 0 && (pages.length + batch.length) < maxPages) {
        const url = queue.shift();
        if (!url || visited.has(url)) continue;
        visited.add(url);
        batch.push(url);
      }
      if (batch.length === 0) break;
      await Promise.allSettled(batch.map(url => crawlPage(url)));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return pages;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch all URLs listed in the given sitemap URLs (for building an exclude set).
 * @param {string[]} sitemapUrls - Array of sitemap XML URLs to fetch and parse.
 * @returns {Promise<Set<string>>} Set of normalized URLs found in those sitemaps.
 */
export async function fetchUrlsFromSitemaps(sitemapUrls) {
  const excluded = new Set();
  for (const sitemapUrl of sitemapUrls) {
    try {
      const origin = new URL(sitemapUrl).origin;
      const xml = await fetchXml(sitemapUrl);
      if (!xml) continue;
      const urls = await parseSitemap(xml, origin);
      for (const url of urls) {
        try {
          const u = new URL(url);
          u.hash = '';
          if (u.pathname !== '/' && u.pathname.endsWith('/')) {
            u.pathname = u.pathname.slice(0, -1);
          }
          excluded.add(u.href);
        } catch {}
      }
    } catch {}
  }
  return excluded;
}

export async function crawlWebsite(rootUrl, maxPages = 50, onProgress = null, excludeUrls = null) {
  let normalizedRoot;
  try {
    const u = new URL(rootUrl);
    u.hash = '';
    if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    normalizedRoot = u.href;
  } catch {
    throw new Error(`Invalid URL: ${rootUrl}`);
  }

  // ── Strategy 1: XML sitemap (fast, works for all site types) ──────────────
  const sitemapUrls = await discoverFromSitemap(normalizedRoot);

  if (sitemapUrls.length > 0) {
    // Deduplicate, filter by same hostname, apply excludes, enforce maxPages
    const seen = new Set();
    const filtered = [];
    for (const url of sitemapUrls) {
      const norm = normalizeUrl(normalizedRoot, url);
      if (norm && !seen.has(norm) && !(excludeUrls && excludeUrls.has(norm))) {
        seen.add(norm);
        filtered.push(norm);
      }
      if (filtered.length >= maxPages) break;
    }
    if (excludeUrls && excludeUrls.size > 0) {
      console.log(`[crawler] Excluded ${sitemapUrls.length - filtered.length} URL(s) via exclude sitemaps`);
    }
    if (onProgress) onProgress(filtered.length);
    return filtered;
  }

  // ── Strategy 2: Puppeteer crawl (JS-rendered / decoupled sites) ───────────
  console.log('[crawler] No sitemap found — falling back to Puppeteer crawl with JS rendering');
  return crawlWithBrowser(normalizedRoot, maxPages, onProgress, excludeUrls);
}
