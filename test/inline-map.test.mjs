import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, normalizeValue } from '../inline-map.mjs';

test('decodeEntities: named, numeric decimal and hex refs', () => {
  assert.equal(decodeEntities('a&nbsp;b'), 'a b');
  assert.equal(decodeEntities('5&nbsp;weeks &amp; more'), '5 weeks & more');
  assert.equal(decodeEntities('&lt;b&gt;&quot;x&quot;&#39;'), `<b>"x"'`);
  assert.equal(decodeEntities('go &#8599; and &#x2192; there'), 'go ↗ and → there');
  assert.equal(decodeEntities('&mdash;&rarr;&hellip;'), '—→…');
  assert.equal(decodeEntities('no entities'), 'no entities');
  assert.equal(decodeEntities('&unknown; stays'), '&unknown; stays');
});

test('normalizeValue: entity/NBSP-insensitive, whitespace-collapsed', () => {
  // The core matching property: source string and browser innerHTML normalize equal.
  assert.equal(normalizeValue('July&nbsp;21'), normalizeValue('July 21'));
  assert.equal(normalizeValue('a  b\n c'), 'a b c');
  assert.equal(normalizeValue('  padded  '), 'padded');
  assert.equal(
    normalizeValue('<b>Tuesday theory</b> and <b>Thursday practice</b>'),
    normalizeValue('<b>Tuesday  theory</b>\n  and <b>Thursday practice</b>'),
  );
  // Different text must NOT collide.
  assert.notEqual(normalizeValue('July 21'), normalizeValue('July 22'));
});
