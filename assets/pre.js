// assets/pre.js — i18n Studio pre-boot script. Injected right after <head> so it
// runs synchronously BEFORE any site scripts. Classic script (no import/export):
// must be loadable via a plain <script src> tag. Never throws.
try {
  // Capture the un-patched matchMedia once, before any patching, regardless of
  // whether the freeze is applied at load. Both applyFreeze() (below) and
  // inline.js's un-freeze path rely on this being the true original.
  if (window.matchMedia && !window.__i18nOrigMatchMedia) {
    window.__i18nOrigMatchMedia = window.matchMedia;
  }

  // Applies the animation freeze: patches matchMedia to report
  // prefers-reduced-motion:true, and injects a CSS rule disabling
  // animations/transitions/scroll-behavior. Exposed unconditionally as
  // window.__i18nApplyFreeze so inline.js can re-apply it on a re-toggle-on
  // within the same page life, without requiring a reload. Idempotent: safe
  // to call multiple times — won't double-wrap matchMedia or duplicate the
  // style element.
  function applyFreeze() {
    // Signal prefers-reduced-motion: true so scroll-reveal / animation libraries
    // that check matchMedia at runtime skip their word-wrapping DOM rewrites.
    // This is a classic (non-module) script and cannot import inline-state.mjs,
    // so the reduce/no-preference/pass-through decision below is duplicated by
    // hand — see reducedMotionOverride() in inline-state.mjs for the reference
    // implementation/spec and its tests; keep the two in sync if this rule changes.
    var origMatchMedia = window.__i18nOrigMatchMedia;
    if (origMatchMedia && !window.__i18nMatchMediaPatched) {
      window.__i18nMatchMediaPatched = true;
      window.matchMedia = function (query) {
        var q = String(query);
        // A prefers-reduced-motion query with no explicit value (e.g. just
        // "(prefers-reduced-motion)") is deliberately treated as reduce=true —
        // fail toward frozen animations rather than live ones.
        if (q.indexOf('prefers-reduced-motion') !== -1) {
          var forcedMatches = q.indexOf('no-preference') !== -1 ? false : true;
          var mql = origMatchMedia(query);
          return {
            matches: forcedMatches,
            media: mql.media,
            onchange: null,
            addEventListener: function () {},
            removeEventListener: function () {},
            addListener: function () {},
            removeListener: function () {},
            dispatchEvent: function () { return false; },
          };
        }
        return origMatchMedia(query);
      };
    }

    // Belt-and-braces: freeze CSS animations/transitions/scroll-behavior so
    // reveal scripts that don't check matchMedia still can't rewrite the DOM
    // mid-scan/match.
    if (!document.getElementById('i18n-studio-freeze')) {
      var style = document.createElement('style');
      style.id = 'i18n-studio-freeze';
      style.textContent = '*{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
      document.documentElement.appendChild(style);
    }
  }
  window.__i18nApplyFreeze = applyFreeze;

  if (sessionStorage.getItem('i18n-studio:mode')) {
    window.__i18nPreActive = true;
    applyFreeze();
  }
} catch (e) {
  // never throw — this script must not break the host page.
}
