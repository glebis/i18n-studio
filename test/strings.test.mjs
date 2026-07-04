// Behavioral tests for the AST layer (strings.mjs) exercised through its public
// API: readAll() parses a fixture file into per-path cells; write() replaces a
// single literal with minimal diff and correct escaping. STRINGS_DIR/LANGS are
// resolved at import time from env, so we point them at a temp dir before import.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'i18n-studio-test-'));
process.env.I18N_STRINGS_DIR = DIR;
process.env.I18N_LANGS = 'en,ru';

const { readAll, write } = await import('../strings.mjs');

const FILE = 'site.ts';
const TEMPLATE = `export default {
  en: {
    simple: "Hello",
    nested: { deep: "World" },
    list: ["one", "two"],
    count: 3,
    tmpl: \`Hi \${name}\`,
    quote: "she said \\"hi\\"",
    label: \`Static label\`,
  },
  ru: {
    simple: "Привет",
    nested: { deep: "Мир" },
    list: ["один", "два"],
    count: 3,
    tmpl: \`Привет \${name}\`,
    quote: "",
    label: \`Статичная метка\`,
  },
};
`;

beforeEach(() => writeFileSync(join(DIR, FILE), TEMPLATE));

const raw = () => readFileSync(join(DIR, FILE), 'utf8');
function cells() {
  const file = readAll().find((f) => f.file === FILE);
  const by = {};
  for (const e of file.entries) by[e.path] = e;
  return by;
}

test('readAll: string literals are editable with their decoded value', () => {
  const c = cells();
  assert.equal(c.simple.en.value, 'Hello');
  assert.equal(c.simple.en.editable, true);
  assert.equal(c.simple.ru.value, 'Привет');
});

test('readAll: nested objects flatten to dot-paths', () => {
  assert.equal(cells()['nested.deep'].en.value, 'World');
});

test('readAll: array elements flatten to numeric index paths', () => {
  const c = cells();
  assert.equal(c['list.0'].en.value, 'one');
  assert.equal(c['list.1'].ru.value, 'два');
});

test('readAll: numbers are shown read-only, not editable', () => {
  const count = cells().count.en;
  assert.equal(count.editable, false);
  assert.equal(count.value, '3');
});

test('readAll: interpolated templates are editable and flagged interp', () => {
  const t = cells().tmpl.en;
  assert.equal(t.editable, true);
  assert.equal(t.interp, true);
  assert.equal(t.value, 'Hi ${name}'); // backticks stripped, ${...} kept
});

test('readAll: static (non-interpolated) backtick literals are editable, not flagged interp', () => {
  const l = cells().label.en;
  assert.equal(l.editable, true);
  assert.equal(l.interp, undefined);
  assert.equal(l.value, 'Static label');
});

test('readAll: escaped quotes inside a literal are decoded', () => {
  assert.equal(cells().quote.en.value, 'she said "hi"');
});

test('readAll: shape — files/entries/paths/editable flags', () => {
  const files = readAll();
  assert.ok(Array.isArray(files));
  const file = files.find((f) => f.file === FILE);
  assert.ok(file);
  assert.ok(Array.isArray(file.entries));
  const paths = file.entries.map((e) => e.path);
  assert.ok(paths.includes('simple'));
  assert.ok(paths.includes('nested.deep'));
  assert.ok(paths.includes('list.0'));
  for (const e of file.entries) {
    assert.ok('path' in e);
    for (const lang of ['en', 'ru']) {
      const cell = e[lang];
      if (cell) assert.ok('value' in cell && 'editable' in cell);
    }
  }
});

test('write: replaces one literal without disturbing siblings', () => {
  write(FILE, 'en', 'simple', 'Hi there');
  const text = raw();
  assert.match(text, /simple: "Hi there"/);
  assert.match(text, /nested: \{ deep: "World" \}/); // untouched
  assert.equal(cells().simple.en.value, 'Hi there');
});

test('write: minimal diff — unrelated lines are byte-identical after write', () => {
  const before = TEMPLATE.split('\n');
  write(FILE, 'en', 'simple', 'Hi there');
  const after = raw().split('\n');
  assert.equal(before.length, after.length);
  for (let i = 0; i < before.length; i++) {
    if (i === 2) continue; // the `simple:` line in `en`, the only one that should change
    assert.equal(after[i], before[i], `line ${i} should be byte-identical`);
  }
});

test('write: escapes double quotes and newlines for a double-quoted literal', () => {
  const value = 'a"b\nc';
  write(FILE, 'en', 'simple', value);
  assert.match(raw(), /simple: "a\\"b\\nc"/);
  assert.equal(cells().simple.en.value, value); // round-trips back
});

test('write: round-trips a value containing a backslash', () => {
  const value = 'path\\to\\thing';
  write(FILE, 'en', 'simple', value);
  assert.equal(cells().simple.en.value, value);
});

test('write: keeps ${...} live when editing an interpolated template', () => {
  write(FILE, 'en', 'tmpl', 'Hello ${name}!');
  assert.match(raw(), /tmpl: `Hello \$\{name\}!`/);
  const t = cells().tmpl.en;
  assert.equal(t.interp, true);
  assert.equal(t.value, 'Hello ${name}!');
});

test('write: static backtick literal round-trips, including embedded quotes/backslash', () => {
  const value = 'He said "hi" \\ and left';
  write(FILE, 'en', 'label', value);
  assert.equal(cells().label.en.value, value);
});

test('write: fills a previously empty target and reads it back', () => {
  write(FILE, 'ru', 'quote', 'она сказала «привет»');
  assert.equal(cells().quote.ru.value, 'она сказала «привет»');
});

test('write: throws on an unknown language', () => {
  assert.throws(() => write(FILE, 'de', 'simple', 'x'), /bad lang/);
});

test('write: throws on a non-editable path (number leaf)', () => {
  assert.throws(() => write(FILE, 'en', 'count', '5'), /not editable/);
});

test('write: throws on a non-editable path (object, not a leaf)', () => {
  assert.throws(() => write(FILE, 'en', 'nested', 'x'), /not editable/);
});
