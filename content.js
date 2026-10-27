// Dia Peek — Shift+click a link to preview it in a floating panel over the page.
// Runs in every frame:
//   top frame        → owns the overlay
//   the peek iframe  → stays silent until the top frame greets it with a token, then
//                      reports URL/title and forwards shortcuts (Esc, ⌘↩, ⌘[ …)
//   any frame        → relays modifier-clicks to the top frame through the background
(() => {
  // A copy left behind by an earlier version of the extension stays in the page but is
  // cut off from it (chrome.runtime.id goes away), so only a live copy blocks this one.
  if (window.__diaPeekAlive?.()) return;
  window.__diaPeekAlive = () => Boolean(chrome.runtime?.id);

  const isTop = window === window.top;

  const settings = { enabled: true, modifier: 'shift' };
  chrome.storage.sync.get(settings).then((v) => Object.assign(settings, v)).catch(() => {});
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, { newValue }] of Object.entries(changes)) if (k in settings) settings[k] = newValue;
  });

  const extensionAlive = () => Boolean(chrome.runtime?.id);

  // Dia's renderer crashes (an assertion on the compositor thread) when a YouTube page
  // hosts a same-origin YouTube video page, with or without this extension. No iframe
  // variant survives: an opaque-origin frame leaves YouTube's app unable to start, and
  // the embed player refuses to run under youtube.com. So on YouTube, video links peek
  // in a popup window instead: a real top-level page, signed in, over a blurred page.
  const YOUTUBE = /(^|\.)(youtube\.com|youtu\.be)$/;
  const onYouTube = YOUTUBE.test(location.hostname);

  function youtubeVideoId(u) {
    if (u.hostname === 'youtu.be') return u.pathname.split('/')[1] || null;
    if (!YOUTUBE.test(u.hostname)) return null;
    if (u.pathname === '/watch') return u.searchParams.get('v');
    return u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/)?.[1] ?? null;
  }

  function needsWindow(href) {
    try { return onYouTube && Boolean(youtubeVideoId(new URL(href))); } catch { return false; }
  }
  const send = (msg) => { if (extensionAlive()) chrome.runtime.sendMessage(msg).catch(() => {}); };

  function matchesModifier(e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey) return false;
    return settings.modifier === 'alt' ? e.altKey && !e.shiftKey : e.shiftKey && !e.altKey;
  }

  function findLink(path) {
    for (const el of path) {
      if (el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement || el instanceof SVGAElement) return el;
    }
    return null;
  }

  function peekableUrl(link) {
    const raw = link instanceof SVGAElement ? link.href.baseVal : link.getAttribute('href');
    if (!raw || link.hasAttribute('download')) return null;
    let url;
    try { url = new URL(raw, document.baseURI); } catch { return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Links into the current document (including the common href="#" button) keep
    // their normal behaviour.
    if (url.href.split('#')[0] === location.href.split('#')[0]) return null;
    return url.href;
  }

  // A real modifier-click, remembered briefly. Apps that open links from script
  // (window.open, or a synthetic click on a temporary <a>) do so right after one.
  const INTENT_MS = 1500;
  let intent = null;
  const intentFresh = () => intent !== null && performance.now() - intent.at < INTENT_MS;

  function noteIntent(e) {
    if (!e.isTrusted || !settings.enabled || !matchesModifier(e) || !extensionAlive()) return;
    intent = { at: performance.now(), x: e.clientX, y: e.clientY };
    document.dispatchEvent(new CustomEvent('diapeek:intent')); // tells main-world.js
  }
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) addEventListener(type, noteIntent, true);

  function showFromIntent(url) {
    const { x, y } = intent;
    intent = null;
    if (isTop) openPeek(url, x, y);
    else send({ type: 'peek:relay', url });
  }

  // window.open() calls swallowed by main-world.js. Only honoured right after a real
  // modifier-click, so a page can't summon a peek (and its header rule) on its own.
  document.addEventListener('diapeek:open', (e) => {
    if (!intentFresh() || typeof e.detail !== 'string' || !/^https?:/.test(e.detail)) return;
    showFromIntent(e.detail);
  });

  function linkFromEvent(e) {
    if (!settings.enabled || !extensionAlive()) return null;
    const scripted = !e.isTrusted && intentFresh();
    if (!scripted && !matchesModifier(e)) return null;
    const link = findLink(e.composedPath());
    return link && peekableUrl(link);
  }

  // The header rule has to exist before the frame request goes out; asking for it at
  // mousedown means it is almost always in place by the time the click lands.
  let armTimer = 0;
  addEventListener('mousedown', (e) => {
    if (!linkFromEvent(e)) return;
    e.preventDefault(); // Shift+mousedown would otherwise start a text selection.
    if (isTop && !peek) {
      send({ type: 'peek:open' });
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { if (!peek) send({ type: 'peek:close' }); }, 3000);
    }
  }, true);

  addEventListener('click', (e) => {
    const url = linkFromEvent(e);
    if (!url) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!e.isTrusted) { showFromIntent(url); return; }
    intent = null;
    if (isTop) openPeek(url, e.clientX, e.clientY);
    else send({ type: 'peek:relay', url });
  }, true);

  // For the "peek the link under the cursor" shortcut and the context menu.
  let hovered = null;
  addEventListener('mouseover', (e) => { hovered = findLink(e.composedPath()); }, true);
  let lastPointer = null;
  addEventListener('contextmenu', (e) => { lastPointer = [e.clientX, e.clientY]; }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'peek:hovered') {
      const url = hovered?.isConnected && hovered.matches(':hover') && peekableUrl(hovered);
      if (!url) return;
      if (isTop) {
        const r = hovered.getBoundingClientRect();
        openPeek(url, r.left + r.width / 2, r.top + r.height / 2);
      } else {
        send({ type: 'peek:relay', url });
      }
    } else if (isTop && msg.type === 'peek:show') {
      const [x, y] = msg.fromMenu && lastPointer ? lastPointer : [];
      openPeek(msg.url, x, y);
    } else if (isTop && msg.type === 'peek:window-closed') {
      closeWindowBackdrop();
    }
  });

  if (!isTop) {
    if (window.parent === window.top) setupChildBridge();
    return;
  }

  // ---------------------------------------------------------------- window peek (YouTube videos)

  // This page may itself be a window peek. Only the background knows, so ask on the
  // first Esc or ⌘↩ and remember the answer for the life of the page.
  let isWindowPeek = null;
  addEventListener('keydown', async (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const close = e.key === 'Escape' && !e.defaultPrevented && !document.fullscreenElement;
    const promote = mod && e.key === 'Enter';
    if (!(close || promote) || peek || isWindowPeek === false || !extensionAlive()) return;
    if (promote) e.preventDefault(); // decided before the await, while the event is live
    isWindowPeek ??= await chrome.runtime.sendMessage({ type: 'peek:is-window' }).catch(() => false);
    if (!isWindowPeek) return;
    if (close) { send({ type: 'peek:window-close' }); return; }
    // Carry the playback position over to the tab.
    const url = new URL(location.href);
    const t = Math.floor(document.querySelector('video')?.currentTime || 0);
    if (t > 0 && youtubeVideoId(url)) url.searchParams.set('t', `${t}s`);
    send({ type: 'peek:window-promote', url: url.href });
  });

  let windowBackdrop = null;

  function openWindowPeek(url) {
    closeWindowBackdrop();
    const host = document.createElement('dia-peek');
    host.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${STYLE}</style><div class="backdrop"></div>`;
    document.documentElement.appendChild(host);
    const backdrop = root.querySelector('.backdrop');
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 110 });
    backdrop.addEventListener('click', () => send({ type: 'peek:window-close' }));
    windowBackdrop = host;

    // Put the window where the in-page panel would have been, in screen coordinates.
    // Dia's sidebar and toolbar sit left of and above the page.
    const narrow = innerWidth <= 720;
    const side = narrow ? 12 : Math.max(56, (innerWidth - 1240) / 2);
    const vert = narrow ? 12 : 40;
    send({
      type: 'peek:window',
      url,
      bounds: {
        left: Math.round(screenX + outerWidth - innerWidth + side),
        top: Math.round(screenY + outerHeight - innerHeight + vert),
        width: Math.round(innerWidth - 2 * side),
        height: Math.round(innerHeight - 2 * vert),
      },
    });
  }

  function closeWindowBackdrop() {
    if (!windowBackdrop) return;
    const host = windowBackdrop;
    windowBackdrop = null;
    host.remove();
  }

  // ---------------------------------------------------------------- peek iframe side

  function setupChildBridge() {
    let token = null, verifying = false;

    const tell = (kind, extra) =>
      window.parent.postMessage({ __diaPeek: 'child', token, kind, ...extra }, '*');

    let lastSig = '';
    const report = () => {
      if (!/^https?:$/.test(location.protocol)) return;
      const sig = location.href + '\n' + document.title;
      if (sig === lastSig) return;
      lastSig = sig;
      tell('state', { href: location.href, title: document.title });
    };

    function activate() {
      document.addEventListener('readystatechange', report);
      addEventListener('load', report);
      addEventListener('hashchange', report);
      addEventListener('popstate', report);
      window.navigation?.addEventListener('navigatesuccess', report);
      setInterval(report, 1000); // titles and SPA routes that change quietly

      // Frame navigations would otherwise land in the tab's own session history, and
      // Back on the host page would then step through a peek that no longer exists.
      // Turn each one into a replace; the overlay keeps the peek's history itself.
      window.navigation?.addEventListener('navigate', (e) => {
        if (e.navigationType !== 'push' || e.destination.sameDocument || e.formData ||
            e.downloadRequest !== null || !e.cancelable) return;
        e.preventDefault();
        location.replace(e.destination.url);
      });

      // YouTube moves between pages in script, so a video opened from inside a YouTube
      // peek would mount the player right here. Let the overlay decide where it goes
      // (see needsWindow).
      if (onYouTube) {
        addEventListener('click', (e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          const link = findLink(e.composedPath());
          if (!(link instanceof HTMLAnchorElement) || !youtubeVideoId(new URL(link.href))) return;
          e.preventDefault();
          e.stopImmediatePropagation();
          tell('open', { href: link.href });
        }, true);
      }

      addEventListener('keydown', (e) => {
        const mod = e.metaKey || e.ctrlKey;
        let kind = null;
        if (e.key === 'Escape' && !e.defaultPrevented) kind = 'close';
        else if (mod && e.key === 'Enter') kind = 'promote';
        else if (mod && e.key === '[') kind = 'back';
        else if (mod && e.key === ']') kind = 'forward';
        else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') {
          // The peeked page holds focus, so it is the one allowed to write the clipboard.
          navigator.clipboard.writeText(location.href).then(() => tell('copied'), () => {});
          e.preventDefault();
          return;
        }
        if (!kind) return;
        if (kind !== 'close') e.preventDefault();
        tell(kind);
      });
    }

    addEventListener('message', (e) => {
      if (e.source !== window.parent || e.data?.__diaPeek !== 'host' || typeof e.data.token !== 'string') return;
      if (token === null) {
        // Any page can post to its own iframes, so the background confirms this
        // token belongs to a peek before the frame says anything about itself.
        if (verifying || !extensionAlive()) return;
        verifying = true;
        const candidate = e.data.token;
        chrome.runtime.sendMessage({ type: 'peek:verify', token: candidate }).then((ok) => {
          if (ok && token === null) { token = candidate; activate(); report(); }
        }, () => {}).finally(() => { verifying = false; });
        return;
      }
      if (e.data.token !== token) return;
      const { action, url } = e.data;
      if (action === 'init') { lastSig = ''; report(); }
      else if (action === 'go' && /^https?:/.test(url)) location.replace(url);
    });
  }

  // ---------------------------------------------------------------- overlay (top frame)

  let peek = null;

  const ICONS = {
    reload: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>',
    copy: '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.6.6M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.6-.6"/>',
    open: '<path d="M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
    close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  };
  const icon = (name) =>
    `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

  const STYLE = `
    :host {
      all: initial;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
      --bg: #fff; --bar: #f5f5f7; --line: rgba(0,0,0,.08); --fg: #1d1d1f; --muted: #6e6e73;
      --hover: rgba(0,0,0,.06); --accent: #4f7cff; --chip: rgba(28,28,30,.92); --chip-fg: #fff;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #1e1e21; --bar: #29292d; --line: rgba(255,255,255,.08); --fg: #f2f2f4; --muted: #a1a1a8;
        --hover: rgba(255,255,255,.08); --chip: rgba(245,245,247,.94); --chip-fg: #1d1d1f;
      }
    }
    /* A modal <dialog> sits in the top layer: above anything the page can stack,
       and the page behind it becomes inert. */
    dialog {
      position: fixed; inset: 0; width: 100vw; height: 100vh; max-width: none; max-height: none;
      margin: 0; padding: 0; border: 0; background: transparent; overflow: hidden; outline: none;
    }
    dialog::backdrop { background: transparent; }
    .backdrop {
      position: absolute; inset: 0; background: rgba(10,10,14,.24);
      backdrop-filter: blur(8px) saturate(1.15); -webkit-backdrop-filter: blur(8px) saturate(1.15);
    }
    .panel {
      position: absolute; inset: 40px max(56px, calc((100vw - 1240px) / 2));
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--bg); border-radius: 14px;
      box-shadow: 0 0 0 .5px rgba(0,0,0,.2), 0 24px 80px rgba(0,0,0,.35), 0 4px 16px rgba(0,0,0,.18);
    }
    @media (max-width: 720px) { .panel { inset: 12px; border-radius: 12px; } }
    .bar {
      flex: none; height: 40px; display: flex; align-items: center; gap: 2px;
      padding: 0 6px 0 14px; background: var(--bar); border-bottom: 1px solid var(--line);
    }
    .site { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; white-space: nowrap; overflow: hidden; }
    .host { color: var(--fg); font-weight: 600; flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
    .title { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
    button {
      all: unset; box-sizing: border-box; width: 28px; height: 28px; flex: none;
      display: grid; place-items: center; border-radius: 7px; color: var(--muted);
    }
    button:hover { background: var(--hover); color: var(--fg); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .body { position: relative; flex: 1; background: #fff; }
    iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
    .progress { position: absolute; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; z-index: 1; }
    .progress::after {
      content: ""; position: absolute; top: 0; bottom: 0; width: 30%; background: var(--accent);
      animation: slide 1.1s ease-in-out infinite;
    }
    .loaded .progress { display: none; }
    @keyframes slide { from { left: -30%; } to { left: 100%; } }
    .chip {
      position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%);
      display: none; align-items: center; gap: 10px; padding: 6px 6px 6px 14px; border-radius: 999px;
      background: var(--chip); color: var(--chip-fg); box-shadow: 0 6px 24px rgba(0,0,0,.25); white-space: nowrap;
    }
    .chip.show { display: flex; }
    .chip button { width: auto; height: 26px; padding: 0 12px; border-radius: 999px; background: var(--accent); color: #fff; font-weight: 600; }
    .chip button:hover { filter: brightness(1.08); }
    .toast { padding: 6px 14px; pointer-events: none; }
  `;

  // Everything a normal document can do except navigate the top frame, so a
  // frame-busting site can't throw the whole tab somewhere else.
  const SANDBOX = 'allow-same-origin allow-scripts allow-forms allow-modals allow-popups ' +
    'allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation ' +
    'allow-orientation-lock allow-storage-access-by-user-activation';


  function openPeek(url, x, y) {
    if (needsWindow(url)) {
      if (peek) peek.close({ animate: false });
      openWindowPeek(url);
      return;
    }
    if (peek) { peek.navigate(url); return; }
    clearTimeout(armTimer);

    const host = document.createElement('dia-peek');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${STYLE}</style>
      <dialog aria-label="链接预览">
        <div class="backdrop"></div>
        <div class="panel">
          <div class="bar">
            <div class="site"><span class="host"></span><span class="title"></span></div>
            <button data-act="reload" title="重新加载">${icon('reload')}</button>
            <button data-act="copy" title="复制链接 (⌘⇧C)">${icon('copy')}</button>
            <button data-act="open" title="在新标签页打开 (⌘↩)">${icon('open')}</button>
            <button data-act="close" title="关闭 (Esc)">${icon('close')}</button>
          </div>
          <div class="body">
            <div class="progress"></div>
            <iframe sandbox="${SANDBOX}" allow="clipboard-write; fullscreen; autoplay; encrypted-media; picture-in-picture"></iframe>
            <div class="chip hint"><span>预览没有显示出来？</span><button data-act="open">在新标签页打开</button></div>
            <div class="chip toast">已复制链接</div>
          </div>
        </div>
      </dialog>`;

    const $ = (sel) => root.querySelector(sel);
    const dialog = $('dialog'), panel = $('.panel'), backdrop = $('.backdrop'), body = $('.body');
    const iframe = $('iframe'), hint = $('.hint'), toast = $('.toast');
    const token = crypto.randomUUID();
    let currentUrl = url, reported = false;
    let hintTimer = 0, backstopTimer = 0, greetTimer = 0;

    // The peek keeps its own history, rebuilt from what the frame reports, so ⌘[ can
    // step back inside it and dismiss once there is nothing left to go back to.
    let entries = [], idx = -1, navIntent = null;

    function recordNav(href) {
      if (entries[idx] === href) return;
      if (navIntent === 'back' && entries[idx - 1] === href) idx--;
      else if (navIntent === 'forward' && entries[idx + 1] === href) idx++;
      else { entries = entries.slice(0, idx + 1); entries.push(href); idx = entries.length - 1; }
      navIntent = null;
    }

    function setLocation(href, title) {
      currentUrl = href;
      let hostname = href;
      try { hostname = new URL(href).hostname.replace(/^www\./, ''); } catch {}
      $('.host').textContent = hostname;
      $('.title').textContent = title || '';
    }

    function showHint() { if (!reported) hint.classList.add('show'); }

    function navigate(href) {
      setLocation(href, '');
      reported = false;
      hint.classList.remove('show');
      body.classList.remove('loaded');
      clearTimeout(hintTimer);
      clearTimeout(backstopTimer);
      // Sites that refuse framing in script rather than headers may never fire load.
      backstopTimer = setTimeout(showHint, 10000);
      // The first load replaces the initial about:blank; later ones (reload, a second
      // Shift+click) must replace too, or they'd add entries to the tab's history.
      if (iframe.getAttribute('src')) iframe.contentWindow.location.replace(href);
      else iframe.src = href;
    }


    const toChild = (action, extra) =>
      iframe.contentWindow?.postMessage({ __diaPeek: 'host', token, action, ...extra }, '*');

    iframe.addEventListener('load', () => {
      // The fresh iframe fires load for its initial about:blank before src is set.
      if (!iframe.getAttribute('src')) return;
      body.classList.add('loaded');
      reported = false;
      // Every committed document is a new child that has to be greeted again.
      let tries = 0;
      clearInterval(greetTimer);
      toChild('init');
      greetTimer = setInterval(() => {
        if (reported || ++tries > 15) clearInterval(greetTimer);
        else toChild('init');
      }, 50);
      // No answer after a committed load almost always means Chrome's "refused to
      // connect" page (or a page extensions can't run in, e.g. a PDF).
      clearTimeout(hintTimer);
      hintTimer = setTimeout(showHint, 1200);
    });

    function back() {
      if (idx <= 0) { close(); return; }
      navIntent = 'back';
      toChild('go', { url: entries[idx - 1] });
    }
    function forward() {
      if (idx >= entries.length - 1) return;
      navIntent = 'forward';
      toChild('go', { url: entries[idx + 1] });
    }

    function onMessage(e) {
      if (e.source !== iframe.contentWindow || e.data?.__diaPeek !== 'child' || e.data.token !== token) return;
      switch (e.data.kind) {
        case 'state': {
          reported = true;
          clearTimeout(backstopTimer);
          hint.classList.remove('show');
          body.classList.add('loaded');
          const href = String(e.data.href);
          // A video reached some way the click guard didn't catch: leave the frame now.
          if (needsWindow(href)) { close({ animate: false }); openWindowPeek(href); break; }
          setLocation(href, String(e.data.title || ''));
          recordNav(currentUrl);
          break;
        }
        case 'open': {
          const href = String(e.data.href);
          if (!/^https?:/.test(href)) break;
          if (needsWindow(href)) { close({ animate: false }); openWindowPeek(href); } else navigate(href);
          break;
        }
        case 'close': close(); break;
        case 'promote': promote(); break;
        case 'back': back(); break;
        case 'forward': forward(); break;
        case 'copied': flashToast(); break;
      }
    }

    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey;
      let handled = true;
      if (e.key === 'Escape') close();
      else if (mod && e.key === 'Enter') promote();
      else if (mod && e.key === '[') back();
      else if (mod && e.key === ']') forward();
      else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') copy();
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }

    let toastTimer = 0;
    function flashToast() {
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
    }

    async function copy() {
      try { await navigator.clipboard.writeText(currentUrl); } catch {
        const ta = document.createElement('textarea');
        ta.value = currentUrl;
        dialog.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      }
      flashToast();
    }

    function promote() {
      send({ type: 'peek:promote', url: currentUrl });
      close({ animate: false, revoke: false });
    }

    root.addEventListener('click', (e) => {
      const act = e.target.closest?.('[data-act]')?.dataset.act;
      if (act === 'close') close();
      else if (act === 'reload') navigate(currentUrl);
      else if (act === 'copy') copy();
      else if (act === 'open') promote();
    });
    backdrop.addEventListener('click', () => close());
    // Esc while focus is in the overlay (not the frame) arrives as the dialog's cancel.
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

    const prevFocus = document.activeElement;
    // Lock scrolling behind the peek. Where the page shows a classic scrollbar (e.g. a
    // Mac with a mouse attached), keep its space reserved; otherwise the page would
    // widen when the scrollbar goes and look like it was resizing behind the backdrop.
    const rootStyle = document.documentElement.style;
    const prevOverflow = rootStyle.overflow, prevGutter = rootStyle.scrollbarGutter;
    if (innerWidth > document.documentElement.clientWidth) rootStyle.scrollbarGutter = 'stable';
    rootStyle.overflow = 'hidden';
    addEventListener('keydown', onKey, true);
    addEventListener('message', onMessage);
    addEventListener('pagehide', onPageHide);
    // documentElement, not body: pages often transform <body>, which would trap a
    // fixed-position child in the wrong containing block.
    document.documentElement.appendChild(host);
    dialog.showModal();

    // Grow out of the point that was clicked.
    const rect = panel.getBoundingClientRect();
    const ox = (x ?? rect.left + rect.width / 2) - rect.left;
    const oy = (y ?? rect.top + rect.height / 2) - rect.top;
    panel.style.transformOrigin = `${ox}px ${oy}px`;
    panel.animate(
      [{ transform: 'scale(.55)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }],
      { duration: 280, easing: 'cubic-bezier(.2,.9,.25,1.05)' });
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 110 });

    setLocation(url, '');
    // Framing headers are stripped only once the background has installed its rule.
    const armed = extensionAlive() ? chrome.runtime.sendMessage({ type: 'peek:open', token }) : Promise.resolve();
    armed.catch(() => {}).finally(() => { if (peek?.host === host) { navigate(url); iframe.focus(); } });

    function onPageHide() { close({ animate: false }); }

    function close({ animate = true, revoke = true } = {}) {
      if (peek?.host !== host) return;
      peek = null;
      clearTimeout(hintTimer);
      clearTimeout(backstopTimer);
      clearInterval(greetTimer);
      removeEventListener('keydown', onKey, true);
      removeEventListener('message', onMessage);
      removeEventListener('pagehide', onPageHide);
      rootStyle.overflow = prevOverflow;
      rootStyle.scrollbarGutter = prevGutter;
      if (revoke) send({ type: 'peek:close' });
      const finish = () => {
        dialog.close();
        host.remove();
        if (prevFocus instanceof HTMLElement) prevFocus.focus({ preventScroll: true });
      };
      if (!animate) { finish(); return; }
      backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 90, fill: 'forwards' });
      panel.animate(
        [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.92)', opacity: 0 }],
        { duration: 160, easing: 'ease-in', fill: 'forwards' }).finished.then(finish);
    }

    peek = { host, navigate, close };
  }
})();
