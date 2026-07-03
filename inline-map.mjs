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
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// innerHTML → source-string form. Conservative: only reverse what browsers
// predictably mangle; never restructure the user's markup.
export function serializeEdited(innerHTML) {
  return String(innerHTML)
    .replace(/<(b|i|em|strong|span|u|s|small|mark|code)(\s[^>]*)?>\s*<\/\1>/gi, '') // empty inline tags
    .replace(/(<br\s*\/?>\s*)+$/i, '')                                             // trailing <br> artifacts
    .replace(/\s+style="[^"]*"/gi, '')                                             // injected style attrs
    .replace(/ /g, '&nbsp;')
    .trim();
}

function tagMultiset(s) {
  const names = [...String(s).matchAll(/<([a-z][a-z0-9-]*)[\s/>]/gi)].map((m) => m[1].toLowerCase());
  return names.sort().join(',');
}

export function tagsChanged(before, after) {
  return tagMultiset(before) !== tagMultiset(after);
}

// /api/strings `files` payload → Map of normalized value → candidate entries.
export function buildIndex(files, lang) {
  const idx = new Map();
  for (const f of files) for (const e of f.entries) {
    const cell = e[lang];
    if (!cell || !cell.editable || cell.interp) continue;
    if (typeof cell.value !== 'string' || !cell.value.trim()) continue;
    const key = normalizeValue(cell.value);
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push({ file: f.file, path: e.path, value: cell.value });
  }
  return idx;
}
