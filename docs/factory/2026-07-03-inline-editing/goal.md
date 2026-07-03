# Goal Contract — inline on-page editing (proxy mode)

> Source of truth. Agents may propose **Goal Amendments**; they may not silently rewrite this.

## Core

### Current state (≤3)
- Strings are edited in the studio list/review UI, out of visual context; judging copy length, tone, and wrapping requires flipping between the studio tab and the rendered site.
- The studio already has AST-safe saves (`/api/save`, `/api/save-many`), duplicate detection, acceptance tracking, and hot-reload via the target repo's dev server.
- There is no way to click a text on the rendered page and change it.

### Desired future state (≤3)
- The studio can proxy the target site's dev server and inject an editing overlay; texts are editable in place on the real page.
- Edits auto-save through the existing save pipeline (debounced, AST-safe, acceptance dropped, duplicates offered) with visible save state.
- Works against any conforming repo with zero changes to the target repo.

### Desired outcomes (solution-independent, measurable; ≤5)
- Editing a string on the page updates the correct key in the correct `.ts` file with a minimal diff, within ~1 s of typing stopping.
- Strings containing HTML (`<b>`, `<span>`, `&nbsp;`) round-trip without corruption: unedited parts of the source string stay byte-identical where feasible (entities re-encoded, no editing artifacts).
- A value that exists under multiple keys can be propagated in one action after an inline edit.
- Normal site behavior is unaffected when edit mode is off (links, animations, HMR).

### Smallest shippable slice   <!-- required -->
Proxy (`--proxy <url>`) + overlay that matches exact-value plain-text strings, click-to-edit, debounced auto-save with green/red save state. HTML normalization, tag-mismatch warning, and the duplicates toast layer on next.

### Stop condition   <!-- required -->
If reliable innerHTML→source serialization proves impossible for a class of strings (browser rewrites markup beyond normalization), stop and re-scope those strings to a popover/raw-source fallback instead of pushing serialization heuristics further.

### Success evidence (≤5)
- `npm test` green, with new `node:test` suites for value normalization, innerHTML→source serialization, and proxy HTML injection (fake upstream via `app.request`).
- Manual browser check on the ai-design repo: edit a plain string and an HTML-bearing string on the page; both hot-reload and produce a one-line git diff in the strings file.
- Duplicate edit on the page offers "apply to N more" and `/api/save-many` applies it.
- With edit mode off, site interaction is indistinguishable from the un-proxied dev server.

### Risk classification
R1 internal dev-assist (local tool, localhost only).
EU AI Act: Art 5 prohibited use? N/A · Art 50 labelling? N/A

### Tracker
none
