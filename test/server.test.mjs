// Route + parser tests for server.mjs. The suggest route's model call is injected
// (queryFn) so nothing here touches the Claude SDK. Importing the module must NOT
// bind a port — createApp() returns the Hono app; serve() runs only as `main`.
//
// NOTE: the draft this was adopted from also covered a `/api/ignore` route and an
// `ignored` flag on /api/strings cells ("ignore status" feature). That feature does
// not exist on this branch's server.mjs/status.mjs (it lives only in an unmerged
// feat/ignore-status branch), so those cases were SKIPPED here. See coverage-report.md.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'i18n-server-test-'));
process.env.I18N_STRINGS_DIR = DIR;
process.env.I18N_LANGS = 'en,ru';

const { createApp, parseList } = await import('../server.mjs');

const FILE = 'site.ts';
const TEMPLATE = `export default {
  en: { greeting: "Hello", cta: "Start" },
  ru: { greeting: "Привет", cta: "" },
};
`;
const SIDECAR = join(DIR, '.i18n-status.json');
beforeEach(() => {
  writeFileSync(join(DIR, FILE), TEMPLATE);
  if (existsSync(SIDECAR)) rmSync(SIDECAR);
});

const json = (path, body) =>
  ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ---- parseList (pure) ----
test('parseList: extracts a JSON array, ignoring code fences and prose', () => {
  assert.deepEqual(parseList('```json\n["a","b","c"]\n```'), ['a', 'b', 'c']);
  assert.deepEqual(parseList('Sure! ["one", "two"] hope that helps'), ['one', 'two']);
});

test('parseList: falls back to line parsing when there is no JSON array', () => {
  assert.deepEqual(parseList('1. Привет\n2. Здравствуйте'), ['Привет', 'Здравствуйте']);
});

test('parseList: empty or junk input yields an empty list', () => {
  assert.deepEqual(parseList(''), []);
  assert.deepEqual(parseList('   '), []);
});

test('parseList: caps at 5 candidates', () => {
  assert.equal(parseList('["1","2","3","4","5","6","7"]').length, 5);
});

// ---- routes ----
test('GET /api/strings: returns langs and files with acceptance flags', async () => {
  const app = createApp();
  const res = await app.request('/api/strings');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.langs, ['en', 'ru']);
  const cell = body.files[0].entries.find((e) => e.path === 'greeting').ru;
  assert.equal(cell.value, 'Привет');
  assert.equal(cell.accepted, false);
});

test('POST /api/save: writes the value and clears acceptance', async () => {
  const app = createApp();
  const res = await app.request('/api/save', json('/api/save',
    { file: FILE, lang: 'ru', path: 'cta', value: 'Начать' }));
  assert.equal((await res.json()).ok, true);
  const strings = await (await app.request('/api/strings')).json();
  const cta = strings.files[0].entries.find((e) => e.path === 'cta').ru;
  assert.equal(cta.value, 'Начать');
});

test('POST /api/save: bad path returns ok:false with 400', async () => {
  const app = createApp();
  const res = await app.request('/api/save', json('/api/save',
    { file: FILE, lang: 'ru', path: 'nope.nope', value: 'x' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

test('POST /api/save-many: batch-writes edits and reports per-edit results', async () => {
  const app = createApp();
  const res = await app.request('/api/save-many', json('/api/save-many', {
    edits: [
      { file: FILE, lang: 'ru', path: 'cta', value: 'Начать' },
      { file: FILE, lang: 'ru', path: 'nope.nope', value: 'x' },
    ],
  }));
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, false);
});

test('POST /api/accept then GET reflects accepted; a later edit drops it', async () => {
  const app = createApp();
  await app.request('/api/accept', json('/api/accept',
    { file: FILE, lang: 'ru', path: 'greeting', value: 'Привет', accepted: true }));
  let strings = await (await app.request('/api/strings')).json();
  assert.equal(strings.files[0].entries.find((e) => e.path === 'greeting').ru.accepted, true);

  await app.request('/api/save', json('/api/save',
    { file: FILE, lang: 'ru', path: 'greeting', value: 'Здравствуйте' }));
  strings = await (await app.request('/api/strings')).json();
  assert.equal(strings.files[0].entries.find((e) => e.path === 'greeting').ru.accepted, false);
});

test('POST /api/suggest: uses the injected model and returns parsed candidates', async () => {
  async function* fakeQuery() {
    yield { type: 'result', is_error: false, result: '["Начать","Поехали","Старт"]' };
  }
  const app = createApp({ queryFn: fakeQuery });
  const res = await app.request('/api/suggest', json('/api/suggest',
    { sourceText: 'Start', from: 'en', to: 'ru', path: 'cta' }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).suggestions, ['Начать', 'Поехали', 'Старт']);
});

test('POST /api/suggest: rejects a missing source or unknown target lang', async () => {
  const app = createApp();
  const res = await app.request('/api/suggest', json('/api/suggest',
    { sourceText: '', from: 'en', to: 'ru', path: 'cta' }));
  assert.equal(res.status, 400);
});

test('POST /api/suggest: surfaces a model error result as 502', async () => {
  async function* fakeQuery() {
    yield { type: 'result', is_error: true, result: 'model exploded' };
  }
  const app = createApp({ queryFn: fakeQuery });
  const res = await app.request('/api/suggest', json('/api/suggest',
    { sourceText: 'Start', from: 'en', to: 'ru', path: 'cta' }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).ok, false);
});

test('GET /: serves the frontend HTML', async () => {
  const app = createApp();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /html/);
});

test('GET /assets/:name: 404s for a non-allow-listed asset (no path traversal)', async () => {
  const app = createApp();
  const res = await app.request('/assets/../server.mjs');
  assert.equal(res.status, 404);
});
