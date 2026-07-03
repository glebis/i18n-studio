# i18n Studio

A local web workstation for **localizing Astro-style i18n string files** at scale.
Each file is an `export default { en: {...}, ru: {...}, … }` object; editing a
string writes the `.ts` file with a minimal one-line diff (via `ts-morph`), so a
running dev server hot-reloads. Built for going through thousands of strings:
filtering, a review/acceptance workflow, duplicate propagation, Claude
translation suggestions, and a keyboard-driven fullscreen review mode.

Works against **any** repo that follows the convention, not one project.

## Run

```bash
# from the target repo root (auto-detects ./src/i18n/strings):
node ~/ai_projects/i18n-studio/server.mjs

# or point it anywhere, with more languages and a tone brief:
node ~/ai_projects/i18n-studio/server.mjs --dir path/to/strings --langs en,ru,de --voice "Warm, plain, no jargon."
```

Open the printed URL (default http://localhost:4331). Keep the target project's
own dev server running in another terminal to see edits hot-reload. First time
only: `cd ~/ai_projects/i18n-studio && npm install`.

## Features

- **Source → target language switch.** Pick any language as the read-only source
  reference and any as the editable target; switch either from the header. Scales
  past two languages without a wall of columns.
- **Filters + sort.** Filter by free text (key or value), by status
  (all / untranslated / pending / accepted / duplicates / code-like), and by file.
  Sort by file order, path, status, or duplicates-first. Live counts of
  accepted / pending / untranslated / code for the current target.
- **Hide code-like values.** Asset paths (`/img/x.png`), CSS (`var(--x)`, `#0c1116`),
  class names and other identifiers are detected and hidden from the translation
  queue by default (`hide code`); flip to SHOW → code-like to review them.
- **Review acceptance.** Mark a translation accepted; it stays accepted only while
  the value is unchanged (any edit drops it back to pending). Stored in a sidecar
  `.i18n-status.json` next to the strings (see below).
- **Duplicate propagation.** Identical values are detected across the whole corpus.
  After editing one, a banner offers to apply the new value to every other entry
  that still holds the old one.
- **Fullscreen review mode.** Step through the filtered set one entry at a time,
  fully keyboard driven, with the shortcut legend always visible:
  `←/→` or `j/k` prev·next, `a` accept & next, `p` mark pending, `e` edit,
  `s` suggest, `1/2/3` apply a suggestion, `u` undo, `Esc` close, `>` focus.
  Pressing Tab lands directly on the edit field. Clicking the file name filters
  the list to that file.
- **Focus mode.** `Shift + .` (`>`) hides all chrome (header, filters, footer,
  review bar and legend), leaving only the strings. Press again to restore.
- **Source ≠ target.** The two languages can never be the same; picking a match
  bumps the other.
- **Suggestions.** Claude proposes 3 translations from the source language,
  preserving HTML tags/entities and tone.
- **Auto-save + undo.** Edits debounce (500 ms) and write straight to the `.ts`
  file; the last 200 edits are kept in `localStorage` with an undo control.
- **Inline on-page editing (proxy mode).** Run with `--proxy http://localhost:4321`
  (your dev server) and open `http://localhost:4332`: the studio proxies the site
  and injects an editor. Toggle the corner badge, click any matched text, edit in
  place — saves are debounced through the same AST-safe pipeline (acceptance drops,
  duplicates offered via a toast). HTML strings are edited rich; a warning appears
  if the markup structure changed. Zero changes to the target repo.

  Matching is resilient to scroll-reveal animations that wrap words in spans at
  runtime (e.g. `<span class="w">Start</span> <span class="w">from</span> …`):
  those wrapper spans are stripped before comparing against the corpus, and saves
  write back the clean unwrapped text. In addition, while edit mode is on, the
  proxy signals `prefers-reduced-motion` to the page and freezes CSS animations
  and transitions, so reveal/animation scripts don't rewrite the DOM out from
  under the scanner mid-match. The very first toggle-on reloads the page once so
  this signal is in place before the site's own scripts run; subsequent toggles
  don't reload.

Large corpora: the list renders up to 150 filtered rows (a notice shows the rest);
narrow the filter or use review mode to go through everything.

## Configuration (flags > env > default)

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--dir <path>` | `I18N_STRINGS_DIR` | `<cwd>/src/i18n/strings` | Directory of `*.ts` string files |
| `--langs en,ru` | `I18N_LANGS` | `en,ru` | Language keys, in display order |
| `--voice "..."` | `I18N_VOICE` | editorial default | One-line tone brief for suggestions |
| `--port 4331` | `PORT` | `4331` | Server port |

## Acceptance sidecar

Review state lives in `<strings-dir>/.i18n-status.json`, mapping
`file::lang::path` to the hash of the accepted value. It is separate from the
`.ts` sources. Commit it to share review progress across a team, or gitignore it
to keep acceptance local. The `.ts` filter ignores it, so it never appears as a
string.

## HTTP API

The server is scriptable (see the `i18n-studio` skill and `scripts/i18n.mjs`):

- `GET  /api/strings` → `{ langs, files: [{ file, entries: [{ path, <lang>: { value, editable, accepted } }] }] }`
- `POST /api/save`      → `{ file, lang, path, value }`; AST-safe write; drops acceptance for that cell
- `POST /api/save-many` → `{ edits: [{ file, lang, path, value }] }`; batch write (duplicate propagation)
- `POST /api/accept`    → `{ file, lang, path, value, accepted }`; toggle review acceptance
- `POST /api/suggest`   → `{ sourceText, from, to, path }`; returns `{ ok, suggestions: [...] }`

`path` is a dot-path with numeric array indices, e.g. `weeks.2.sessions.1.t`.

## How it works

- `config.mjs` — resolves target dir, languages, voice, and port.
- `strings.mjs` — `ts-morph` reads/writes the `export default { … }` literals by
  dot-path; writes replace only the target string node, so formatting never churns.
- `status.mjs` — the acceptance sidecar (value-hash based, auto-invalidating).
- `server.mjs` — [Hono](https://hono.dev) backend + single-page `index.html`.
- `index.html` — Alpine.js single page, no build step.
- Suggestions use `@anthropic-ai/claude-agent-sdk`'s `query()`, authenticated via
  your logged-in **Claude Code subscription** (no API key). A stale
  `ANTHROPIC_API_KEY` is dropped at startup so session auth is used.

## Interpolated strings

Strings with `${…}` interpolation (e.g. `` `Small cohort of ${d.en.cohortSize}` ``)
are **editable**: the prose around the placeholders is translatable and the tool
re-wraps the value as a template literal on save, keeping every `${…}` live. Such
rows carry a `${…}` badge as a reminder to keep the placeholders intact.

## Notes / limits

- Non-string leaves (numbers, identifiers) remain read-only; edit them by hand
  in the `.ts` source.
- A target key that does not exist yet is shown read-only: add it once in the `.ts`
  source, then it becomes editable here.
- One save writes one leaf; bulk changes are multiple saves (propagation uses the
  batch route).
