// assets/inline.js — i18n Studio inline on-page editor.
// Injected by proxy.mjs into every HTML page of the proxied dev server.
// All logic with tests lives in inline-map.mjs (matching/serialization) and
// inline-state.mjs (session/duplicates/persistence state); this file is DOM glue only.
import { normalizeValue, serializeEdited, tagsChanged, buildIndex, unwrapSpans } from '/__i18n/inline-map.mjs';
import { createSessionStore, duplicatesOffer, pendingDupCodec } from '/__i18n/inline-state.mjs';

(async function boot() {
  try {
    const res = await fetch('/__i18n/api/strings');
    const { langs, files } = await res.json();
    const lang = langs.includes(document.documentElement.lang) ? document.documentElement.lang : langs[0];
    const index = buildIndex(files, lang);

    // ---- state ----
    const matched = new WeakMap(); // element → { entries, original } (original = on-disk source string)
    let matchedEls = [];
    const sessionStore = createSessionStore(); // { el, entry, original, domBefore, dirty }
    let mode = false;
    // Tracks the payload of a save() request currently in flight, so the
    // beforeunload handler can still beacon it if the tab closes before the
    // fetch settles (see save() and the beforeunload listener below).
    // Deliberately a single slot, not a queue: on overlapping saves only the
    // newest payload is kept for the unload beacon — the older fetch is
    // already in flight and normally completes on its own.
    let inflightPayload = null;
    const decorated = new Set(); // every element we've ever applied our outline to

    // ---- sessionStorage persistence (survives HMR full-page reloads) ----
    const SS_PREFIX = 'i18n-studio:';
    function ssGet(key) {
      try { return sessionStorage.getItem(SS_PREFIX + key); } catch { return null; }
    }
    function ssSet(key, value) {
      try { sessionStorage.setItem(SS_PREFIX + key, value); } catch {}
    }
    function ssRemove(key) {
      try { sessionStorage.removeItem(SS_PREFIX + key); } catch {}
    }

    // ---- badge UI (shadow DOM so host styles can't leak in either direction) ----
    const host = document.createElement('div');
    const sh = host.attachShadow({ mode: 'open' });
    sh.innerHTML = `
      <style>
        .badge{position:fixed;right:16px;bottom:16px;z-index:2147483647;font:12px/1.4 ui-monospace,monospace;
          background:#0c1116;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:8px 12px;
          cursor:pointer;user-select:none;box-shadow:0 4px 16px rgba(0,0,0,.4)}
        .badge.on{border-color:#3fb950;color:#3fb950}
        .toast{position:fixed;right:16px;bottom:64px;z-index:2147483647;font:12px/1.4 ui-monospace,monospace;
          background:#0c1116;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:10px 14px;
          max-width:340px;display:none}
        .toast button{margin-left:8px;font:inherit;cursor:pointer}
        .keyhint{position:fixed;left:16px;bottom:16px;z-index:2147483647;font:12px/1.4 ui-monospace,monospace;
          background:#0c1116;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:8px 12px;
          box-shadow:0 4px 16px rgba(0,0,0,.4);pointer-events:none;display:none;max-width:340px;white-space:pre-wrap}
      </style>
      <div class="keyhint" part="keyhint"></div>
      <div class="badge" part="badge">i18n edit: off</div>
      <div class="toast"></div>`;
    document.documentElement.appendChild(host);
    const badge = sh.querySelector('.badge');
    const toastEl = sh.querySelector('.toast');
    const keyhint = sh.querySelector('.keyhint');
    function toast(html, ms = 6000) {
      toastEl.innerHTML = html; toastEl.style.display = 'block';
      clearTimeout(toastEl._t); toastEl._t = setTimeout(() => (toastEl.style.display = 'none'), ms);
    }

    // ---- matching ----
    const SKIP = new Set(['SCRIPT', 'STYLE', 'SVG', 'TEXTAREA', 'INPUT', 'SELECT', 'IFRAME', 'CANVAS']);
    function scan() {
      matchedEls = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: (el) =>
          SKIP.has(el.tagName) || el === host || host.contains(el) || el.isContentEditable
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      });
      for (let el = walker.nextNode(); el; el = walker.nextNode()) {
        const entries = index.get(normalizeValue(unwrapSpans(cleanHtml(el))));
        if (entries) {
          // Nested matches (parent wrapping a matching child) are both tagged;
          // the click handler resolves via composedPath(), which is ordered
          // innermost-first — so the innermost match wins at edit time.
          matched.set(el, { entries, original: entries[0].value });
          matchedEls.push(el);
        }
      }
      badge.textContent = `i18n edit: ${mode ? 'on' : 'off'} · ${matchedEls.length} matched`;
    }

    // ---- edit mode ----
    function outline(el, color) { el.style.outline = `1px dashed ${color}`; el.style.outlineOffset = '2px'; decorated.add(el); }
    function clearOutline(el) { el.style.outline = ''; el.style.outlineOffset = ''; }

    function onMatchedHover(ev) {
      const el = ev.composedPath().find((n) => n instanceof Element && matched.has(n));
      if (!el) { keyhint.style.display = 'none'; return; }
      keyhint.textContent = matched.get(el).entries.map((e) => `${e.file} → ${e.path}`).join(' · ');
      keyhint.style.display = 'block';
    }

    // `fromBoot` distinguishes the two callers of setMode(true):
    //  - manual (fromBoot=false, the default): the user clicked the badge.
    //    On first toggle-on, animations may still be live (pre.js only disables
    //    them on a fresh navigation), so we reload once to get a clean pass.
    //  - boot restore (fromBoot=true): sessionStorage already says mode=on
    //    after that reload, and pre.js has ALREADY run (setting
    //    window.__i18nPreActive = true) before this script executes — so the
    //    `!window.__i18nPreActive` guard below is false and no further reload
    //    is triggered. This makes the reload-once loop self-terminating: the
    //    only path that can schedule a reload is the manual path, and by the
    //    time boot restore re-enters edit mode post-reload, the guard is shut.
    function setMode(on, { fromBoot = false } = {}) {
      mode = on;
      badge.classList.toggle('on', on);
      if (on) {
        for (const el of matchedEls) outline(el, '#8b949e');
        document.addEventListener('mouseover', onMatchedHover);
      } else {
        // Clean up every element we've ever decorated, not just current
        // matchedEls — a stale outline can survive on an element whose
        // match broke since it was decorated (e.g. re-scan mid-session).
        for (const el of decorated) {
          clearOutline(el);
          if (el.isContentEditable) stopEdit(el, true);
        }
        decorated.clear();
        document.removeEventListener('mouseover', onMatchedHover);
        keyhint.style.display = 'none';
        // Un-freeze: remove the injected style and restore the original
        // matchMedia so site transitions/animations work again. Best-effort:
        // site scripts that already read the patched matchMedia value at load
        // keep that decision until the next reload.
        try {
          const freezeStyle = document.getElementById('i18n-studio-freeze');
          if (freezeStyle) freezeStyle.remove();
          if (window.__i18nOrigMatchMedia) window.matchMedia = window.__i18nOrigMatchMedia;
          // Clear the patched flag so a subsequent __i18nApplyFreeze() call
          // (re-toggle-on) re-wraps matchMedia instead of no-op'ing.
          window.__i18nMatchMediaPatched = false;
        } catch {}
      }
      ssSet('mode', on ? '1' : '');
      badge.textContent = `i18n edit: ${on ? 'on' : 'off'} · ${matchedEls.length} matched`;
      if (on && !fromBoot && !window.__i18nPreActive) {
        toast('animations on — reloading to enable full matching…');
        setTimeout(() => location.reload(), 600);
      }
      // Re-toggle-on within the same page life: pre.js's reload guard
      // (__i18nPreActive) only fires once, so a prior toggle-off (which
      // removes the freeze style and restores matchMedia) would otherwise
      // leave this second toggle-on unprotected. Re-apply the freeze
      // directly if it's missing and the helper pre.js exposed is available.
      if (on && !document.getElementById('i18n-studio-freeze') && typeof window.__i18nApplyFreeze === 'function') {
        try { window.__i18nApplyFreeze(); } catch {}
      }
    }

    badge.addEventListener('click', () => {
      if (mode) { setMode(false); }
      else { scan(); setMode(true); }
    });

    document.addEventListener('click', (ev) => {
      if (!mode) return;
      const el = ev.composedPath().find((n) => n instanceof Element && matched.has(n));
      if (!el) return;
      ev.preventDefault(); ev.stopPropagation();
      const active = sessionStore.current();
      if (active && active.el !== el) stopEdit(active.el, true);
      startEdit(el);
    }, true);

    // Belt-and-braces: strip any leftover injected `title="...ts → ..."` attributes
    // (e.g. from a page reloaded mid-session, or a future regression) before we
    // ever read innerHTML for serialization or comparison. Legitimate authored
    // title attributes don't match this pattern and survive untouched.
    const INJECTED_TITLE_RE = /\.ts → /;
    function stripInjectedOutline(node) {
      if (!node.hasAttribute || !node.hasAttribute('style')) return;
      node.style.removeProperty('outline');
      node.style.removeProperty('outline-offset');
      if (node.getAttribute('style') === '') node.removeAttribute('style');
    }
    function cleanHtml(el) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('[title]').forEach((n) => {
        if (INJECTED_TITLE_RE.test(n.getAttribute('title') || '')) n.removeAttribute('title');
      });
      if (clone.hasAttribute && clone.hasAttribute('title') && INJECTED_TITLE_RE.test(clone.getAttribute('title') || '')) {
        clone.removeAttribute('title');
      }
      // Strip our own injected outline styles from descendants so a nested
      // matched child's decoration doesn't break the parent's innerHTML match.
      clone.querySelectorAll('[style]').forEach(stripInjectedOutline);
      return clone.innerHTML;
    }

    function startEdit(el) {
      if (el.isContentEditable) return;
      const m = matched.get(el);
      sessionStore.start(el, m.entries[0], m.original, unwrapSpans(cleanHtml(el)));
      el.contentEditable = 'true'; el.focus(); outline(el, '#d29922');
      el.addEventListener('input', onInput);
      el.addEventListener('blur', onBlur);
      el.addEventListener('keydown', onKey);
    }
    function stopEdit(el, flush) {
      el.contentEditable = 'false';
      el.removeEventListener('input', onInput);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('keydown', onKey);
      clearOutline(el); if (mode) outline(el, '#8b949e');
      const current = sessionStore.current();
      if (flush && current && current.dirty) save();
      sessionStore.end();
    }
    const onBlur = () => sessionStore.current() && stopEdit(sessionStore.current().el, true);
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); sessionStore.current() && stopEdit(sessionStore.current().el, true); } };
    function onInput() {
      outline(sessionStore.current().el, '#d29922');
      sessionStore.markDirty();
    }

    // Shared serialization: turns a session's current DOM state into the
    // {file, lang, path, value} payload used by both the normal save() path
    // and the beforeunload beacon, so the two cannot drift.
    function serializeSession(session) {
      const { el, entry } = session;
      const cleanedInnerHtml = unwrapSpans(cleanHtml(el));
      const value = serializeEdited(cleanedInnerHtml);
      return { file: entry.file, lang, path: entry.path, value };
    }

    async function save() {
      const session = sessionStore.current();
      if (!session) return;
      const { el, entry, original, domBefore } = session;
      const payload = serializeSession(session);
      const { value } = payload;
      if (normalizeValue(value) === normalizeValue(original)) return; // no-op edit
      inflightPayload = payload;
      try {
        const r = await fetch('/__i18n/api/save', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const out = await r.json();
        if (!out.ok) throw new Error(out.error || `HTTP ${r.status}`);
        outline(el, '#3fb950'); setTimeout(() => el.isConnected && mode && !el.isContentEditable && outline(el, '#8b949e'), 800);
        const cleanedInnerHtml = unwrapSpans(cleanHtml(el));
        const warn = tagsChanged(domBefore, cleanedInnerHtml) ? '⚠ markup changed — double-check in the studio. ' : '';
        if (matched.has(el)) matched.get(el).original = value;
        if (sessionStore.current() === session) session.original = value;
        offerDuplicates(entry, original, value, warn);
      } catch (e) {
        outline(el, '#f85149');
        toast(`save failed: ${e.message}`);
        console.warn('[i18n-studio]', e);
      } finally {
        inflightPayload = null;
      }
    }

    // Same old value elsewhere in the corpus → one-click propagation.
    // The offer+toast is also persisted to sessionStorage so it survives the
    // full-page reload HMR triggers ~100-500ms after a successful save.
    function showDuplicatesToast(others, newValue, warn) {
      toast(`${warn}applied — same text in ${others.length} more place${others.length > 1 ? 's' : ''} <button>apply to all</button>`, 12000);
      toastEl.querySelector('button').onclick = async () => {
        try {
          const r = await fetch('/__i18n/api/save-many', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ edits: others.map((e) => ({ file: e.file, lang, path: e.path, value: newValue })) }),
          });
          const out = await r.json();
          if (!r.ok || !out.ok) throw new Error(out && out.error || `HTTP ${r.status}`);
          others.forEach((e) => { e.value = newValue; });
          ssRemove('pending-dup');
          toast(`applied to ${others.length} more`);
        } catch (e) {
          toast(`apply to all failed: ${e.message}`);
          console.warn('[i18n-studio]', e);
        }
      };
    }

    function offerDuplicates(saved, oldValue, newValue, warn = '') {
      const oldValueNorm = normalizeValue(oldValue);
      const others = duplicatesOffer(index.get(oldValueNorm), saved, oldValueNorm);
      if (!others.length) { if (warn) toast(warn); return; }
      ssSet('pending-dup', pendingDupCodec.encode(others, newValue, warn, Date.now()));
      showDuplicatesToast(others, newValue, warn);
    }

    // Safety net: a dirty edit session lost to tab close / navigation would
    // otherwise never save. sendBeacon fires a fire-and-forget POST using the
    // same serialization pipeline as save(), so the two paths can't drift.
    window.addEventListener('beforeunload', () => {
      const active = sessionStore.current();
      if (active && active.dirty) {
        const payload = serializeSession(active);
        if (normalizeValue(payload.value) === normalizeValue(active.original)) return; // no-op edit
        navigator.sendBeacon('/__i18n/api/save', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        return;
      }
      // No active dirty session, but a save() may still be in flight (e.g.
      // stopEdit fired save() without awaiting it, then ended the session).
      // Beacon the same payload — sendBeacon is idempotent here, so a
      // redundant write is harmless.
      if (inflightPayload) {
        navigator.sendBeacon('/__i18n/api/save', new Blob([JSON.stringify(inflightPayload)], { type: 'application/json' }));
      }
    });

    scan();

    // ---- restore state across HMR full-page reloads ----
    if (ssGet('mode')) setMode(true, { fromBoot: true });
    const pendingRaw = ssGet('pending-dup');
    if (pendingRaw) {
      ssRemove('pending-dup');
      const pending = pendingDupCodec.decode(pendingRaw, Date.now());
      if (pending) showDuplicatesToast(pending.others, pending.newValue, pending.warn);
    }
  } catch (e) {
    console.warn('[i18n-studio] overlay failed to boot:', e);
  }
})();
