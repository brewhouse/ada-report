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

    if (resolved.hostname !== base.hostname) return null;

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
  timeout: 20000,
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
    const ct = res.headers['content-type'] || '';
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
    for (const childUrl of childSitemaps) {
      const childXml = await fetchXml(childUrl);
      const childUrls = await parseSitemap(childXml, origin, depth + 1);
      urls.push(...childUrls);
    }
    return urls;
  }

  // Regular sitemap — contains <url><loc> entries
  $('url > loc').each((_, el) => {
    const loc = $(el).text().trim();
    try {
      const u = new URL(loc);
      // Accept same origin, or same hostname with different protocol
      if (u.hostname === new URL(origin).hostname) {
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
  const { origin, hostname } = new URL(rootUrl);
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

async function crawlWithBrowser(rootUrl, maxPages, onProgress) {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

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
      '--disable-extensions',
    ],
  });

  const visited = new Set();
  const queue = [rootUrl];
  const pages = [];

  try {
    while (queue.length > 0 && pages.length < maxPages) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);

      const page = await browser.newPage();
      try {
        await page.setUserAgent(
          'Mozilla/5.0 (compatible; ADA-Accessibility-Auditor/1.0)'
        );

        // Navigate and wait for network to go quiet (handles SPA / REST-driven content)
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Extra settle time for late-rendering frameworks (React, Vue, Angular, etc.)
        await new Promise(r => setTimeout(r, 2000));

        const finalUrl = page.url();
        const normFinal = normalizeUrl(rootUrl, finalUrl) || url;
        visited.add(normFinal);

        if (!pages.includes(normFinal)) {
          pages.push(normFinal);
          if (onProgress) onProgress(pages.length);
        }

        // Extract links from fully-rendered DOM
        const hrefs = await page.$$eval('a[href]', els =>
          els.map(e => e.getAttribute('href'))
        );

        for (const href of hrefs) {
          const norm = normalizeUrl(rootUrl, href);
          if (norm && !visited.has(norm) && !queue.includes(norm)) {
            queue.push(norm);
          }
        }
      } catch (err) {
        if (process.env.DEBUG) console.warn(`[crawler] skip ${url}: ${err.message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return pages;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function crawlWebsite(rootUrl, maxPages = 50, onProgress = null) {
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
    // Deduplicate, filter by same hostname, enforce maxPages
    const seen = new Set();
    const filtered = [];
    for (const url of sitemapUrls) {
      const norm = normalizeUrl(normalizedRoot, url);
      if (norm && !seen.has(norm)) {
        seen.add(norm);
        filtered.push(norm);
      }
      if (filtered.length >= maxPages) break;
    }
    if (onProgress) onProgress(filtered.length);
    return filtered;
  }

  // ── Strategy 2: Puppeteer crawl (JS-rendered / decoupled sites) ───────────
  console.log('[crawler] No sitemap found — falling back to Puppeteer crawl with JS rendering');
  return crawlWithBrowser(normalizedRoot, maxPages, onProgress);
}
