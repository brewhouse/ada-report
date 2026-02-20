/**
 * wp-fixer.js
 * Uses Claude (Anthropic API) with WordPress REST API tools to fix accessibility issues.
 *
 * Auto-fixable via WP REST API: image alt text, document titles, link text in post content.
 * Everything else: Claude returns a specific code snippet for the developer to apply.
 *
 * Required env var: ANTHROPIC_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

// Lighthouse audit IDs that can potentially be fixed via WP REST API (content-level)
const CONTENT_FIXABLE_IDS = new Set([
  'image-alt',
  'image-redundant-alt',
  'document-title',
]);

// ── WordPress REST API helpers ────────────────────────────────────────────────

async function wpApi(baseUrl, username, password, method, endpoint, body = null) {
  const credentials = Buffer.from(`${username}:${password}`).toString('base64');
  const url = `${baseUrl.replace(/\/$/, '')}/wp-json/wp/v2/${endpoint}`;
  const opts = {
    method,
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`WP API ${method} /wp/v2/${endpoint} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

async function wpGetPostByUrl(baseUrl, username, password, pageUrl) {
  const { pathname } = new URL(pageUrl);
  const slug = pathname.replace(/\/$/, '').split('/').filter(Boolean).pop() || '';
  const fields = '_fields=id,title,status,link,type';

  for (const type of ['pages', 'posts']) {
    try {
      const qs = slug ? `slug=${encodeURIComponent(slug)}&${fields}` : `per_page=1&orderby=menu_order&order=asc&${fields}`;
      const results = await wpApi(baseUrl, username, password, 'GET', `${type}?${qs}`);
      if (results.length > 0) return results[0];
    } catch {}
  }
  return null;
}

async function wpGetMediaBySrc(baseUrl, username, password, imgSrc) {
  const filename = imgSrc.split('/').pop().replace(/\?.*$/, '').replace(/\.[^.]+$/, '');
  const results = await wpApi(
    baseUrl, username, password, 'GET',
    `media?search=${encodeURIComponent(filename)}&per_page=10&_fields=id,alt_text,source_url,title`
  );
  return results.find(m =>
    m.source_url === imgSrc ||
    m.source_url.split('?')[0] === imgSrc.split('?')[0]
  ) || results[0] || null;
}

// ── Tool definitions for Claude ───────────────────────────────────────────────

const WP_TOOLS = [
  {
    name: 'wp_get_post',
    description: 'Find a WordPress post or page by its public URL. Returns the post ID and current title.',
    input_schema: {
      type: 'object',
      properties: {
        page_url: { type: 'string', description: 'The full public URL of the page or post.' },
      },
      required: ['page_url'],
    },
  },
  {
    name: 'wp_get_media',
    description: 'Find a WordPress media attachment by its image src URL. Returns the media ID and current alt text.',
    input_schema: {
      type: 'object',
      properties: {
        img_src: { type: 'string', description: 'The full src URL of the image element.' },
      },
      required: ['img_src'],
    },
  },
  {
    name: 'wp_update_media_alt',
    description: 'Update the alt text of a WordPress media attachment.',
    input_schema: {
      type: 'object',
      properties: {
        media_id: { type: 'number', description: 'The WordPress media attachment ID.' },
        alt_text: { type: 'string', description: 'New alt text. Use an empty string for purely decorative images.' },
      },
      required: ['media_id', 'alt_text'],
    },
  },
  {
    name: 'wp_update_post_title',
    description: 'Update the title of a WordPress page or post.',
    input_schema: {
      type: 'object',
      properties: {
        post_id: { type: 'number', description: 'The WordPress post/page ID.' },
        title: { type: 'string', description: 'The new descriptive page title.' },
      },
      required: ['post_id', 'title'],
    },
  },
  {
    name: 'fix_complete',
    description: 'Call this after all fixes have been successfully applied.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief description of what was fixed (e.g. "Updated alt text on 3 images").' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'cannot_fix',
    description: 'Call this if the issue cannot be fixed via the REST API tools and requires a code/theme change instead.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'One sentence explaining why auto-fix is not possible.' },
        code_suggestion: { type: 'string', description: 'The exact PHP, CSS, or HTML code a developer should apply to fix this.' },
      },
      required: ['reason', 'code_suggestion'],
    },
  },
];

// ── Agentic fix with Claude ───────────────────────────────────────────────────

async function runAgenticFix({ wpBaseUrl, username, password, pageUrl, issue }) {
  const system = `You are a WordPress accessibility expert with access to the WordPress REST API for site: ${wpBaseUrl}

Your task: fix the accessibility issue on page: ${pageUrl}

Rules:
- For missing image alt text: look up each affected image with wp_get_media (using the src from the snippet), write appropriate descriptive alt text based on the filename and context, then call wp_update_media_alt. Use alt_text="" for decorative images.
- For missing or empty document title: find the page with wp_get_post, then call wp_update_post_title with a meaningful title.
- If you cannot fix it via the available tools, call cannot_fix with a specific code snippet.
- Once all fixes are applied, call fix_complete with a summary.
- Work efficiently. Do not ask for confirmation. Apply fixes directly.`;

  const userMsg = `Fix this accessibility issue:

Title: ${issue.title}
Severity: ${issue.severity}
WCAG: ${issue.wcag} (${issue.wcagLevel})
Description: ${issue.description}
${issue.elements?.length > 0
    ? `\nAffected elements (up to 5):\n${issue.elements.slice(0, 5).map(el =>
        `  • Snippet: ${el.snippet || el.selector || '(none)'}${el.explanation ? `\n    Note: ${el.explanation}` : ''}`
      ).join('\n')}`
    : ''
  }`;

  const messages = [{ role: 'user', content: userMsg }];

  for (let turn = 0; turn < 12; turn++) {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 2048,
      system,
      tools: WP_TOOLS,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;

    const toolResults = [];
    let fixComplete = null;
    let cannotFix = null;

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      let result;
      try {
        switch (block.name) {
          case 'wp_get_post': {
            const post = await wpGetPostByUrl(wpBaseUrl, username, password, block.input.page_url);
            result = post ? JSON.stringify(post) : 'No post/page found for that URL';
            break;
          }
          case 'wp_get_media': {
            const media = await wpGetMediaBySrc(wpBaseUrl, username, password, block.input.img_src);
            result = media ? JSON.stringify(media) : 'No media attachment found for that src URL';
            break;
          }
          case 'wp_update_media_alt': {
            await wpApi(wpBaseUrl, username, password, 'POST',
              `media/${block.input.media_id}`, { alt_text: block.input.alt_text });
            result = `Updated alt text to: "${block.input.alt_text}"`;
            break;
          }
          case 'wp_update_post_title': {
            // Try posts first, then pages
            let updated = false;
            for (const type of ['posts', 'pages']) {
              try {
                await wpApi(wpBaseUrl, username, password, 'POST',
                  `${type}/${block.input.post_id}`, { title: block.input.title });
                updated = true;
                break;
              } catch {}
            }
            result = updated ? `Updated title to: "${block.input.title}"` : 'Could not update title — post ID not found in posts or pages';
            break;
          }
          case 'fix_complete': {
            fixComplete = block.input.summary;
            result = 'Fix complete recorded';
            break;
          }
          case 'cannot_fix': {
            cannotFix = { reason: block.input.reason, code: block.input.code_suggestion };
            result = 'Cannot-fix recorded';
            break;
          }
          default:
            result = 'Unknown tool';
        }
      } catch (err) {
        result = `Error: ${err.message}`;
      }

      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }

    if (fixComplete) return { type: 'fixed', summary: fixComplete };
    if (cannotFix) return { type: 'suggestion', reason: cannotFix.reason, code: cannotFix.code };

    messages.push({ role: 'user', content: toolResults });
  }

  return { type: 'suggestion', reason: 'Could not auto-fix this issue via REST API.', code: '' };
}

// ── Code suggestion only (for theme-level issues) ────────────────────────────

async function getCodeSuggestion({ issue, pageUrl }) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `Provide a specific WordPress code fix for this accessibility issue.

Issue: ${issue.title}
WCAG: ${issue.wcag} (${issue.wcagLevel})
Page: ${pageUrl}
Description: ${issue.description}
${issue.elements?.length > 0 ? `Affected elements:\n${issue.elements.slice(0, 3).map(el => `- ${el.snippet || el.selector}`).join('\n')}` : ''}

Respond in exactly this format — nothing else:
EXPLANATION: <one sentence describing what to change>
CODE:
\`\`\`<language>
<exact code to add or modify>
\`\`\``,
    }],
  });

  const text = response.content[0]?.text || '';
  const explanationMatch = text.match(/EXPLANATION:\s*(.+)/);
  const codeMatch = text.match(/CODE:\s*```[\w]*\n([\s\S]*?)```/);

  return {
    type: 'suggestion',
    reason: explanationMatch?.[1]?.trim() || issue.description,
    code: codeMatch?.[1]?.trim() || text,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.wpBaseUrl   - e.g. "https://example.com"
 * @param {string} opts.username    - WordPress username
 * @param {string} opts.password    - WordPress application password
 * @param {string} opts.pageUrl     - full URL of the page being fixed
 * @param {object} opts.issue       - issue object from the audit (id, title, severity, wcag, elements…)
 * @returns {Promise<{type:'fixed',summary:string}|{type:'suggestion',reason:string,code:string}>}
 */
export async function applyFix({ wpBaseUrl, username, password, pageUrl, issue }) {
  if (CONTENT_FIXABLE_IDS.has(issue.id)) {
    return runAgenticFix({ wpBaseUrl, username, password, pageUrl, issue });
  }
  return getCodeSuggestion({ issue, pageUrl });
}
