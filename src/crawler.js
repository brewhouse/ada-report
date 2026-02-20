import axios from 'axios';
import * as cheerio from 'cheerio';

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
  /\/(feed|rss|sitemap)\/?$/i,
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

    // Only follow same-origin links
    if (resolved.hostname !== base.hostname) return null;

    // Skip non-HTML file extensions
    const pathParts = resolved.pathname.split('.');
    if (pathParts.length > 1) {
      const ext = pathParts[pathParts.length - 1].toLowerCase().split('?')[0];
      if (SKIP_EXTENSIONS.has(ext)) return null;
    }

    // Remove fragment
    resolved.hash = '';

    // Normalize trailing slash on non-root paths
    if (resolved.pathname !== '/' && resolved.pathname.endsWith('/')) {
      resolved.pathname = resolved.pathname.slice(0, -1);
    }

    const normalized = resolved.href;

    // Skip noisy patterns
    if (SKIP_PATTERNS.some(p => p.test(normalized))) return null;

    return normalized;
  } catch {
    return null;
  }
}

export async function crawlWebsite(rootUrl, maxPages = 50, onProgress = null) {
  // Normalize root URL
  let normalizedRoot;
  try {
    const u = new URL(rootUrl);
    u.hash = '';
    normalizedRoot = u.href;
  } catch {
    throw new Error(`Invalid URL: ${rootUrl}`);
  }

  const visited = new Set();
  const queue = [normalizedRoot];
  const pages = [];

  const axiosInstance = axios.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ADA-Accessibility-Auditor/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    validateStatus: (status) => status < 400,
  });

  while (queue.length > 0 && pages.length < maxPages) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      const response = await axiosInstance.get(url);

      const contentType = response.headers['content-type'] || '';
      if (!contentType.includes('text/html')) continue;

      // Use final URL after redirects if available
      const finalUrl = response.request?.res?.responseUrl || url;
      const normalizedFinal = normalizeUrl(rootUrl, finalUrl) || url;

      if (!visited.has(normalizedFinal) || normalizedFinal === url) {
        visited.add(normalizedFinal);
        if (!pages.includes(normalizedFinal)) {
          pages.push(normalizedFinal);
          if (onProgress) onProgress(pages.length);
        }
      }

      // Parse links
      const $ = cheerio.load(response.data);
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        const normalized = normalizeUrl(url, href);
        if (normalized && !visited.has(normalized)) {
          queue.push(normalized);
        }
      });

    } catch (error) {
      // Page unreachable or error - skip it but log for debugging
      if (process.env.DEBUG) console.warn(`Crawl skip ${url}: ${error.message}`);
    }
  }

  return pages;
}
