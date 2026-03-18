/**
 * Cross-page consistency checker for WCAG 3.2.4 (Consistent Identification).
 *
 * After all pages are audited, this module analyses the interactive element
 * labels collected from each page and flags cases where the same functional
 * component uses different accessible names across pages.
 *
 * Detects: search buttons, print actions, home links, social media icons,
 * repeated icon images (same src filename), and any element with aria-label.
 */

const SOCIAL_PLATFORMS = [
  'facebook', 'twitter', 'instagram', 'linkedin',
  'youtube', 'pinterest', 'tiktok',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lowercase, collapse whitespace, strip punctuation for comparison. */
function normalize(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Returns true if all names in the Set follow a consistent PREFIX pattern.
 * "Download PDF" / "Download DOCX" → first word is always "Download" → OK.
 * "Share on Facebook" / "Share on Twitter" → first two words consistent → OK.
 */
function hasConsistentPattern(normalizedNames) {
  if (normalizedNames.size <= 1) return true;
  const arr = [...normalizedNames];
  const w1 = arr.map(n => n.split(' ')[0]);
  if (new Set(w1).size === 1) return true;
  const w2 = arr.map(n => n.split(' ').slice(0, 2).join(' '));
  if (new Set(w2).size === 1) return true;
  return false;
}

/**
 * Assign zero or more functional group keys to an extracted element.
 * Elements with the same group key are expected to have the same accessible name.
 */
function getGroupKeys(el) {
  const keys = [];
  const norm  = normalize(el.name || '');
  const src   = (el.src  || '').toLowerCase();
  const href  = (el.href || '').toLowerCase();

  if (!norm) return keys;

  // ── Search actions ───────────────────────────────────────────────────────
  if (el.type === 'button' && /\b(search|find|lookup)\b/.test(norm)) {
    keys.push('button:search');
  }

  // ── Print actions ────────────────────────────────────────────────────────
  if (/\bprint\b/.test(norm)) {
    keys.push('action:print');
  }

  // ── Home links ───────────────────────────────────────────────────────────
  if (
    el.type === 'link' &&
    /^(\/|\/index\.html?|https?:\/\/[^/]+\/?(?:[#?].*)?$)/.test(el.href || '')
  ) {
    keys.push('link:home');
  }

  // ── Social media ─────────────────────────────────────────────────────────
  let matchedSocial = false;
  for (const platform of SOCIAL_PLATFORMS) {
    const re    = new RegExp(`\\b${platform}\\b`);
    const hrefRe = new RegExp(`${platform}\\.com`);
    if (re.test(norm) || re.test(src) || hrefRe.test(href)) {
      keys.push(`social:${platform}`);
      matchedSocial = true;
      break;
    }
  }
  // Catch "X" / x.com as Twitter
  if (!matchedSocial && (/\btweet\b/.test(norm) || /x\.com/.test(href) || /twitter\.com/.test(href))) {
    keys.push('social:twitter');
  }

  // ── Same icon file — fallback for icons that didn't match a named group ──
  // Skipped when a more specific group (social, print, etc.) already matched,
  // to avoid duplicate issues for the same inconsistency.
  if (el.type === 'image' && src && keys.length === 0) {
    const skipPattern = /\b(logo|banner|hero|background|avatar|profile|photo|placeholder|thumb|thumbnail|cover|header|bg|portrait|headshot)\b/;
    if (!skipPattern.test(src)) {
      keys.push(`icon-src:${src}`);
    }
  }

  return keys;
}

function describeGroup(groupKey) {
  if (groupKey === 'button:search')  return 'search button';
  if (groupKey === 'action:print')   return 'print action';
  if (groupKey === 'link:home')      return 'home link';
  if (groupKey.startsWith('social:')) {
    const platform = groupKey.split(':')[1];
    return `${platform[0].toUpperCase() + platform.slice(1)} social media icon/link`;
  }
  if (groupKey.startsWith('icon-src:')) return `repeated icon (${groupKey.split(':')[1]})`;
  return groupKey;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyse interactive-element labels collected across all completed pages.
 *
 * @param {Array<{url: string, interactiveLabels?: Array}>} completedPages
 * @returns {Array<{issue: object, primaryUrl: string}>}
 *   Each entry has a standard issue object (wcag '3.2.4') and the URL of the
 *   first affected page (used to decide which page to attach the issue to).
 */
export function analyzeConsistency(completedPages) {
  // groups: groupKey → { pageNames: Map<url, Set<normName>>, samples: Map<url, el> }
  const groups = new Map();

  for (const page of completedPages) {
    if (!page.interactiveLabels?.length) continue;
    for (const el of page.interactiveLabels) {
      for (const gk of getGroupKeys(el)) {
        if (!groups.has(gk)) groups.set(gk, { pageNames: new Map(), samples: new Map() });
        const g = groups.get(gk);
        if (!g.pageNames.has(page.url)) g.pageNames.set(page.url, new Set());
        g.pageNames.get(page.url).add(normalize(el.name));
        if (!g.samples.has(page.url)) g.samples.set(page.url, el);
      }
    }
  }

  const results = [];

  for (const [groupKey, g] of groups) {
    if (g.pageNames.size < 2) continue; // must appear on ≥2 pages

    // Collect all distinct normalised names across pages
    const allNorm = new Set();
    for (const names of g.pageNames.values()) {
      for (const n of names) allNorm.add(n);
    }
    if (allNorm.size <= 1) continue;                   // consistent — no issue
    if (hasConsistentPattern(allNorm)) continue;       // "Download X" pattern — OK

    const affectedUrls  = [...g.pageNames.keys()];
    const nameList = [...allNorm].map(n => `"${n}"`).join(', ');

    const elements = affectedUrls.slice(0, 8).map(url => {
      const sample = g.samples.get(url);
      const names  = [...g.pageNames.get(url)];
      return {
        snippet:     `<${sample?.type ?? 'element'}> accessible name: "${sample?.name}"`,
        selector:    new URL(url).pathname,
        label:       url,
        explanation: `Label on this page: "${names[0]}"`,
      };
    });

    results.push({
      primaryUrl: affectedUrls[0],
      issue: {
        id:           `consistency-${groupKey.replace(/[^a-z0-9]/g, '-')}`,
        title:        `Inconsistent identification: ${describeGroup(groupKey)}`,
        description:  `The same ${describeGroup(groupKey)} uses different accessible names across pages, which is a failure of WCAG 3.2.4. Names found: ${nameList}.`,
        severity:     'moderate',
        wcag:         '3.2.4',
        wcagLevel:    'AA',
        score:        0,
        displayValue: `${affectedUrls.length} pages, labels: ${nameList}`,
        elements,
        count:        affectedUrls.length,
      },
    });
  }

  return results;
}

/**
 * DOM extraction function to be passed to page.evaluate().
 * Must reference only browser globals — no closure variables.
 * Returns an array of interactive element descriptors.
 */
export function extractLabelsFn() {
  function getAccessibleName(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.trim().split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim() || '')
        .filter(Boolean).join(' ');
      if (text) return text;
    }
    const ariaLabel = el.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;
    const alt = el.getAttribute('alt');
    if (alt !== null) return alt.trim();
    const title = el.getAttribute('title')?.trim();
    if (title) return title;
    // Strip private-use / control characters, collapse whitespace
    return (el.textContent || '')
      .replace(/[\u0000-\u001F\u007F-\u009F\uE000-\uF8FF]/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  function getContext(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const tag  = node.tagName?.toUpperCase() || '';
      const role = node.getAttribute?.('role') || '';
      if (tag === 'HEADER'  || role === 'banner')        return 'header';
      if (tag === 'NAV'     || role === 'navigation')    return 'nav';
      if (tag === 'FOOTER'  || role === 'contentinfo')   return 'footer';
      if (tag === 'MAIN'    || role === 'main')          return 'main';
      if (tag === 'ASIDE'   || role === 'complementary') return 'aside';
      if (role === 'search')                             return 'search';
      if (tag === 'FORM'    || role === 'form')          return 'form';
      node = node.parentElement;
    }
    return 'unknown';
  }

  const results = [];
  const seen    = new Set();

  function add(type, name, extra) {
    if (!name) return;
    const ctx = extra.context || 'unknown';
    const key = `${type}|${name.toLowerCase().trim()}|${ctx}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ type, name, ...extra });
  }

  // Buttons
  document.querySelectorAll('button, [role="button"]').forEach(el => {
    const name = getAccessibleName(el);
    add('button', name, {
      ariaLabel: el.getAttribute('aria-label'),
      textContent: el.textContent?.trim().slice(0, 120),
      context: getContext(el),
    });
  });

  // Submit / button inputs
  document.querySelectorAll('input[type="submit"], input[type="button"]').forEach(el => {
    const name = el.getAttribute('aria-label')?.trim() || el.value?.trim() || '';
    add('button', name, {
      ariaLabel: el.getAttribute('aria-label'),
      textContent: el.value,
      context: getContext(el),
    });
  });

  // Images with non-empty alt
  document.querySelectorAll('img[alt]').forEach(el => {
    const alt = el.getAttribute('alt');
    if (!alt?.trim()) return; // skip decorative (empty alt)
    const src = (el.getAttribute('src') || '').split('?')[0].split('/').pop();
    add('image', alt.trim(), {
      ariaLabel: el.getAttribute('aria-label'),
      src,
      context: getContext(el),
    });
  });

  // SVG with accessible name (not hidden)
  document.querySelectorAll('svg').forEach(el => {
    if (el.getAttribute('aria-hidden') === 'true') return;
    const name = el.getAttribute('aria-label')?.trim()
      || el.querySelector('title')?.textContent?.trim();
    if (!name) return;
    add('image', name, {
      ariaLabel: el.getAttribute('aria-label'),
      src: null,
      context: getContext(el),
    });
  });

  // Links: home links, social media links, and links with aria-label
  const socialHosts = ['facebook.com','twitter.com','instagram.com','linkedin.com',
                       'youtube.com','x.com','tiktok.com','pinterest.com'];
  document.querySelectorAll('a[href]').forEach(el => {
    const ariaLabel = el.getAttribute('aria-label')?.trim();
    const href      = el.getAttribute('href') || '';
    const text      = el.textContent?.replace(/\s+/g, ' ').trim() || '';
    const name      = ariaLabel || text;
    if (!name) return;

    const isHome = /^(\/|\/index\.html?|https?:\/\/[^/]+\/?(?:[#?].*)?$)/.test(href);
    const isSocialHref = socialHosts.some(h => href.includes(h));
    const isSocialName = /\b(facebook|twitter|instagram|linkedin|youtube|pinterest|tiktok)\b/i.test(name);

    if (isHome || isSocialHref || isSocialName || ariaLabel) {
      add('link', name, {
        ariaLabel,
        href: href.slice(0, 200),
        text: text.slice(0, 120),
        context: getContext(el),
      });
    }
  });

  return results.slice(0, 400); // safety cap
}
