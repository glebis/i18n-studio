import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, normalizeValue, unwrapSpans } from '../inline-map.mjs';

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
  const hits = idx.get(normalizeValue('July 21'));
  assert.equal(hits.length, 2); // A.ts h + B.ts dup — same normalized value
  assert.deepEqual(hits[0], { file: 'A.ts', path: 'h', value: 'July&nbsp;21' });
  assert.equal(idx.get(normalizeValue('42')), undefined);
  assert.equal(idx.get(normalizeValue('x ${y}')), undefined);
  const ruIdx = buildIndex(files, 'ru');
  assert.equal(ruIdx.get(normalizeValue('21 июля')).length, 1);
});

test('unwrapSpans: strips single-class wrapper spans, keeps everything else', () => {
  assert.equal(unwrapSpans('<span class="w">Impact</span> <span class="w">first</span>'), 'Impact first');
  assert.equal(unwrapSpans('a <span class="w">b <span class="w">c</span></span> d'), 'a b c d');
  assert.equal(unwrapSpans('<span class="nb">keep</span>'), '<span class="nb">keep</span>');
  assert.equal(unwrapSpans('<span class="w extra">keep</span>'), '<span class="w extra">keep</span>');
  assert.equal(unwrapSpans('<span class="x">y</span>', ['x']), 'y');
  assert.equal(unwrapSpans('plain'), 'plain');
});

test('unwrapSpans: makes scroll-reveal word-wrapped DOM match the source string', () => {
  const source = 'Start from the change you want in&nbsp;the world';
  const dom = '<span class="w">Start</span> <span class="w">from</span> <span class="w">the</span> <span class="w">change</span> <span class="w">you</span> <span class="w">want</span> <span class="w">in the</span> <span class="w">world</span>';
  assert.equal(normalizeValue(unwrapSpans(dom)), normalizeValue(source));
});
