# Inline On-Page Editing (Proxy Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The studio proxies a target dev server, injects an overlay that makes matched i18n texts editable in place, and auto-saves edits through the existing AST-safe save pipeline.

**Architecture:** A second Hono app (`proxy.mjs`) on `PORT + 1` forwards everything to the target dev server, injecting one `<script type="module">` into HTML responses. The overlay (`assets/inline.js`) is a browser ES module that imports pure logic from `inline-map.mjs` (isomorphic — same file is unit-tested in Node and served to the browser). All saves go through the existing `/api/save` / `/api/save-many` routes, reached same-origin via `/__i18n/api/*`.

**Tech Stack:** Node ≥ 20 plain ESM, Hono + @hono/node-server (already deps), `node:test` + `node:assert/strict`, ts-morph (existing save layer, untouched). No new dependencies.

## Global Constraints

- Spec: `docs/factory/2026-07-03-inline-editing/{goal,design}.md`. API field for a key path is **`path`** (matches `server.mjs`), not `keyPath` as design.md says.
- TDD: no production code without a failing test first. Runner is `node --test` (`npm test`). No wall-clock/sleep assertions.
- `inline-map.mjs` must stay **isomorphic**: no Node imports (`node:*`, deps) — it runs in the browser as-is.
- Importing any `.mjs` module must have no side effects (no port binding); servers start only under `main` in `server.mjs`.
- Config-dependent test files set `process.env.I18N_STRINGS_DIR` to a `mkdtempSync` fixture and dynamic-`import()` the module (see `test/strings.test.mjs` for the pattern). `inline-map.mjs` and `proxy.mjs` are config-independent — plain static imports are fine.
- Reserved URL prefix on the proxy: `/__i18n/`.
- Commit after every green test cycle.

---

### Task 1: `inline-map.mjs` — entity decoding + value normalization

**Files:**
- Create: `inline-map.mjs`
- Test: `test/inline-map.test.mjs`

**Interfaces:**
- Produces: `decodeEntities(s: string): string`, `normalizeValue(s: string): string`. Later tasks (overlay, Task 5) call `normalizeValue` to index corpus values and match DOM innerHTML.

- [ ] **Step 1: Write the failing tests**

```js
// test/inline-map.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, normalizeValue } from '../inline-map.mjs';

test('decodeEntities: named, numeric decimal and hex refs', () => {
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  assert.equal(decodeEntities('5&nbsp;weeks &amp; more'), '5 weeks & more');
  assert.equal(decodeEntities('&lt;b&gt;&quot;x&quot;&#39;'), `<b>"x"'`);
  assert.equal(decodeEntities('go &#8599; and &#x2192; there'), 'go ↗ and → there');
  assert.equal(decodeEntities('&mdash;&rarr;&hellip;'), '—→…');
  assert.equal(decodeEntities('no entities'), 'no entities');
  assert.equal(decodeEntities('&unknown; stays'), '&unknown; stays');
});

