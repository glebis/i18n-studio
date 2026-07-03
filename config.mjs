// Runtime configuration for i18n Studio.
//
// The tool is project-agnostic: point it at any repo whose translations live in
// `export default { <lang>: {...} }` TypeScript files (the Astro i18n convention).
// Everything is resolved once, here, from CLI flags first, then env, then a
// convention-based default relative to the current working directory.
//
// Flags (all optional):
//   --dir <path>       directory of *.ts string files   (I18N_STRINGS_DIR)
//   --langs en,ru      language keys, in display order   (I18N_LANGS)
//   --voice "..."      one-line tone brief for suggestions (I18N_VOICE)
//   --port 4331        server port                        (PORT)

import { resolve } from 'node:path';

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

export const STRINGS_DIR = resolve(
  flag('dir') || process.env.I18N_STRINGS_DIR || resolve(process.cwd(), 'src/i18n/strings'),
);

export const LANGS = (flag('langs') || process.env.I18N_LANGS || 'en,ru')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Human-readable names for the suggestion prompt. Unknown codes fall back to the
// code itself, so adding a language never breaks — it just reads a little rawer.
const KNOWN_NAMES = {
  en: 'English', ru: 'Russian', de: 'German', fr: 'French', es: 'Spanish',
  it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
  ja: 'Japanese', zh: 'Chinese', ko: 'Korean', tr: 'Turkish', ar: 'Arabic',
};
export const langName = (code) => KNOWN_NAMES[code] || code;

export const VOICE =
  flag('voice') ||
  process.env.I18N_VOICE ||
  'Concise, confident, a little editorial. Never generic marketing fluff.';

export const PORT = Number(flag('port') || process.env.PORT || 4331);

// Inline on-page editing: proxy the target dev server with the overlay injected.
//   --proxy http://localhost:4321   (I18N_PROXY_TARGET)
export const PROXY_TARGET = flag('proxy') || process.env.I18N_PROXY_TARGET || undefined;
export const PROXY_PORT = PORT + 1;
