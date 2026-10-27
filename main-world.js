// Dia Peek — page-world shim.
// Many web apps (Feishu/Lark Base cells, dashboards, SPAs) open links with
// window.open() from a click handler instead of a real <a>. Right after a
// modifier-click, route such calls to the peek instead of a new window.
// The isolated content script announces the modifier-click (diapeek:intent) and
// independently checks it was a real user gesture before showing anything.
(() => {
  // Re-injected after an extension update: the shim already in place still works.
  if (window.__diaPeekShim) return;
  window.__diaPeekShim = true;
  const nativeOpen = window.open;
  if (typeof nativeOpen !== 'function') return;

  const INTENT_MS = 1500;
  let intentAt = -Infinity;
  document.addEventListener('diapeek:intent', () => { intentAt = performance.now(); }, true);

  const request = (url) => document.dispatchEvent(new CustomEvent('diapeek:open', { detail: String(url) }));

  // Sized windows are real popups (OAuth, payments) and are left alone.
  const isPlainNavigation = (features) => !features || !/\b(width|height|left|top|popup)\b/i.test(String(features));

  // Stand-in for the WindowProxy window.open would have returned. Covers the common
  // "open a blank window, then assign its location" pattern.
  function makeStub(pending) {
    let done = !pending;
    const fire = (v) => {
      if (done || !v) return;
      done = true;
      try { request(new URL(String(v), location.href).href); } catch {}
    };
    const loc = { set href(v) { fire(v); }, get href() { return ''; }, assign: fire, replace: fire, toString: () => '' };
    return {
      get location() { return loc; },
      set location(v) { fire(typeof v === 'string' ? v : v?.href); },
      closed: false, opener: window, document: null,
      focus() {}, blur() {}, postMessage() {}, close() { this.closed = true; },
    };
  }

  window.open = function (url, target, features) {
    try {
      const t = target == null ? '' : String(target);
      if (performance.now() - intentAt < INTENT_MS && isPlainNavigation(features) &&
          !['_self', '_parent', '_top'].includes(t)) {
        intentAt = -Infinity;
        const raw = url == null ? '' : String(url);
        if (!raw || raw === 'about:blank') return makeStub(true);
        const abs = new URL(raw, location.href);
        if (abs.protocol === 'http:' || abs.protocol === 'https:') {
          request(abs.href);
          return makeStub(false);
        }
      }
    } catch { /* fall through to the real thing */ }
    return nativeOpen.apply(this, arguments);
  };
  try { window.open.toString = () => nativeOpen.toString(); } catch {}
})();
