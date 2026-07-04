import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { injectInlineScript, injectPreScript, createProxyApp } from '../proxy.mjs';

const TAG = '<script type="module" src="/__i18n/inline.js"></script>';
const PRE_TAG = '<script src="/__i18n/pre.js"></script>';

test('injectInlineScript: before </body>, case-insensitive, idempotent, fallback append', () => {
  assert.equal(injectInlineScript('<body>x</body>'), `<body>x${TAG}</body>`);
  assert.equal(injectInlineScript('<BODY>x</BODY>'), `<BODY>x${TAG}</BODY>`);
  assert.equal(injectInlineScript('no body tag'), `no body tag${TAG}`);
  const once = injectInlineScript('<body>x</body>');
  assert.equal(injectInlineScript(once), once); // idempotent
});

test('injectPreScript: right after opening <head>, case-insensitive, idempotent, no-head fallback', () => {
  assert.equal(injectPreScript('<head><title>x</title></head><body>y</body>'), `<head>${PRE_TAG}<title>x</title></head><body>y</body>`);
  assert.equal(injectPreScript('<HEAD lang="en"><title>x</title></HEAD>'), `<HEAD lang="en">${PRE_TAG}<title>x</title></HEAD>`);
  assert.equal(injectPreScript('no head tag'), `${PRE_TAG}no head tag`);
  const once = injectPreScript('<head></head>');
  assert.equal(injectPreScript(once), once); // idempotent
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
  const app = makeProxy({ '/': { body: '<html><head></head><body>hi</body></html>', headers: { 'content-type': 'text/html; charset=utf-8' } } });
  const res = await app.request('/');
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.equal(text.split('/__i18n/inline.js').length - 1, 1);
  assert.equal(text.split('/__i18n/pre.js').length - 1, 1);
  assert.match(text, /hi<script type="module"/);
  assert.match(text, /<head><script src="\/__i18n\/pre\.js">/);
});

test('HTML with no <head> tag falls back to prepending pre.js at the very start', async () => {
  const app = makeProxy({ '/': { body: '<html><body>hi</body></html>', headers: { 'content-type': 'text/html; charset=utf-8' } } });
  const res = await app.request('/');
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.equal(text.split('/__i18n/pre.js').length - 1, 1);
  assert.match(text, /^<script src="\/__i18n\/pre\.js"><\/script><html>/);
});

test('pre.js injection is idempotent even if processed twice', () => {
  const once = injectPreScript('<head></head><body>x</body>');
  const twice = injectPreScript(once);
  assert.equal(twice, once);
  assert.equal(twice.split('/__i18n/pre.js').length - 1, 1);
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
  for (const p of ['/__i18n/inline.js', '/__i18n/inline-map.mjs', '/__i18n/inline-state.mjs', '/__i18n/pre.js']) {
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
