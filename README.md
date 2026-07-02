# i18n Studio

A tiny local web tool to edit **Astro-style i18n string files** and get live
translation suggestions from Claude. Each file is an
`export default { en: {...}, ru: {...} }` object; editing a string writes the
`.ts` file with a minimal one-line diff, so a running dev server hot-reloads.

Works against **any** repo that follows that convention, not just one project.

## Run

```bash
# from the target repo root (auto-detects ./src/i18n/strings):
node ~/ai_projects/i18n-studio/server.mjs

# or point it anywhere:
node ~/ai_projects/i18n-studio/server.mjs --dir path/to/strings
```

Then open the printed URL (default http://localhost:4331). Keep the target
project's own dev server running in another terminal to see edits hot-reload.

First time only: `cd ~/ai_projects/i18n-studio && npm install`.

## Configuration

Flags take priority over env vars; both are optional.

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--dir <path>` | `I18N_STRINGS_DIR` | `<cwd>/src/i18n/strings` | Directory of `*.ts` string files |
| `--langs en,ru` | `I18N_LANGS` | `en,ru` | Language keys, in display order |
| `--voice "..."` | `I18N_VOICE` | editorial default | One-line tone brief for suggestions |
| `--port 4331` | `PORT` | `4331` | Server port |

## What it does

- **Shows every string** in all configured languages, grouped by file, with a
  live filter (matches key or text).
- **Editable vs computed.** Plain string literals (and static backtick
  templates) are editable. Template literals with `${…}` are computed and shown
  **read-only** — they can't be edited as static text.
- **Suggest.** Each editable cell has a *suggest* button: Claude proposes 3
  translations from another language, preserving HTML tags/entities and tone.
- **Auto-save.** Edits debounce (500 ms) and write straight to the `.ts` file —
  a minimal one-line diff, formatting preserved (via `ts-morph` AST edits).
- **Backup.** Every save pushes the previous value into `localStorage`
  (last 200 edits); *undo last edit* restores the most recent change.

## HTTP API

The server is scriptable, which is how agents drive it (see the `i18n-studio`
skill):

- `GET  /api/strings` → `{ langs, files: [{ file, entries: [{ path, <lang>: { value, editable } }] }] }`
- `POST /api/save`    → body `{ file, lang, path, value }`; AST-safe write, returns `{ ok, saved }`
- `POST /api/suggest` → body `{ sourceText, from, to, path }`; returns `{ ok, suggestions: [...] }`

`path` is a dot-path with numeric array indices, e.g. `weeks.2.sessions.1.t`.

## How it works

- `config.mjs` — resolves target dir, languages, voice, and port from flags/env.
- `strings.mjs` — `ts-morph` reads/writes the `export default { … }` object
  literals, walking to each leaf by dot-path. Writes replace only the target
  string node, so unrelated formatting never churns.
- `server.mjs` — [Hono](https://hono.dev) backend with the three routes above,
  serving the single-page `index.html`.
- `index.html` — Alpine.js single page, no build step.
- Suggestions use `@anthropic-ai/claude-agent-sdk`'s `query()`, authenticated via
  your logged-in **Claude Code subscription** (no API key needed). A stale
  `ANTHROPIC_API_KEY` in the env is dropped at startup so the SDK falls back to
  session auth.

## Notes / limits

- The editor shows and edits **all** configured languages at once, independent of
  which single `SITE_LANG` a target dev server was started with.
- Read-only computed strings (`${d.en.…}` interpolation) must be edited by hand
  in the `.ts` source.
