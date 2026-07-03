# Design — inline on-page editing (proxy mode)

Approved in conversation 2026-07-03. Decisions: proxy mode · toggle + click-to-edit · rich in-place HTML editing.

## 1. Architecture

- New flag `--proxy <target-url>` (env `I18N_PROXY_TARGET`). When set, the studio starts a second Hono server on `PORT + 1` (default 4332) alongside the studio UI on 4331.
- The proxy forwards every request to the target dev server (method, headers, body, streaming), including WebSocket upgrade for Vite/Astro HMR.
- For responses with `content-type: text/html`, it injects `<script src="/__i18n/inline.js" defer></script>` before `</body>` (fallback: append to end of body). All other responses pass through untouched.
- Reserved path prefix `/__i18n/`:
  - `/__i18n/inline.js` → serves `assets/inline.js`.
  - `/__i18n/api/*` → forwarded to the studio's own API routes (`/api/*`). Same-origin from the page's perspective; no CORS.
- New files: `proxy.mjs` (createProxyApp: forwarding + injection; pure, testable via `app.request` with an injected `fetchFn`), `assets/inline.js` (overlay), `inline-map.mjs` (pure normalization/serialization shared logic, unit-tested).
- `server.mjs` wires the flag; importing stays side-effect-free (serve only under `main`), matching the repo convention.

## 2. Key matching (overlay boot)

- On load, fetch `/__i18n/api/strings`; detect page language from `<html lang>` (fallback: studio target lang).
- Build `normalizedValue → [entries]` for that language. Normalization (in `inline-map.mjs`): decode HTML entities to characters (`&nbsp;` ⇄ ` `, `&amp;`, `&rarr;`, numeric refs), collapse whitespace runs, trim, lowercase tag names, drop inter-tag whitespace.
- Walk the DOM (skip `script`, `style`, `svg`, form controls, `[contenteditable]`): an element matches when its normalized `innerHTML` equals a corpus value and none of its ancestors already matched (innermost-wins prevents nested double-matching). Matched elements get `data-i18n-entry` (JSON: file, keyPath, lang) in memory (WeakMap, no DOM attribute pollution).
- Re-scan triggers: edit-mode toggle ON, and an "rescan" button on the badge (covers client-side re-renders; no MutationObserver in v1 — YAGNI).

## 3. Editing & auto-save

- Floating badge (bottom-right, high z-index, shadow-DOM to isolate styles) toggles edit mode; shows match count.
- Edit mode ON: matched elements get a subtle dashed outline on hover + tooltip with `file → key.path`; click sets `contenteditable=true` and focuses. Clicks on matched elements are intercepted (preventDefault) so links don't navigate; edit mode OFF removes all listeners/outlines — page is untouched.
- On `input`: debounce 500 ms → serialize → `POST /__i18n/api/save { file, keyPath, lang, value }`.
- Serialization (in `inline-map.mjs`): take `innerHTML`, re-encode ` ` → `&nbsp;`, strip editing artifacts (`<br>` inserted at ends, empty inline tags, `style` attributes browsers add), normalize quotes to the source string's quote style where detectable. Keep it conservative: if the serialized value normalizes equal to the original, skip the save.
- Save state on the element outline: pulsing amber (pending) → green flash (saved) → red persistent (error, with toast showing the message).
- Tag-integrity check: compare tag-name multiset before/after; on mismatch show a non-blocking warning chip near the element ("markup changed — check the studio"), still save.
- `Esc` or blur ends editing. Acceptance drop is free (existing `status.mjs` value-hash behavior).

## 4. Duplicates

- The `/api/strings` payload already lets the overlay compute value-duplicates. After a successful save where the *old* value exists under other keys (same lang), show a toast: "Applied. Same text in N other places — apply to all?" → `POST /__i18n/api/save-many` with the same shape the studio list uses.
- Ambiguous match (same rendered value under multiple keys): tooltip lists all candidates; save writes the first, duplicates toast immediately offers the rest.

## 5. Error handling

- Proxy target down: respond 502 with a plain page naming the target URL and the flag to fix.
- Save failure (parse error, file gone): red outline + toast with server message; element keeps user's text so nothing is lost.
- Overlay never throws into the host page: everything wrapped, logs prefixed `[i18n-studio]`.

## 6. Testing (TDD, node:test)

- `test/inline-map.test.mjs`: normalization equivalences (`&nbsp;` vs ` `, entity refs, whitespace), serialization round-trips (plain, `<b>`, nested spans, editing artifacts stripped), tag-multiset check.
- `test/proxy.test.mjs`: `createProxyApp({ fetchFn })` — HTML gets the script tag exactly once (with/without `</body>`); non-HTML byte-identical; `/__i18n/api/*` hits the studio app; 502 page on upstream failure.
- Overlay DOM behavior: kept thin over the pure modules; verified manually per the goal contract's evidence list.
