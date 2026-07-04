// Proxy mode: serve the target dev server through the studio, injecting the
// inline-editing overlay into HTML pages. Pure Hono app; no port binding here.

import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_TAG = '<script type="module" src="/__i18n/inline.js"></script>';
const PRE_SCRIPT_TAG = '<script src="/__i18n/pre.js"></script>';

export function injectInlineScript(html) {
  if (html.includes('/__i18n/inline.js')) return html;
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i === -1 ? html + SCRIPT_TAG : html.slice(0, i) + SCRIPT_TAG + html.slice(i);
}

// Inserted immediately after the opening <head> tag so it runs before any site
// scripts (disables animations / signals prefers-reduced-motion while editing).
// Falls back to prepending at the very start of the doc when there's no <head>.
export function injectPreScript(html) {
  if (html.includes('/__i18n/pre.js')) return html;
  const m = html.match(/<head[^>]*>/i);
  if (!m) return PRE_SCRIPT_TAG + html;
  const i = m.index + m[0].length;
  return html.slice(0, i) + PRE_SCRIPT_TAG + html.slice(i);
}

// Hop-by-hop / re-computed headers we must not forward from the upstream response
// (fetch already decompressed the body, so content-encoding/length would lie).
const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

export function createProxyApp({ target, studioFetch, fetchFn = fetch }) {
  const app = new Hono();
  const origin = new URL(target).origin;

  const JS = {
    'inline.js': join(HERE, 'assets', 'inline.js'),
    'inline-map.mjs': join(HERE, 'inline-map.mjs'),
    'inline-state.mjs': join(HERE, 'inline-state.mjs'),
    'pre.js': join(HERE, 'assets', 'pre.js'),
  };
  app.get('/__i18n/:name', (c) => {
    const file = JS[c.req.param('name')];
    if (!file) return c.text('not found', 404);
    return c.body(readFileSync(file), 200, { 'content-type': 'text/javascript; charset=utf-8' });
  });

  // Same-origin bridge to the studio API: /__i18n/api/save → /api/save.
  app.all('/__i18n/api/*', (c) => {
    const url = new URL(c.req.raw.url);
    url.pathname = url.pathname.replace(/^\/__i18n\/api/, '/api');
    return studioFetch(new Request(url, c.req.raw));
  });

  app.all('*', async (c) => {
    const url = new URL(c.req.raw.url);
    let upstream;
    try {
      upstream = await fetchFn(new Request(origin + url.pathname + url.search, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: c.req.raw.body,
        redirect: 'manual',
        duplex: 'half',
      }));
    } catch {
      return c.html(`<h1>502 — upstream unreachable</h1><p>i18n Studio could not reach <code>${origin}</code>. Is the dev server running? Adjust with <code>--proxy &lt;url&gt;</code>.</p>`, 502);
    }
    const headers = new Headers();
    upstream.headers.forEach((v, k) => { if (!DROP.has(k.toLowerCase())) headers.set(k, v); });
    if ((upstream.headers.get('content-type') || '').includes('text/html')) {
      const withPre = injectPreScript(await upstream.text());
      return new Response(injectInlineScript(withPre), { status: upstream.status, headers });
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  return app;
}
