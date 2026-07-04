// Pure, isomorphic session/state logic for the inline on-page editor. Runs in
// Node (unit tests) AND in the browser (imported by assets/inline.js): no
// Node imports, no DOM access — state in, state out. Mirrors inline-map.mjs's
// isomorphic contract.

// ---- editing-session lifecycle ----
// Encapsulates the single-slot "current edit session" state that used to live
// as an ad-hoc `editing` variable in assets/inline.js, including the `dirty`
// flag set on input and read by stopEdit()/save().
export function createSessionStore() {
  let session = null;
  return {
    // Starting a new session always replaces any session already in flight —
    // callers are responsible for flushing/ending the previous one first if
    // that matters (assets/inline.js's click handler does this explicitly).
    start(el, entry, original, domBefore) {
      session = { el, entry, original, domBefore, dirty: false };
      return session;
    },
    current() {
      return session;
    },
    markDirty() {
      if (session) session.dirty = true;
    },
    // Ends the session and returns it (or null if there was none) so callers
    // can flush/save it after clearing it from the store.
    end() {
      const ended = session;
      session = null;
      return ended;
    },
  };
}

// ---- duplicate-offer filtering ----
// Given the array of candidate entries for the old (pre-edit) value from the
// value index, and the {file, path} of the entry that was just saved, return
// every OTHER entry sharing that old value — i.e. candidates for one-click
// propagation. Excludes the entry that was just saved.
// `oldValueNorm` is accepted (not used in the filter itself) to keep the
// signature symmetric with the caller's lookup step (index.get(oldValueNorm))
// — see assets/inline.js's offerDuplicates, which passes the lookup result
// straight through as `indexEntries`.
export function duplicatesOffer(indexEntries, saved, oldValueNorm) {
  return (indexEntries || []).filter((e) => !(e.file === saved.file && e.path === saved.path));
}

// ---- pending-duplicates sessionStorage codec ----
// Encodes/decodes the "pending duplicates offer" persisted across the
// full-page reload that Astro's HMR triggers shortly after a successful save,
// so the toast can be restored on the other side. Freshness rule: an encoded
// offer older than maxAgeMs (default 30s) is considered stale and decodes to
// null, matching the original inline behavior.
export const pendingDupCodec = {
  encode(others, newValue, warn, ts) {
    return JSON.stringify({ others, newValue, warn, ts });
  },
  decode(raw, now, maxAgeMs = 30000) {
    if (!raw) return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const { others, newValue, warn, ts } = parsed;
    if (!Array.isArray(others) || typeof ts !== 'number') return null;
    if (now - ts >= maxAgeMs) return null;
    return { others, newValue, warn: warn || '' };
  },
};

// ---- reduced-motion matchMedia override decision ----
// Specification of the pre.js prefers-reduced-motion discrimination logic
// (see assets/pre.js's applyFreeze -> patched window.matchMedia). Given a
// media-query string, returns:
//   true  — force `matches: true` (reduce)
//   false — force `matches: false` (no-preference)
//   null  — unrelated query; pass through to the original matchMedia
// pre.js is a classic script and cannot import this module, so it duplicates
// this rule inline — this function is the reference implementation; keep the
// two in sync by hand if the rule ever changes.
export function reducedMotionOverride(query) {
  const q = String(query);
  if (q.indexOf('prefers-reduced-motion') === -1) return null;
  return q.indexOf('no-preference') === -1;
}
