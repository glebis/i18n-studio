import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore, duplicatesOffer, pendingDupCodec, reducedMotionOverride } from '../inline-state.mjs';

// ---- createSessionStore ----

test('createSessionStore: start/current/markDirty/end lifecycle', () => {
  const store = createSessionStore();
  assert.equal(store.current(), null);

  const el = { tag: 'el' };
  const entry = { file: 'site.ts', path: 'simple' };
  const started = store.start(el, entry, 'Hello', '<b>Hello</b>');
  assert.equal(store.current(), started);
  assert.equal(started.el, el);
  assert.equal(started.entry, entry);
  assert.equal(started.original, 'Hello');
  assert.equal(started.domBefore, '<b>Hello</b>');
  assert.equal(started.dirty, false);

  store.markDirty();
  assert.equal(store.current().dirty, true);

  const ended = store.end();
  assert.equal(ended, started);
  assert.equal(ended.dirty, true);
  assert.equal(store.current(), null);
});

test('createSessionStore: end() without a prior start() returns null and is a no-op', () => {
  const store = createSessionStore();
  assert.equal(store.end(), null);
  assert.equal(store.current(), null);
  // Calling end() again is still safe.
  assert.equal(store.end(), null);
});

test('createSessionStore: markDirty() with no active session is a no-op', () => {
  const store = createSessionStore();
  assert.doesNotThrow(() => store.markDirty());
  assert.equal(store.current(), null);
});

test('createSessionStore: a second start() replaces the first session outright', () => {
  const store = createSessionStore();
  const first = store.start('el1', { file: 'a.ts', path: 'x' }, 'A', '<i>A</i>');
  store.markDirty();
  const second = store.start('el2', { file: 'b.ts', path: 'y' }, 'B', '<i>B</i>');
  assert.equal(store.current(), second);
  assert.notEqual(store.current(), first);
  assert.equal(second.dirty, false); // fresh session, not carrying over the old dirty flag
});

// ---- duplicatesOffer ----

test('duplicatesOffer: excludes the just-saved entry, keeps the rest', () => {
  const indexEntries = [
    { file: 'a.ts', path: 'x', value: 'Hello' },
    { file: 'b.ts', path: 'y', value: 'Hello' },
    { file: 'c.ts', path: 'z', value: 'Hello' },
  ];
  const saved = { file: 'b.ts', path: 'y' };
  const others = duplicatesOffer(indexEntries, saved, 'hello');
  assert.deepEqual(others, [
    { file: 'a.ts', path: 'x', value: 'Hello' },
    { file: 'c.ts', path: 'z', value: 'Hello' },
  ]);
});

test('duplicatesOffer: entry not present in the index list — nothing excluded', () => {
  const indexEntries = [{ file: 'a.ts', path: 'x', value: 'Hi' }];
  const saved = { file: 'z.ts', path: 'nope' };
  assert.deepEqual(duplicatesOffer(indexEntries, saved), indexEntries);
});

test('duplicatesOffer: empty/missing indexEntries yields an empty array', () => {
  const saved = { file: 'a.ts', path: 'x' };
  assert.deepEqual(duplicatesOffer([], saved), []);
  assert.deepEqual(duplicatesOffer(undefined, saved), []);
  assert.deepEqual(duplicatesOffer(null, saved), []);
});

test('duplicatesOffer: only the saved entry present — result is empty', () => {
  const saved = { file: 'a.ts', path: 'x' };
  assert.deepEqual(duplicatesOffer([{ file: 'a.ts', path: 'x', value: 'Hi' }], saved), []);
});

// ---- pendingDupCodec ----

test('pendingDupCodec: encode/decode round-trip within the freshness window', () => {
  const others = [{ file: 'a.ts', path: 'x', value: 'Hi' }];
  const ts = 1_000_000;
  const raw = pendingDupCodec.encode(others, 'New value', '⚠ warn', ts);
  const decoded = pendingDupCodec.decode(raw, ts + 5000); // 5s later, well within 30s
  assert.deepEqual(decoded, { others, newValue: 'New value', warn: '⚠ warn' });
});

test('pendingDupCodec: decode defaults a falsy warn to an empty string', () => {
  const ts = 1_000_000;
  const raw = pendingDupCodec.encode([], 'v', '', ts);
  const decoded = pendingDupCodec.decode(raw, ts + 100);
  assert.equal(decoded.warn, '');
});

test('pendingDupCodec: stale entry (older than 30s) decodes to null', () => {
  const ts = 1_000_000;
  const raw = pendingDupCodec.encode([{ file: 'a.ts', path: 'x' }], 'v', '', ts);
  assert.equal(pendingDupCodec.decode(raw, ts + 30000), null); // exactly at the boundary: stale
  assert.equal(pendingDupCodec.decode(raw, ts + 30001), null);
  assert.notEqual(pendingDupCodec.decode(raw, ts + 29999), null); // just under: still fresh
});

test('pendingDupCodec: respects a custom maxAgeMs', () => {
  const ts = 1_000_000;
  const raw = pendingDupCodec.encode([], 'v', '', ts);
  assert.equal(pendingDupCodec.decode(raw, ts + 1000, 500), null);
  assert.notEqual(pendingDupCodec.decode(raw, ts + 100, 500), null);
});

test('pendingDupCodec: malformed JSON decodes to null', () => {
  assert.equal(pendingDupCodec.decode('{not json', Date.now()), null);
  assert.equal(pendingDupCodec.decode('', Date.now()), null);
  assert.equal(pendingDupCodec.decode(null, Date.now()), null);
});

test('pendingDupCodec: well-formed JSON missing required fields decodes to null', () => {
  assert.equal(pendingDupCodec.decode(JSON.stringify({ newValue: 'v' }), Date.now()), null); // no others/ts
  assert.equal(pendingDupCodec.decode(JSON.stringify({ others: [], newValue: 'v' }), Date.now()), null); // no ts
  assert.equal(pendingDupCodec.decode(JSON.stringify('just a string'), Date.now()), null);
  assert.equal(pendingDupCodec.decode(JSON.stringify(null), Date.now()), null);
});

// ---- reducedMotionOverride ----

test('reducedMotionOverride: decision table', () => {
  assert.equal(reducedMotionOverride('(prefers-reduced-motion: reduce)'), true);
  assert.equal(reducedMotionOverride('(prefers-reduced-motion: no-preference)'), false);
  assert.equal(reducedMotionOverride('(min-width: 600px)'), null);
  assert.equal(reducedMotionOverride('(prefers-reduced-motion)'), true); // bare, no explicit value
});
