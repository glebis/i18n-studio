// AST layer: read and write the site's i18n string files without disturbing formatting.
//
// Each file is `export default { en: {...}, ru: {...} }`. We walk both language
// objects, collecting every leaf. Plain string literals (and static backtick
// templates) are editable; template literals with ${...} are computed and shown
// read-only. Writes re-parse, navigate to the exact node by path, and replace only
// that literal — so Astro's dev server hot-reloads on a minimal diff.

import { Project, SyntaxKind } from 'ts-morph';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { STRINGS_DIR, LANGS } from './config.mjs';

export { STRINGS_DIR, LANGS };

function project() {
  // Skip the full type-check/lib load — we only manipulate syntax.
  return new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
}

function defaultObject(sourceFile) {
  const assignment = sourceFile.getExportAssignment((a) => !a.isExportEquals());
  const expr = assignment?.getExpression();
  return expr && expr.getKind() === SyntaxKind.ObjectLiteralExpression ? expr : null;
}

function langObject(sourceFile, lang) {
  const root = defaultObject(sourceFile);
  const prop = root?.getProperty(lang);
  const init = prop?.getInitializer?.();
  return init && init.getKind() === SyntaxKind.ObjectLiteralExpression ? init : null;
}

// Follow a dot-path (object keys + numeric array indices) to a node.
function nodeAtPath(langObj, path) {
  let node = langObj;
  for (const seg of path.split('.')) {
    const kind = node.getKind();
    if (kind === SyntaxKind.ObjectLiteralExpression) {
      const prop = node.getProperty(seg);
      node = prop?.getInitializer?.();
    } else if (kind === SyntaxKind.ArrayLiteralExpression) {
      node = node.getElements()[Number(seg)];
    } else {
      return null;
    }
    if (!node) return null;
  }
  return node;
}

const EDITABLE = new Set([SyntaxKind.StringLiteral, SyntaxKind.NoSubstitutionTemplateLiteral]);

// Recursively collect leaves under a node, keyed by dot-path.
function collect(node, path, out) {
  const kind = node.getKind();
  if (kind === SyntaxKind.ObjectLiteralExpression) {
    for (const prop of node.getProperties()) {
      const name = prop.getName?.();
      const init = prop.getInitializer?.();
      if (name && init) collect(init, path ? `${path}.${name}` : name, out);
    }
  } else if (kind === SyntaxKind.ArrayLiteralExpression) {
    node.getElements().forEach((el, i) => collect(el, `${path}.${i}`, out));
  } else if (EDITABLE.has(kind)) {
    out.set(path, { value: node.getLiteralValue(), editable: true });
  } else if (kind === SyntaxKind.TemplateExpression) {
    // Interpolated template `... ${expr} ...`: the prose is translatable, the
    // ${...} placeholders must survive. Expose the raw template body (backticks
    // stripped) as editable, flagged so the UI can warn about the placeholders.
    const raw = node.getText();
    out.set(path, { value: raw.slice(1, -1), editable: true, interp: true });
  } else {
    // Number, identifier, etc. — show but don't edit.
    out.set(path, { value: node.getText(), editable: false });
  }
}

export function readAll() {
  const proj = project();
  const files = readdirSync(STRINGS_DIR).filter((f) => f.endsWith('.ts')).sort();
  return files.map((file) => {
    const sf = proj.addSourceFileAtPath(join(STRINGS_DIR, file));
    const perLang = {};
    for (const lang of LANGS) {
      const obj = langObject(sf, lang);
      const map = new Map();
      if (obj) collect(obj, '', map);
      perLang[lang] = map;
    }
    // Union of paths across languages, in en's order first.
    const paths = [];
    const seen = new Set();
    for (const lang of LANGS) {
      for (const p of perLang[lang].keys()) {
        if (!seen.has(p)) { seen.add(p); paths.push(p); }
      }
    }
    const entries = paths.map((path) => {
      const row = { path };
      for (const lang of LANGS) row[lang] = perLang[lang].get(path) || null;
      return row;
    });
    return { file, entries };
  });
}

// Escape a raw value for re-emission inside the original delimiter.
function encode(value, delim) {
  let v = value.replace(/\\/g, '\\\\');
  if (delim === '`') v = v.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  else v = v.replace(new RegExp(delim, 'g'), '\\' + delim).replace(/\n/g, '\\n').replace(/\r/g, '');
  return delim + v + delim;
}

export function write(file, lang, path, value) {
  if (!LANGS.includes(lang)) throw new Error(`bad lang: ${lang}`);
  const full = join(STRINGS_DIR, file);
  const proj = project();
  const sf = proj.addSourceFileAtPath(full);
  const obj = langObject(sf, lang);
  if (!obj) throw new Error(`no ${lang} object in ${file}`);
  const node = nodeAtPath(obj, path);
  const kind = node && node.getKind();
  if (!node || (!EDITABLE.has(kind) && kind !== SyntaxKind.TemplateExpression)) {
    throw new Error(`path not editable: ${path}`);
  }
  if (kind === SyntaxKind.TemplateExpression) {
    // Re-wrap as a template literal, keeping ${...} live; escape only bare
    // backticks (the value is already template-body source form).
    const body = String(value).replace(/(?<!\\)`/g, '\\`');
    node.replaceWithText('`' + body + '`');
  } else {
    const delim = node.getText()[0]; // ' " or `
    node.replaceWithText(encode(value, delim));
  }
  sf.saveSync();
  return { file, lang, path, value };
}
