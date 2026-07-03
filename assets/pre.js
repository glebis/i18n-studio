// assets/pre.js — i18n Studio pre-boot script. Injected right after <head> so it
// runs synchronously BEFORE any site scripts. Classic script (no import/export):
// must be loadable via a plain <script src> tag. Never throws.
try {
  if (sessionStorage.getItem('i18n-studio:mode')) {
    window.__i18nPreActive = true;

    // Signal prefers-reduced-motion: true so scroll-reveal / animation libraries
    // that check matchMedia at runtime skip their word-wrapping DOM rewrites.
    var origMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : null;
    if (origMatchMedia) {
      window.matchMedia = function (query) {
        var mql = origMatchMedia(query);
        if (String(query).indexOf('prefers-reduced-motion') !== -1) {
          return {
            matches: true,
            media: mql.media,
            onchange: null,
            addEventListener: function () {},
            removeEventListener: function () {},
            addListener: function () {},
            removeListener: function () {},
            dispatchEvent: function () { return false; },
          };
        }
        return mql;
      };
    }

    // Belt-and-braces: freeze CSS animations/transitions/scroll-behavior so
    // reveal scripts that don't check matchMedia still can't rewrite the DOM
    // mid-scan/match.
    var style = document.createElement('style');
    style.textContent = '*{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
    document.documentElement.appendChild(style);
  }
} catch (e) {
  // never throw — this script must not break the host page.
}