test('normalizeValue: entity/NBSP-insensitive, whitespace-collapsed', () => {
  // The core matching property: source string and browser innerHTML normalize equal.
  assert.equal(normalizeValue('July&nbsp;21'), normalizeValue('July 21'));
  assert.equal(normalizeValue('a  b\n c'), 'a b c');
  assert.equal(normalizeValue('  padded  '), 'padded');
  assert.equal(
    normalizeValue('<b>Tuesday theory</b> and <b>Thursday practice</b>'),
    normalizeValue('<b>Tuesday  theory</b>\n  and <b>Thursday practice</b>'),
  );
  // Different text must NOT collide.
  assert.notEqual(normalizeValue('July 21'), normalizeValue('July 22'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/ai_projects/i18n-studio && node --test test/inline-map.test.mjs`
Expected: FAIL — `Cannot find module '../inline-map.mjs'`

- [ ] **Step 3: Write minimal implementation**

```js
// inline-map.mjs
// Pure, isomorphic matching/serialization logic for the inline on-page editor.
// Runs in Node (unit tests) AND in the browser (imported by assets/inline.js):
// no Node imports, no DOM access — string in, string out.

const NAMED = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←',
  middot: '·', times: '×', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', thinsp: ' ',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const n = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const named = NAMED[body.toLowerCase()];
    return named !== undefined ? named : m;
  });
}

// Two representations of the same string (source literal vs browser innerHTML)
// must normalize equal; different copy must not collide.
export function normalizeValue(s) {
  return decodeEntities(s)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/inline-map.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add inline-map.mjs test/inline-map.test.mjs
git commit -m "feat(inline): entity decoding + value normalization for on-page matching"
```

---

### Task 2: `inline-map.mjs` — serialization, tag check, corpus index

**Files:**
- Modify: `inline-map.mjs`
- Test: `test/inline-map.test.mjs` (append)

**Interfaces:**
- Consumes: `normalizeValue` from Task 1.
- Produces:
  - `serializeEdited(innerHTML: string): string` — browser innerHTML → source-string form.
  - `tagsChanged(before: string, after: string): boolean` — true if the tag-name multiset differs.
  - `buildIndex(files, lang): Map<string, Array<{file, path, value}>>` — `files` is the `/api/strings` payload's `files` array; keys are `normalizeValue(value)`; only editable, non-`interp`, non-empty cells of `lang` are indexed.

- [ ] **Step 1: Write the failing tests**

Append to `test/inline-map.test.mjs`:

```js
import { serializeEdited, tagsChanged, buildIndex } from '../inline-map.mjs';

test('serializeEdited: NBSP re-encoded, artifacts stripped, tags kept', () => {
  assert.equal(serializeEdited('July 21'), 'July&nbsp;21');
  assert.equal(serializeEdited('plain text'), 'plain text');
  assert.equal(serializeEdited('<b>bold</b> stays'), '<b>bold</b> stays');
  // Browser editing artifacts: trailing <br>, empty inline tags, injected style attrs.
  assert.equal(serializeEdited('text<br>'), 'text');
  assert.equal(serializeEdited('a <b></b>b'), 'a b');
  assert.equal(serializeEdited('<span style="color: red;" class="nb">x</span>'), '<span class="nb">x</span>');
  assert.equal(serializeEdited('  padded  '), 'padded');
});

test('serializeEdited: round-trip is normalize-stable', () => {
  const src = 'for <b>5&nbsp;weeks</b> from <b>July&nbsp;21</b>.';
  // What a browser renders back for this string (entities become characters):
  const dom = 'for <b>5 weeks</b> from <b>July 21</b>.';
  assert.equal(normalizeValue(serializeEdited(dom)), normalizeValue(src));
});

test('tagsChanged: multiset compare of tag names', () => {
  assert.equal(tagsChanged('<b>a</b> <i>b</i>', '<i>x</i> <b>y</b>'), false);
  assert.equal(tagsChanged('<b>a</b>', 'a'), true);
  assert.equal(tagsChanged('a', 'a'), false);
  assert.equal(tagsChanged('<b>a</b>', '<b>a</b><b>b</b>'), true);
});

test('buildIndex: only editable non-interp cells of the language, grouped by normalized value', () => {
  const files = [
    { file: 'A.ts', entries: [
      { path: 'h', en: { value: 'July&nbsp;21', editable: true }, ru: { value: '21 июля', editable: true } },
      { path: 'n', en: { value: '42', editable: false }, ru: null },
      { path: 't', en: { value: 'x ${y}', editable: true, interp: true }, ru: null },
      { path: 'e', en: { value: '', editable: true }, ru: null },
    ]},
    { file: 'B.ts', entries: [
      { path: 'dup', en: { value: 'July 21', editable: true }, ru: null },
    ]},
  ];
  const idx = buildIndex(files, 'en');
  const hits = idx.get(normalizeValue('July 21'));
  assert.equal(hits.length, 2); // A.ts h + B.ts dup — same normalized value
  assert.deepEqual(hits[0], { file: 'A.ts', path: 'h', value: 'July&nbsp;21' });
  assert.equal(idx.get(normalizeValue('42')), undefined);
  assert.equal(idx.get(normalizeValue('x ${y}')), undefined);
  const ruIdx = buildIndex(files, 'ru');
  assert.equal(ruIdx.get(normalizeValue('21 июля')).length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/inline-map.test.mjs`
Expected: FAIL — `serializeEdited` is not exported

- [ ] **Step 3: Write minimal implementation**

Append to `inline-map.mjs`:

```js
// innerHTML → source-string form. Conservative: only reverse what browsers
// predictably mangle; never restructure the user's markup.
export function serializeEdited(innerHTML) {
  return String(innerHTML)
    .replace(/<(b|i|em|strong|span|u|s|small|mark|code)(\s[^>]*)?>\s*<\/\1>/gi, '') // empty inline tags
    .replace(/(<br\s*\/?>\s*)+$/i, '')                                             // trailing <br> artifacts
    .replace(/\s+style="[^"]*"/gi, '')                                             // injected style attrs
    .replace(/ /g, '&nbsp;')
    .trim();
}

function tagMultiset(s) {
  const names = [...String(s).matchAll(/<([a-z][a-z0-9-]*)[\s/>]/gi)].map((m) => m[1].toLowerCase());
  return names.sort().join(',');
}

export function tagsChanged(before, after) {
  return tagMultiset(before) !== tagMultiset(after);
}

// /api/strings `files` payload → Map of normalized value → candidate entries.
export function buildIndex(files, lang) {
  const idx = new Map();
  for (const f of files) for (const e of f.entries) {
    const cell = e[lang];
    if (!cell || !cell.editable || cell.interp) continue;
    if (typeof cell.value !== 'string' || !cell.value.trim()) continue;
    const key = normalizeValue(cell.value);
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ file: f.file, path: e.path, value: cell.value });
  }
  return idx;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/inline-map.test.mjs`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add inline-map.mjs test/inline-map.test.mjs
git commit -m "feat(inline): serialization, tag-integrity check, corpus index"
```

---

### Task 3: `proxy.mjs` — forwarding app with HTML injection

**Files:**
- Create: `proxy.mjs`
- Test: `test/proxy.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks (injection is plain string work).
- Produces:
  - `injectInlineScript(html: string): string` — inserts `<script type="module" src="/__i18n/inline.js"></script>` before the last `</body>` (case-insensitive), or appends if absent. Idempotent.
  - `createProxyApp({ target, studioFetch, fetchFn = fetch }): Hono` — `target` is a URL string; `studioFetch` is the studio app's `.fetch`; `fetchFn` is injectable for tests. Routes: `/__i18n/inline.js` and `/__i18n/inline-map.mjs` serve local files; `/__i18n/api/*` rewrites to `/api/*` against `studioFetch`; everything else forwards to `target`, injecting into `text/html` responses; upstream failure → 502 page naming the target.

- [ ] **Step 1: Write the failing tests**

```js
// test/proxy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { injectInlineScript, createProxyApp } from '../proxy.mjs';

const TAG = '<script type="module" src="/__i18n/inline.js"></script>';

test('injectInlineScript: before </body>, case-insensitive, idempotent, fallback append', () => {
  assert.equal(injectInlineScript('<body>x</body>'), `<body>x${TAG}</body>`);
  assert.equal(injectInlineScript('<BODY>x</BODY>'), `<BODY>x${TAG}</BODY>`);
  assert.equal(injectInlineScript('no body tag'), `no body tag${TAG}`);
  const once = injectInlineScript('<body>x</body>');
  assert.equal(injectInlineScript(once), once); // idempotent
});

function fakeUpstream(routes) {
  return async (req) => {
    const url = new URL(req.url);
    const hit = routes[url.pathname];
    if (!hit) return new Response('not found', { status: 404 });
    if (hit instanceof Error) throw hit;
    return new Response(hit.body, { status: 200, headers: hit.headers });
  };
}

function makeProxy(routes) {
  const studio = new Hono();
  studio.get('/api/strings', (c) => c.json({ marker: 'studio' }));
  return createProxyApp({
    target: 'http://localhost:9999',
    studioFetch: studio.fetch,
    fetchFn: fakeUpstream(routes),
  });
}

test('HTML responses get the script injected exactly once', async () => {
  const app = makeProxy({ '/': { body: '<html><body>hi</body></html>', headers: { 'content-type': 'text/html; charset=utf-8' } } });
  const res = await app.request('/');
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.equal(text.split('/__i18n/inline.js').length - 1, 1);
  assert.match(text, /hi<script type="module"/);
});

test('non-HTML passes through byte-identical', async () => {
  const app = makeProxy({ '/app.css': { body: 'body{color:red}', headers: { 'content-type': 'text/css' } } });
  const res = await app.request('/app.css');
  assert.equal(await res.text(), 'body{color:red}');
});

test('/__i18n/api/* is answered by the studio app, not the upstream', async () => {
  const app = makeProxy({});
  const res = await app.request('/__i18n/api/strings');
  assert.deepEqual(await res.json(), { marker: 'studio' });
});

test('/__i18n/inline.js and /__i18n/inline-map.mjs serve JS', async () => {
  const app = makeProxy({});
  for (const p of ['/__i18n/inline.js', '/__i18n/inline-map.mjs']) {
    const res = await app.request(p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get('content-type'), /javascript/);
  }
});

test('upstream failure yields a 502 page naming the target', async () => {
  const app = makeProxy({ '/': new Error('ECONNREFUSED') });
  const res = await app.request('/');
  assert.equal(res.status, 502);
  assert.match(await res.text(), /localhost:9999/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/proxy.test.mjs`
Expected: FAIL — `Cannot find module '../proxy.mjs'`

Note: `/__i18n/inline.js` doesn't exist yet — create a stub so the asset test can pass in this task:

```bash
printf '// i18n-studio inline overlay — implemented in Task 5\nexport {};\n' > assets/inline.js
```

- [ ] **Step 3: Write minimal implementation**

```js
// proxy.mjs
// Proxy mode: serve the target dev server through the studio, injecting the
// inline-editing overlay into HTML pages. Pure Hono app; no port binding here.

import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_TAG = '<script type="module" src="/__i18n/inline.js"></script>';

export function injectInlineScript(html) {
  if (html.includes('/__i18n/inline.js')) return html;
  const i = html.toLowerCase().lastIndexOf('</body>');
  return i === -1 ? html + SCRIPT_TAG : html.slice(0, i) + SCRIPT_TAG + html.slice(i);
}

// Hop-by-hop / re-computed headers we must not forward from the upstream response
// (fetch already decompressed the body, so content-encoding/length would lie).
const DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

export function createProxyApp({ target, studioFetch, fetchFn = fetch }) {
  const app = new Hono();
  const origin = new URL(target).origin;

  const JS = { 'inline.js': join(HERE, 'assets', 'inline.js'), 'inline-map.mjs': join(HERE, 'inline-map.mjs') };
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
      return new Response(injectInlineScript(await upstream.text()), { status: upstream.status, headers });
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  return app;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/proxy.test.mjs`
Expected: PASS (6 tests). Also run `npm test` — all suites green.

- [ ] **Step 5: Commit**

```bash
git add proxy.mjs test/proxy.test.mjs assets/inline.js
git commit -m "feat(proxy): forwarding app with overlay injection and studio API bridge"
```

---

### Task 4: Wire `--proxy` into config and server startup (+ HMR WebSocket pass-through)

**Files:**
- Modify: `config.mjs` (append export)
- Modify: `server.mjs` (main block only)
- Test: `test/config.test.mjs` (append)

**Interfaces:**
- Consumes: `createProxyApp` from Task 3.
- Produces: `PROXY_TARGET: string | undefined` and `PROXY_PORT: number` exported from `config.mjs`.

- [ ] **Step 1: Write the failing test**

Append to `test/config.test.mjs`, following that file's existing re-resolve pattern (`import('../config.mjs?case=N')` with unique query strings — pick N values not already used in the file):

```js
test('PROXY_TARGET from env; PROXY_PORT is PORT + 1', async () => {
  process.env.I18N_PROXY_TARGET = 'http://localhost:4321';
  process.env.PORT = '5000';
  const cfg = await import('../config.mjs?case=proxy1');
  assert.equal(cfg.PROXY_TARGET, 'http://localhost:4321');
  assert.equal(cfg.PROXY_PORT, 5001);
  delete process.env.I18N_PROXY_TARGET;
  delete process.env.PORT;
});

test('PROXY_TARGET undefined when not configured', async () => {
  delete process.env.I18N_PROXY_TARGET;
  const cfg = await import('../config.mjs?case=proxy2');
  assert.equal(cfg.PROXY_TARGET, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `cfg.PROXY_TARGET` is undefined vs expected URL / `PROXY_PORT` undefined

- [ ] **Step 3: Write minimal implementation**

Append to `config.mjs`:

```js
// Inline on-page editing: proxy the target dev server with the overlay injected.
//   --proxy http://localhost:4321   (I18N_PROXY_TARGET)
export const PROXY_TARGET = flag('proxy') || process.env.I18N_PROXY_TARGET || undefined;
export const PROXY_PORT = PORT + 1;
```

In `server.mjs`, extend the imports and the `main` block (leave `createApp` untouched):

```js
import { langName, VOICE, PORT, PROXY_TARGET, PROXY_PORT } from './config.mjs';
import { createProxyApp } from './proxy.mjs';
import { request as httpRequest } from 'node:http';
```

Replace the existing `if (process.argv[1] ...)` block body with:

```js
if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`i18n Studio → http://localhost:${info.port}`);
    console.log(`editing:     ${STRINGS_DIR}  (${LANGS.join(', ')})`);
  });
  if (PROXY_TARGET) {
    const proxyApp = createProxyApp({ target: PROXY_TARGET, studioFetch: app.fetch });
    const proxyServer = serve({ fetch: proxyApp.fetch, port: PROXY_PORT }, (info) => {
      console.log(`inline edit → http://localhost:${info.port}  (proxying ${PROXY_TARGET})`);
    });
    // Pass WebSocket upgrades (Vite/Astro HMR) straight through to the target.
    const t = new URL(PROXY_TARGET);
    proxyServer.on('upgrade', (req, socket, head) => {
      const up = httpRequest({ host: t.hostname, port: t.port || 80, path: req.url, headers: req.headers, method: 'GET' });
      up.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 101 Switching Protocols`];
        for (const [k, v] of Object.entries(upRes.headers)) lines.push(`${k}: ${v}`);
        socket.write(lines.join('\r\n') + '\r\n\r\n');
        if (upHead?.length) socket.write(upHead);
        if (head?.length) upSocket.write(head);
        upSocket.pipe(socket); socket.pipe(upSocket);
      });
      up.on('error', () => socket.destroy());
      up.end();
    });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all suites PASS (config, strings, status, server, inline-map, proxy)

- [ ] **Step 5: Commit**

```bash
git add config.mjs server.mjs test/config.test.mjs
git commit -m "feat(proxy): --proxy flag starts the inline-editing proxy on PORT+1 with HMR WS pass-through"
```

---

### Task 5: `assets/inline.js` — the browser overlay

**Files:**
- Modify: `assets/inline.js` (replace the Task 3 stub)
- Modify: `README.md` (document the feature)

**Interfaces:**
- Consumes: `normalizeValue`, `serializeEdited`, `tagsChanged`, `buildIndex` from `/__i18n/inline-map.mjs` (Task 2); `/__i18n/api/strings`, `/__i18n/api/save`, `/__i18n/api/save-many` (Task 3 bridge → existing routes; save body is `{ file, lang, path, value }`).
- Produces: end-user feature. No exports.

This is the thin DOM layer — logic already tested in Tasks 1–2; this file is verified manually (Step 2). Keep it dependency-free and wrapped so it can never throw into the host page.

- [ ] **Step 1: Write the overlay**

```js
// assets/inline.js — i18n Studio inline on-page editor.
// Injected by proxy.mjs into every HTML page of the proxied dev server.
// All logic with tests lives in inline-map.mjs; this file is DOM glue only.
import { normalizeValue, serializeEdited, tagsChanged, buildIndex } from '/__i18n/inline-map.mjs';

(async function boot() {
  try {
    const res = await fetch('/__i18n/api/strings');
    const { langs, files } = await res.json();
    const lang = langs.includes(document.documentElement.lang) ? document.documentElement.lang : langs[0];
    const index = buildIndex(files, lang);

    // ---- state ----
    const matched = new WeakMap(); // element → { entries, original } (original = on-disk source string)
    let matchedEls = [];
    let editing = null;            // { el, entry, original }
    let saveTimer = 0;
    let mode = false;

    // ---- badge UI (shadow DOM so host styles can't leak in either direction) ----
    const host = document.createElement('div');
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        .badge{position:fixed;right:16px;bottom:16px;z-index:2147483647;font:12px/1.4 ui-monospace,monospace;
          background:#0c1116;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:8px 12px;
          cursor:pointer;user-select:none;box-shadow:0 4px 16px rgba(0,0,0,.4)}
        .badge.on{border-color:#3fb950;color:#3fb950}
        .toast{position:fixed;right:16px;bottom:64px;z-index:2147483647;font:12px/1.4 ui-monospace,monospace;
          background:#0c1116;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:10px 14px;
          max-width:340px;display:none}
        .toast button{margin-left:8px;font:inherit;cursor:pointer}
      </style>
      <div class="badge" part="badge">i18n edit: off</div>
      <div class="toast"></div>`;
    document.documentElement.appendChild(host);
    const badge = sh.querySelector('.badge');
    const toastEl = sh.querySelector('.toast');
    function toast(html, ms = 6000) {
      toastEl.innerHTML = html; toastEl.style.display = 'block';
      clearTimeout(toastEl._t); toastEl._t = setTimeout(() => (toastEl.style.display = 'none'), ms);
    }

    // ---- matching ----
    const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'TEXTAREA', 'INPUT', 'SELECT', 'IFRAME', 'CANVAS']);
    function scan() {
      matchedEls = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (el) =>
          SKIP.has(el.tagName) || el === host || host.contains(el) || el.isContentEditable
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        const entries = index.get(normalizeValue(el.innerHTML));
        if (entries) {
          // Nested matches (parent wrapping a matching child) are both tagged;
          // the click handler resolves via composedPath(), which is ordered
          // innermost-first — so the innermost match wins at edit time.
          matched.set(el, { entries, original: entries[0].value });
          matchedEls.push(el);
        }
      }
      badge.textContent = `i18n edit: ${mode ? 'on' : 'off'} · ${matchedEls.length} matched`;
    }

    // ---- edit mode ----
    function outline(el, color) { el.style.outline = `1px dashed ${color}`; el.style.outlineOffset = '2px'; }
    function clearOutline(el) { el.style.outline = ''; el.style.outlineOffset = ''; }

    function setMode(on) {
      mode = on;
      badge.classList.toggle('on', on);
      for (const el of matchedEls) {
        if (on) { outline(el, '#8b949e'); el.title = matched.get(el).entries.map((e) => `${e.file} → ${e.path}`).join('\n'); }
        else { clearOutline(el); el.removeAttribute('title'); if (el.isContentEditable) stopEdit(el, false); }
      }
      badge.textContent = `i18n edit: ${on ? 'on' : 'off'} · ${matchedEls.length} matched`;
    }

    badge.addEventListener('click', () => { scan(); setMode(!mode); });

    document.addEventListener('click', (ev) => {
      if (!mode) return;
      const el = ev.composedPath().find((n) => n instanceof Element && matched.has(n));
      if (!el) return;
      ev.preventDefault(); ev.stopPropagation();
      if (editing && editing.el !== el) stopEdit(editing.el, true);
      startEdit(el);
    }, true);

    function startEdit(el) {
      if (el.isContentEditable) return;
      const m = matched.get(el);
      editing = { el, entry: m.entries[0], original: m.original, domBefore: el.innerHTML };
      el.contentEditable = 'true'; el.focus(); outline(el, '#d29922');
      el.addEventListener('input', onInput);
      el.addEventListener('blur', onBlur);
      el.addEventListener('keydown', onKey);
    }
    function stopEdit(el, flush) {
      el.contentEditable = 'false';
      el.removeEventListener('input', onInput);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKey);
      clearOutline(el); if (mode) outline(el, '#8b949e');
      if (flush) { clearTimeout(saveTimer); save(); }
      editing = null;
    }
    const onBlur = () => editing && stopEdit(editing.el, true);
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); editing && stopEdit(editing.el, true); } };
    function onInput() {
      outline(editing.el, '#d29922');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 500);
    }

    async function save() {
      if (!editing) return;
      const { el, entry, original, domBefore } = editing;
      const value = serializeEdited(el.innerHTML);
      if (normalizeValue(value) === normalizeValue(original)) return; // no-op edit
      try {
        const r = await fetch('/__i18n/api/save', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: entry.file, lang, path: entry.path, value }),
        });
        const out = await r.json();
        if (!out.ok) throw new Error(out.error || `HTTP ${r.status}`);
        outline(el, '#3fb950'); setTimeout(() => el.isConnected && mode && !el.isContentEditable && outline(el, '#8b949e'), 800);
        if (tagsChanged(domBefore, el.innerHTML)) toast('⚠ markup changed — double-check in the studio');
        matched.get(el).original = value; editing.original = value;
        offerDuplicates(entry, original, value);
      } catch (e) {
        outline(el, '#f85149');
        toast(`save failed: ${e.message}`);
        console.warn('[i18n-studio]', e);
      }
    }

    // Same old value elsewhere in the corpus → one-click propagation.
    function offerDuplicates(saved, oldValue, newValue) {
      const others = (index.get(normalizeValue(oldValue)) || [])
        .filter((e) => !(e.file === saved.file && e.path === saved.path));
      if (!others.length) return;
      toast(`applied — same text in ${others.length} more place${others.length > 1 ? 's' : ''} <button>apply to all</button>`, 12000);
      toastEl.querySelector('button').onclick = async () => {
        await fetch('/__i18n/api/save-many', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ edits: others.map((e) => ({ file: e.file, lang, path: e.path, value: newValue })) }),
        });
        others.forEach((e) => { e.value = newValue; });
        toast(`applied to ${others.length} more`);
      };
    }

    scan();
  } catch (e) {
    console.warn('[i18n-studio] overlay failed to boot:', e);
  }
})();
```

Also append to `README.md` under Features:

```markdown
- **Inline on-page editing (proxy mode).** Run with `--proxy http://localhost:4321`
  (your dev server) and open `http://localhost:4332`: the studio proxies the site
  and injects an editor. Toggle the corner badge, click any matched text, edit in
  place — saves are debounced through the same AST-safe pipeline (acceptance drops,
  duplicates offered via a toast). HTML strings are edited rich; a warning appears
  if the markup structure changed. Zero changes to the target repo.
```

- [ ] **Step 2: Manual verification (goal-contract evidence)**

```bash
# terminal 1 — target site
cd ~/Sites/ai-design && npm run dev            # note the port (default 4321)
# terminal 2 — studio in proxy mode
cd ~/Sites/ai-design && node ~/ai_projects/i18n-studio/server.mjs --proxy http://localhost:4321
```

Open `http://localhost:4332`, toggle the badge, and verify each item:
1. Badge shows a non-zero match count; hover shows key tooltips.
2. Edit a plain string (e.g. a button label) → outline pulses green; `git -C ~/Sites/ai-design diff` shows a one-line change; the un-proxied tab (4321) hot-reloads with the new text.
3. Edit an HTML-bearing string (one with `<b>`/`&nbsp;`) around its tags → diff shows entities intact (`&nbsp;` not a raw NBSP), no `style=""` junk.
4. Delete a `<b>` while editing → warning toast appears, save still lands.
5. Edit a value that exists in multiple keys → toast offers "apply to all" → accepting produces the batch diff.
6. Toggle edit mode off → links navigate normally, no outlines; page behaves like 4321.
7. Stop the Astro dev server, reload 4332 → 502 page names the target URL.

Record the outcome in `docs/factory/2026-07-03-inline-editing/evidence/verify.log` (commands run + `npm test` output + checklist results).

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all suites PASS

- [ ] **Step 4: Commit**

```bash
git add assets/inline.js README.md docs/factory/2026-07-03-inline-editing/evidence/verify.log
git commit -m "feat(inline): on-page editing overlay — badge toggle, click-to-edit, auto-save, duplicates toast"
```

---

## Self-Review Notes

- Spec coverage: proxy + injection (T3), `/__i18n/` bridge (T3), flag + PORT+1 + HMR WS (T4), matching/normalization (T1–2), toggle/click/debounce/save states (T5), tag warning (T5), duplicates via save-many (T5), 502 page (T3), README (T5). Ambiguous-match tooltip: covered — tooltip lists all candidates, save writes the first, duplicates toast offers the rest (design §4).
- Field-name consistency: save body uses `path` (matches `server.mjs:42`), overlay and tests agree.
- The design's "quote-style normalization" is deliberately not implemented (YAGNI): `serializeEdited` never touches attribute quotes; browsers already emit double quotes, matching the corpus.
