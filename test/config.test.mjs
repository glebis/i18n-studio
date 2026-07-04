// Config resolution: flag → env → default. config.mjs reads process.env at import
// time, so each case re-imports with a unique query string to force re-evaluation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';

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

test('langName: known codes map to English names, unknown falls back to code', async () => {
  const cfg = await import('../config.mjs?case=lang1');
  assert.equal(cfg.langName('ru'), 'Russian');
  assert.equal(cfg.langName('de'), 'German');
  assert.equal(cfg.langName('xx'), 'xx');
});

test('LANGS: parsed from I18N_LANGS, trimmed, empties filtered', async () => {
  process.env.I18N_LANGS = ' en , ru , ,de ';
  const cfg = await import('../config.mjs?case=langs1');
  assert.deepEqual(cfg.LANGS, ['en', 'ru', 'de']);
  delete process.env.I18N_LANGS;
});

test('LANGS: defaults to en,ru when unset', async () => {
  delete process.env.I18N_LANGS;
  const cfg = await import('../config.mjs?case=langs2');
  assert.deepEqual(cfg.LANGS, ['en', 'ru']);
});

test('STRINGS_DIR: resolves to an absolute path from I18N_STRINGS_DIR', async () => {
  process.env.I18N_STRINGS_DIR = '/tmp/some/strings';
  const cfg = await import('../config.mjs?case=dir1');
  assert.equal(isAbsolute(cfg.STRINGS_DIR), true);
  assert.equal(cfg.STRINGS_DIR, '/tmp/some/strings');
  delete process.env.I18N_STRINGS_DIR;
});

test('PORT: defaults to 4331, overridable via env', async () => {
  delete process.env.PORT;
  const def = await import('../config.mjs?case=port1');
  assert.equal(def.PORT, 4331);
  process.env.PORT = '5200';
  const custom = await import('../config.mjs?case=port2');
  assert.equal(custom.PORT, 5200);
  delete process.env.PORT;
});

test('VOICE: has a non-empty default and is overridable', async () => {
  delete process.env.I18N_VOICE;
  const def = await import('../config.mjs?case=voice1');
  assert.ok(def.VOICE.length > 0);
  process.env.I18N_VOICE = 'Terse and technical.';
  const custom = await import('../config.mjs?case=voice2');
  assert.equal(custom.VOICE, 'Terse and technical.');
  delete process.env.I18N_VOICE;
});
