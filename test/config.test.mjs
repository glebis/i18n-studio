// Config resolution: flag → env → default. config.mjs reads process.env at import
// time, so each case re-imports with a unique query string to force re-evaluation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
