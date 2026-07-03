// Pure, isomorphic matching/serialization logic for the inline on-page editor.
// Runs in Node (unit tests) AND in the browser (imported by assets/inline.js):
// no Node imports, no DOM access — string in, string out.

const NAMED = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '—', ndash: '–', hellip: '…', rarr: '→', larr: '←',
  middot: '·', times: '×', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', thinsp: ' ',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const n = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const named = NAMED[body.toLowerCase()];
    return named !== undefined ? named : m;
  });
}

// Two representations of the same string (source literal vs browser innerHTML)
// must normalize equal; different copy must not collide.
export function normalizeValue(s) {
  return decodeEntities(s)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
