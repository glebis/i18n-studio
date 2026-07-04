// Tests for the acceptance sidecar (status.mjs). The core invariant: a cell is
// accepted only while its current value still hashes to the value that was
// accepted — so any later edit silently drops it back to pending.
//
// NOTE: draft tests for isIgnored/setIgnored ("ignore status") were SKIPPED here —
// that feature does not exist on this branch's status.mjs/server.mjs (it lives only
// in an unmerged feat/ignore-status branch). See coverage-report.md.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'i18n-status-test-'));
process.env.I18N_STRINGS_DIR = DIR;
process.env.I18N_LANGS = 'en,ru';

const { readStatus, isAccepted, setAccepted, clearAccepted, hash } =
  await import('../status.mjs');

const SIDECAR = join(DIR, '.i18n-status.json');
beforeEach(() => { if (existsSync(SIDECAR)) rmSync(SIDECAR); });

test('hash: deterministic 12-char hex digest', () => {
  assert.equal(hash('Привет'), hash('Привет'));
  assert.match(hash('x'), /^[0-9a-f]{12}$/);
  assert.notEqual(hash('a'), hash('b'));
});

test('readStatus: missing sidecar reads as empty object', () => {
  assert.deepEqual(readStatus(), {});
});

test('setAccepted then isAccepted: true only for the accepted value', () => {
  setAccepted('site.ts', 'ru', 'greeting', true, 'Привет');
  const s = readStatus();
  assert.equal(isAccepted(s, 'site.ts', 'ru', 'greeting', 'Привет'), true);
  // a different current value no longer matches the accepted hash → pending
  assert.equal(isAccepted(s, 'site.ts', 'ru', 'greeting', 'Здравствуйте'), false);
});

test('setAccepted(false): removes the record', () => {
  setAccepted('site.ts', 'ru', 'greeting', true, 'Привет');
  setAccepted('site.ts', 'ru', 'greeting', false, 'Привет');
  assert.equal(isAccepted(readStatus(), 'site.ts', 'ru', 'greeting', 'Привет'), false);
});

test('clearAccepted: drops acceptance for a key', () => {
  setAccepted('site.ts', 'ru', 'greeting', true, 'Привет');
  clearAccepted('site.ts', 'ru', 'greeting');
  assert.equal(isAccepted(readStatus(), 'site.ts', 'ru', 'greeting', 'Привет'), false);
});

test('keys are scoped by file+lang+path (no cross-talk)', () => {
  setAccepted('a.ts', 'ru', 'k', true, 'v');
  const s = readStatus();
  assert.equal(isAccepted(s, 'a.ts', 'ru', 'k', 'v'), true);
  assert.equal(isAccepted(s, 'b.ts', 'ru', 'k', 'v'), false); // different file
  assert.equal(isAccepted(s, 'a.ts', 'en', 'k', 'v'), false); // different lang
});

test('sidecar persists to disk as JSON keyed by file::lang::path', () => {
  setAccepted('site.ts', 'ru', 'greeting', true, 'Привет');
  const s = JSON.parse(readFileSync(SIDECAR, 'utf8'));
  assert.equal(s['site.ts::ru::greeting'], hash('Привет'));
});
