// assets/inline.js — i18n Studio inline on-page editor.
// Injected by proxy.mjs into every HTML page of the proxied dev server.
// All logic with tests lives in inline-map.mjs; this file is DOM glue only.
import { normalizeValue, serializeEdited, tagsChanged, buildIndex } from '/__i18n/inline-map.mjs';

(async function boot() {
  try {
    const res = await fetch('/__i18n/api/strings');
    const { langs, files } = await res.json();
    const lang = langs.includes(document.documentElement.lang) ? document.documentElement.lang : langs[0];
    const index = buildIndex(files, lang);

    // ---- state ----
    const matched = new WeakMap(); // element → { entries, original } (original = on-disk source string)
    let matchedEls = [];
    let editing = null;            // { el, entry, original }
    let saveTimer = 0;
    let mode = false;

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
      </style>
      <div class="badge" part="badge">i18n edit: off</div>
      <div class="toast"></div>`;
    document.documentElement.appendChild(host);
    const badge = sh.querySelector('.badge');
    const toastEl = sh.querySelector('.toast');
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
        const entries = index.get(normalizeValue(el.innerHTML));
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
    function outline(el, color) { el.style.outline = `1px dashed ${color}`; el.style.outlineOffset = '2px'; }
    function clearOutline(el) { el.style.outline = ''; el.style.outlineOffset = ''; }

    function setMode(on) {
      mode = on;
      badge.classList.toggle('on', on);
      for (const el of matchedEls) {
        if (on) { outline(el, '#8b949e'); el.title = matched.get(el).entries.map((e) => `${e.file} → ${e.path}`).join('\n'); }
        else { clearOutline(el); el.removeAttribute('title'); if (el.isContentEditable) stopEdit(el, false); }
      }
      badge.textContent = `i18n edit: ${on ? 'on' : 'off'} · ${matchedEls.length} matched`;
    }

    badge.addEventListener('click', () => { scan(); setMode(!mode); });

    document.addEventListener('click', (ev) => {
      if (!mode) return;
      const el = ev.composedPath().find((n) => n instanceof Element && matched.has(n));
      if (!el) return;
      ev.preventDefault(); ev.stopPropagation();
      if (editing && editing.el !== el) stopEdit(editing.el, true);
      startEdit(el);
    }, true);

    function startEdit(el) {
      if (el.isContentEditable) return;
      const m = matched.get(el);
      editing = { el, entry: m.entries[0], original: m.original, domBefore: el.innerHTML };
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
      if (flush) { clearTimeout(saveTimer); save(); }
      editing = null;
    }
    const onBlur = () => editing && stopEdit(editing.el, true);
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); editing && stopEdit(editing.el, true); } };
    function onInput() {
      outline(editing.el, '#d29922');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 500);
    }

    async function save() {
      if (!editing) return;
      const { el, entry, original, domBefore } = editing;
      const value = serializeEdited(el.innerHTML);
      if (normalizeValue(value) === normalizeValue(original)) return; // no-op edit
      try {
        const r = await fetch('/__i18n/api/save', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ file: entry.file, lang, path: entry.path, value }),
        });
        const out = await r.json();
        if (!out.ok) throw new Error(out.error || `HTTP ${r.status}`);
        outline(el, '#3fb950'); setTimeout(() => el.isConnected && mode && !el.isContentEditable && outline(el, '#8b949e'), 800);
        if (tagsChanged(domBefore, el.innerHTML)) toast('⚠ markup changed — double-check in the studio');
        matched.get(el).original = value; editing.original = value;
        offerDuplicates(entry, original, value);
      } catch (e) {
        outline(el, '#f85149');
        toast(`save failed: ${e.message}`);
        console.warn('[i18n-studio]', e);
      }
    }

    // Same old value elsewhere in the corpus → one-click propagation.
    function offerDuplicates(saved, oldValue, newValue) {
      const others = (index.get(normalizeValue(oldValue)) || [])
        .filter((e) => !(e.file === saved.file && e.path === saved.path));
      if (!others.length) return;
      toast(`applied — same text in ${others.length} more place${others.length > 1 ? 's' : ''} <button>apply to all</button>`, 12000);
      toastEl.querySelector('button').onclick = async () => {
        await fetch('/__i18n/api/save-many', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ edits: others.map((e) => ({ file: e.file, lang, path: e.path, value: newValue })) }),
        });
        others.forEach((e) => { e.value = newValue; });
        toast(`applied to ${others.length} more`);
      };
    }

    scan();
  } catch (e) {
    console.warn('[i18n-studio] overlay failed to boot:', e);
  }
})();
