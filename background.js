// While a peek is open in a tab, strip the headers that forbid framing
// (X-Frame-Options, CSP frame-ancestors) for sub-frames of that tab only.
// The rule id is the tab id, so each tab has at most one rule.

async function allowFraming(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
        ],
      },
      condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] },
    }],
  });
}

function revokeFraming(tabId) {
  chrome.storage.session.remove(`token:${tabId}`);
  return chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] });
}

// Each open peek has a random token. The peeked frame only starts reporting its URL
// once the token it was greeted with checks out here, so an ordinary page can't make
// its own iframes talk by imitating the overlay. Kept in session storage because the
// service worker may restart while a peek is open.
async function verifyToken(tabId, token) {
  const key = `token:${tabId}`;
  const stored = (await chrome.storage.session.get(key))[key];
  return Boolean(token) && stored === token;
}

// Window peeks (YouTube videos opened on YouTube, see content.js): popup window id →
// the tab that opened it. Kept in session storage because the worker may restart.
async function getWindowPeeks() {
  return (await chrome.storage.session.get('windowPeeks')).windowPeeks || {};
}
function setWindowPeeks(peeks) {
  return chrome.storage.session.set({ windowPeeks: peeks });
}

async function openWindowPeek(tab, url, bounds) {
  await closeWindowPeeksOf(tab.id);
  const int = (v, min) => Math.max(min, Math.round(Number(v) || 0));
  const base = { url, type: 'popup', focused: true };
  const size = { width: int(bounds?.width, 480), height: int(bounds?.height, 360) };
  const position = { left: int(bounds?.left, 0), top: int(bounds?.top, 0) };
  // Chrome refuses bounds that are mostly off-screen (a window straddling two
  // displays, say); then let it place the window itself.
  let win;
  for (const attempt of [{ ...base, ...size, ...position }, { ...base, ...size }, base]) {
    try { win = await chrome.windows.create(attempt); break; } catch (err) { if (attempt === base) throw err; }
  }
  const peeks = await getWindowPeeks();
  peeks[win.id] = { tabId: tab.id, windowId: tab.windowId };
  await setWindowPeeks(peeks);
}

async function closeWindowPeeksOf(tabId) {
  const peeks = await getWindowPeeks();
  await Promise.all(Object.entries(peeks)
    .filter(([, p]) => p.tabId === tabId)
    .map(([id]) => chrome.windows.remove(Number(id)).catch(() => {})));
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  const peeks = await getWindowPeeks();
  const peek = peeks[windowId];
  if (!peek) return;
  delete peeks[windowId];
  await setWindowPeeks(peeks);
  chrome.tabs.sendMessage(peek.tabId, { type: 'peek:window-closed' }, { frameId: 0 }).catch(() => {});
});

// Like the in-page peek, a window peek goes away once you click back into the page
// (or any other Dia window). Focus moving to another app leaves it alone.
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const peeks = await getWindowPeeks();
  for (const id of Object.keys(peeks)) {
    if (Number(id) !== windowId) chrome.windows.remove(Number(id)).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tab = sender.tab;
  if (!tab) return;
  switch (msg.type) {
    case 'peek:open': {
      const saveToken = msg.token ? chrome.storage.session.set({ [`token:${tab.id}`]: msg.token }) : null;
      Promise.all([allowFraming(tab.id), saveToken])
        .then(() => sendResponse({ ok: true }), (err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }
    case 'peek:close':
      revokeFraming(tab.id).finally(() => sendResponse({ ok: true }));
      return true;
    case 'peek:verify':
      verifyToken(tab.id, msg.token).then(sendResponse, () => sendResponse(false));
      return true;
    case 'peek:relay':
      // A modifier-click inside a sub-frame: let the top frame show the peek.
      chrome.tabs.sendMessage(tab.id, { type: 'peek:show', url: msg.url }, { frameId: 0 }).catch(() => {});
      break;
    case 'peek:window':
      if (/^https?:/.test(msg.url || '')) openWindowPeek(tab, msg.url, msg.bounds).catch(() => {});
      break;
    case 'peek:is-window':
      getWindowPeeks().then((peeks) => sendResponse(Boolean(peeks[tab.windowId])), () => sendResponse(false));
      return true;
    case 'peek:window-close':
      // From the peek window itself, or from the backdrop on the page that opened it.
      getWindowPeeks().then((peeks) => {
        if (peeks[tab.windowId]) chrome.windows.remove(tab.windowId).catch(() => {});
        else closeWindowPeeksOf(tab.id);
      });
      break;
    case 'peek:window-promote':
      // Popup tabs can't be moved into a normal window, so reopen the page as a tab
      // next to the one that opened the peek, then drop the window.
      getWindowPeeks().then(async (peeks) => {
        const peek = peeks[tab.windowId];
        if (!peek || !/^https?:/.test(msg.url || '')) return;
        const opener = await chrome.tabs.get(peek.tabId).catch(() => null);
        await chrome.tabs.create({
          url: msg.url, windowId: peek.windowId, openerTabId: opener?.id,
          index: opener ? opener.index + 1 : undefined,
        });
        await chrome.windows.update(peek.windowId, { focused: true }).catch(() => {});
        chrome.windows.remove(tab.windowId).catch(() => {});
      });
      break;
    case 'peek:promote':
      chrome.tabs.create({ url: msg.url, index: tab.index + 1, openerTabId: tab.id, windowId: tab.windowId });
      revokeFraming(tab.id);
      break;
  }
});

// Fallbacks for sites that swallow Shift+click themselves.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'peek-link', title: '在 Peek 中预览', contexts: ['link'] });
  });
  attachToOpenTabs();
});

// Tabs opened before an install or update only have the old, disconnected content
// script, so Shift+click there would silently fall back to a new window until the
// page is reloaded. Inject the current scripts instead.
async function attachToOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(tabs.map(async (tab) => {
    const target = { tabId: tab.id, allFrames: true };
    try {
      await chrome.scripting.executeScript({ target, files: ['main-world.js'], world: 'MAIN' });
      await chrome.scripting.executeScript({ target, files: ['content.js'] });
    } catch {} // pages extensions may not touch (e.g. the Chrome Web Store)
  }));
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'peek-link' || !tab?.id || !/^https?:/.test(info.linkUrl || '')) return;
  chrome.tabs.sendMessage(tab.id, { type: 'peek:show', url: info.linkUrl, fromMenu: info.frameId === 0 }, { frameId: 0 })
    .catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  // Every frame checks whether the cursor is over one of its links.
  if (command === 'peek-hovered-link' && tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'peek:hovered' }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => { revokeFraming(tabId); closeWindowPeeksOf(tabId); });

// Session rules survive service-worker restarts; drop leftovers on browser start.
chrome.runtime.onStartup.addListener(async () => {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map((r) => r.id) });
});
