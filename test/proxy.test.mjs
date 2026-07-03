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
