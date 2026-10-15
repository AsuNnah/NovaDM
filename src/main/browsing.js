'use strict';
// Everyday-browser features around the tab manager: history, bookmarks (+ bar), find in page,
// restoring tabs, address-bar suggestions, reader view, unloading idle tabs, the size of NovaDM's
// own screens, Shields rules and "clear when NovaDM closes".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, WebContentsView, Menu, dialog, nativeImage } = require('electron');
const diagnostics = require('./diagnostics');
const { underPressure, appMemoryBytes, cleanLeftovers } = require('./housekeeping');
const { History, Bookmarks, TabSession } = require('./library');
const bookmarkImport = require('./bookmarks-import');
const { Shields } = require('./shields');
const { COLORS, COLOR_HEX } = require('./tab-groups');

const UI_DIR = path.join(__dirname, '..', 'ui');
const UI_PRELOAD = path.join(UI_DIR, 'preload-ui.js');
const BASE_CHROME = 88; // tab strip + toolbar
const BAR_HEIGHT = 32; // bookmarks bar
const FIND_W = 400;
const FIND_H = 52;

function setupBrowsing({ settings, browser, net, userDataDir, sendUI, setPanel, getWindow, relayout, restack }) {
  const history = new History(userDataDir);
  const bookmarks = new Bookmarks(userDataDir);
  const tabSession = new TabSession(userDataDir);
  const shields = new Shields(settings);
  browser.shields = shields;
  browser.isBookmarked = (url) => !!url && bookmarks.has(url);

  // The current window's find bar; each window has its own (main.js switches with useFind).
  let find = { view: null, open: false };
  const readerPages = new Map(); // id -> { article, url }
  let readerSeq = 0;

  const scale = () => Math.max(0.75, Math.min(2, (Number(settings.get('uiScale')) || 100) / 100));
  const barVisible = () => settings.get('showBookmarksBar') !== false && bookmarks.items.length > 0;
  const chromeHeight = () => Math.round((BASE_CHROME + (barVisible() ? BAR_HEIGHT : 0)) * scale());

  // ---- history ----
  browser.on('visit', (tab, url) => { history.add(url, tab.title); saveSession(); });
  browser.on('title', (tab, title) => { if (tab.wc && !tab.wc.isDestroyed()) history.setTitle(tab.wc.getURL(), title); });

  // ---- restore tabs ----
  // Every normal window (private windows are never kept), the main one first, with its place on screen.
  function saveSession() {
    if (browser.shuttingDown || settings.get('restoreTabs') === false) return;
    const keys = browser.normalWindows().sort((a, b) => (a === 'normal' ? -1 : b === 'normal' ? 1 : 0));
    if (keys.some((k) => browser.groups[k].closing)) return;
    const windows = keys.map((k) => {
      const { order, activeId, tabGroups } = browser.groups[k];
      const tabs = order.map((id) => browser.tabs.get(id)).filter((t) => t && !t.incognito && /^(https?|novadm):/i.test(t.url || ''));
      const groups = [...tabGroups.values()].filter((g) => tabs.some((t) => t.groupId === g.id));
      return { tabs, groups, active: Math.max(0, tabs.findIndex((t) => t.id === activeId)), bounds: browser.windowBounds ? browser.windowBounds(k) : null };
    }).filter((w) => w.tabs.length);
    if (windows.length) tabSession.save(windows);
  }
  browser.on('tabs', (_tabs, _active, kind) => { if (kind !== 'private') saveSession(); });
  let placeTimer = null; // moving or resizing a window: saved once it has stopped
  browser.on('windows-changed', () => { clearTimeout(placeTimer); placeTimer = setTimeout(saveSession, 500); });

  /** First tabs at start-up: the saved ones (only the active one loads right away), or a new tab. */
  function openStartTabs(openUrl) {
    if (openUrl) return browser.createTab({ url: openUrl });
    const s = settings.get('restoreTabs') !== false ? tabSession.load() : { windows: [] };
    if (!s.windows.length) return browser.createTab({ url: 'novadm://newtab' });
    // Every window from last time, each with its tabs, groups and place; the first is this one.
    let first = null;
    s.windows.forEach((w, i) => {
      const win = i === 0 ? 'normal' : browser.newWindow({ bounds: w.bounds, empty: true });
      if (i === 0 && browser.placeWindow) browser.placeWindow('normal', w.bounds);
      const gids = new Map(w.groups.map((g) => [g.id, browser.restoreGroup(g, win)])); // pinned tabs and groups come back too
      const ids = w.tabs.map((t) => browser.createTab({ win, url: t.url, title: t.title, background: true, lazy: true, pinned: !!t.pinned, groupId: gids.get(t.group) ?? null }));
      const active = ids[w.active] || ids[0];
      browser.selectTab(active);
      if (i === 0) first = active;
    });
    if (s.windows.length > 1 && browser.focusWindow) browser.focusWindow('normal');
    return first;
  }

  // ---- unload idle tabs ----
  setInterval(() => {
    const minutes = Number(settings.get('discardTabsAfter')) || 0;
    if (minutes > 0) browser.discardIdle(minutes);
  }, 60000).unref();

  // ---- memory overload protection: unload background tabs while memory is short ----
  const memoryCheck = () => {
    if (settings.get('memorySaver') === false) return [];
    const mem = { freeBytes: os.freemem(), totalBytes: os.totalmem(), appBytes: appMemoryBytes(app.getAppMetrics()) };
    if (!underPressure(mem)) return [];
    const ids = browser.discardForMemory(3); // a few at a time, so it never empties every window at once
    if (ids.length) diagnostics.add('note', [`memory low (${Math.round((mem.freeBytes / mem.totalBytes) * 100)}% of the PC free, NovaDM ${Math.round(mem.appBytes / 1048576)} MB): unloaded ${ids.length} background tab(s)`]);
    return ids;
  };
  setInterval(memoryCheck, 15000).unref();

  // ---- leftovers from a crash (temp folders, Chromium's half-written files) ----
  setTimeout(() => {
    const removed = cleanLeftovers({ userDataDir });
    if (removed.length) diagnostics.add('note', [`removed ${removed.length} leftover temp file(s) or folder(s)`]);
  }, 20000).unref();

  // ---- find in page ----
  /** A find bar for a window: { view, open }, made current with useFind. Its page process (about 25 MB)
   *  starts the first time Ctrl+F is used; onCreate(view) is called then. */
  function createFindView(parent, onCreate) {
    return { view: null, open: false, parent, onCreate };
  }
  function ensureFindView(f) {
    if (f.view) return;
    const view = new WebContentsView({ webPreferences: { preload: UI_PRELOAD, contextIsolation: true, sandbox: true, transparent: true } });
    view.setBackgroundColor('#00000000');
    view.webContents.loadFile(path.join(UI_DIR, 'find.html'));
    view.setVisible(false);
    f.parent.addChildView(view);
    view.webContents.on('did-finish-load', () => view.webContents.setZoomFactor(scale()));
    f.view = view;
    if (f.onCreate) f.onCreate(view);
  }
  function sendFind(name, data) { if (find.view && !find.view.webContents.isDestroyed()) find.view.webContents.send('novadm:event', name, data); }
  function findBounds(content) {
    const s = scale();
    const w = Math.min(Math.round(FIND_W * s), content.width);
    return { x: content.x + content.width - w - Math.round(12 * s), y: content.y + Math.round(6 * s), width: w, height: Math.round(FIND_H * s) };
  }
  function openFind(text) {
    const fresh = !find.view;
    ensureFindView(find);
    find.open = true;
    find.view.setVisible(true);
    relayout();
    restack();
    find.view.webContents.focus();
    const send = () => sendFind('find-open', { text: text || '' });
    if (fresh) find.view.webContents.once('did-finish-load', send); else send();
  }
  function closeFind() {
    if (!find.open) return;
    find.open = false;
    if (find.view) find.view.setVisible(false);
    browser.stopFind();
    const t = browser.activeTab();
    if (t && t.wc) t.wc.focus();
  }
  browser.on('found', (tab, r) => { if (tab.id === browser.activeId && r) sendFind('find-result', { active: r.activeMatchOrdinal || 0, matches: r.matches || 0 }); });
  browser.on('tab-selected', () => closeFind());

  // ---- bookmarks ----
  function bookmarkState() {
    return {
      nodes: bookmarks.nodes.map(({ id, type, url, title, parent, icon }) => ({ id, type, url: url || '', title, parent, icon: icon || '' })),
      showBar: barVisible(),
    };
  }
  function pushBookmarks() {
    sendUI('bookmarks', bookmarkState());
    for (const t of browser.internalTabs('bookmarks')) t.wc.send('novadm:internal-event', 'bookmarks', bookmarkState());
    browser.emitActive();
  }
  let lastBar = barVisible();
  bookmarks.on('changed', () => {
    pushBookmarks();
    if (barVisible() !== lastBar) { lastBar = barVisible(); relayout(); }
  });
  history.on('changed', () => {
    clearTimeout(history._push);
    history._push = setTimeout(() => { for (const t of browser.internalTabs('history')) t.wc.send('novadm:internal-event', 'history', {}); }, 800);
  });

  // The site's icon, kept with the bookmark (fetched once through the browsing session).
  async function addIcon(b, favicon) {
    if (!b || !/^https?:\/\//i.test(favicon || '')) return;
    try {
      const r = await net.fetchBuffer(favicon, { session: browser.normalSession, maxBytes: 64 * 1024, timeoutMs: 8000 });
      const type = String(r.headers['content-type'] || '').split(';')[0].trim();
      if (!/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)$/.test(type) || !r.body.length) return;
      b.icon = `data:${type};base64,${r.body.toString('base64')}`;
      bookmarks.changed();
    } catch {}
  }

  function toggleActiveBookmark() {
    const t = browser.activeTab();
    if (!t || !/^https?:/i.test(t.url || '')) return { ok: false };
    const on = bookmarks.toggle(t.url, t.title);
    if (on) addIcon(bookmarks.find(t.url), t.favicon);
    return { ok: true, bookmarked: on };
  }

  function openBookmark(b, how) {
    if (!b) return;
    if (how === 'tab') browser.createTab({ url: b.url, background: true, openerPartition: browser.activeId });
    else if (how === 'private') browser.createTab({ url: b.url, incognito: true });
    else browser.navigate(browser.activeId, b.url);
  }

  function popup(template, x, y) {
    const win = getWindow();
    if (!win) return;
    const s = scale();
    Menu.buildFromTemplate(template).popup({ window: win, x: Math.round((x || 0) * s), y: Math.round((y || 0) * s) });
  }
  // Tab-group menus: a colour square per group, and a name for groups without one.
  const swatches = new Map();
  function swatch(color) {
    if (!swatches.has(color)) {
      const hex = COLOR_HEX[color] || '#888888';
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      const px = Buffer.alloc(12 * 12 * 4);
      for (let i = 0; i < px.length; i += 4) { px[i] = b; px[i + 1] = g; px[i + 2] = r; px[i + 3] = 255; } // BGRA
      swatches.set(color, nativeImage.createFromBitmap(px, { width: 12, height: 12 }));
    }
    return swatches.get(color);
  }
  const groupName = (g) => g.title || `${g.color[0].toUpperCase()}${g.color.slice(1)} group`;
  // A new window where a tab was dropped (screen point from the strip), as big as the window it came from.
  function boundsAt(a) {
    const from = browser.windowBounds ? browser.windowBounds(browser.cur) : null;
    const s = scale();
    const x = Number(a.x);
    const y = Number(a.y);
    if (!from || !Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return from ? { ...from, x: from.x + 40, y: from.y + 40 } : null;
    return { x: Math.round(x * s) - 120, y: Math.round(y * s) - 16, width: from.width, height: from.height };
  }
  // "Move tab to window ▸": each other normal window, named after its open tab.
  function otherWindows(kind) {
    return browser.normalWindows().filter((k) => k !== kind).map((k) => {
      const g = browser.groups[k];
      const t = browser.tabs.get(g.activeId);
      return { key: k, label: `${(t && t.title) || 'Window'} (${g.order.length} tab${g.order.length === 1 ? '' : 's'})`.slice(0, 70) };
    });
  }
  // A folder's contents as a menu: bookmarks open here, folders open as submenus.
  function bookmarkItems(nodes) {
    return nodes.map((n) => (n.type === 'folder'
      ? { label: (n.title || 'Folder').slice(0, 60), submenu: bookmarkItems(bookmarks.children(n.id)).concat(bookmarks.children(n.id).length ? [] : [{ label: '(empty)', enabled: false }]) }
      : { label: (n.title || n.url).slice(0, 60), click: () => openBookmark(n, 'here') }));
  }
  const openAll = (parent) => { for (const b of bookmarks.urlsIn(parent)) openBookmark(b, 'tab'); };

  // ---- reader view ----
  async function openReader(tabId) {
    const tab = browser.tabs.get(tabId || browser.activeId);
    if (!tab || !tab.wc || !/^https?:/i.test(tab.url || '')) return { ok: false, error: 'Open an article first' };
    const src = fs.readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8');
    const code = `${src}\n;(function(){try{var a=new Readability(document.cloneNode(true),{charThreshold:300}).parse();` +
      'return a?{title:a.title||"",byline:a.byline||"",siteName:a.siteName||"",content:a.content||"",lang:a.lang||"",dir:a.dir||""}:null;}catch(e){return null;}})()';
    let article = null;
    // A page busy with a dialog or a long script never answers: give up after 10 s.
    try {
      article = await Promise.race([
        tab.wc.executeJavaScriptInIsolatedWorld(1999, [{ code }]),
        new Promise((r) => setTimeout(() => r(null), 10000)),
      ]);
    } catch {}
    if (!article || !article.content) return { ok: false, error: 'No article found on this page' };
    const id = String(++readerSeq);
    readerPages.set(id, { article, url: tab.url });
    if (readerPages.size > 20) readerPages.delete(readerPages.keys().next().value);
    browser.loadInTab(tab, `novadm://reader?id=${id}`);
    return { ok: true };
  }

  // ---- size of NovaDM's screens ----
  function applyScale(views) {
    const s = scale();
    for (const v of views) if (v && !v.webContents.isDestroyed()) v.webContents.setZoomFactor(s);
    for (const t of browser.tabs.values()) if (t.wc && !t.wc.isDestroyed() && /^novadm:/.test(t.url || '')) t.wc.setZoomFactor(s);
    relayout();
  }
  browser.on('page-loaded', (tab) => { if (/^novadm:/.test(tab.url || '') && tab.wc) tab.wc.setZoomFactor(scale()); });

  // ---- clear browsing data ----
  const RANGES = { hour: 3600e3, day: 86400e3, week: 7 * 86400e3, all: Infinity };
  async function clearData({ range = 'all', history: h = true, cookies = false, cache = false } = {}) {
    if (h) { history.clear(RANGES[range] || Infinity); if (range === 'all') tabSession.clear(); }
    if (cookies) {
      await browser.normalSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage', 'filesystem', 'shadercache'] });
    }
    if (cache) await browser.normalSession.clearCache();
    return { ok: true };
  }

  /** Settings → "When NovaDM closes, clear…". */
  async function onQuit() {
    const jobs = [];
    if (settings.get('clearHistoryOnExit')) history.clear();
    if (settings.get('clearCookiesOnExit') || settings.get('clearCacheOnExit')) {
      jobs.push(clearData({ history: false, cookies: !!settings.get('clearCookiesOnExit'), cache: !!settings.get('clearCacheOnExit') }).catch(() => {}));
    }
    await Promise.all(jobs);
    history.flush();
    bookmarks.flush();
    if (settings.get('restoreTabs') === false) tabSession.clear();
    tabSession.flush();
  }

  // ---- IPC (toolbar, find bar, History and Bookmarks pages, reader page) ----
  const handlers = {
    'find.open': () => openFind(),
    'find.query': (a) => browser.find(a.text, { forward: a.forward !== false, followUp: !!a.findNext }),
    'find.close': () => closeFind(),

    'omni.suggest': (a) => {
      const q = String(a.q || '').trim();
      if (!q || /^[a-z]+:\/\//i.test(q) && q.length > 200) return { items: [] };
      const lower = q.toLowerCase();
      const marks = bookmarks.items.filter((b) => (b.title + ' ' + b.url).toLowerCase().includes(lower)).slice(0, 3).map((b) => ({ url: b.url, title: b.title, kind: 'bookmark' }));
      const seen = new Set(marks.map((m) => m.url));
      const hist = history.suggest(q, 8).filter((h) => !seen.has(h.url)).map((h) => ({ ...h, kind: 'history' }));
      const items = [...marks, ...hist].slice(0, 7);
      if (items.length) { setPanel(true); sendUI('omni-suggest', { items, left: a.left, width: a.width }); }
      else sendUI('omni-hide', {});
      return { items };
    },
    'omni.highlight': (a) => sendUI('omni-highlight', { index: a.index }),
    'omni.hide': () => sendUI('omni-hide', {}),
    'omni.done': () => sendUI('omni-done', {}),

    'bookmarks.state': () => bookmarkState(),
    'bookmarks.toggleActive': () => toggleActiveBookmark(),
    'bookmarks.update': (a) => ({ ok: !!bookmarks.update(Number(a.id), a) }),
    'bookmarks.move': (a) => ({ ok: bookmarks.move(Number(a.id), /^\d+$/.test(String(a.parent)) ? Number(a.parent) : String(a.parent), Number(a.index)) }),
    'bookmarks.newFolder': (a) => ({ ok: true, id: bookmarks.addFolder(String(a.title || ''), /^\d+$/.test(String(a.parent)) ? Number(a.parent) : String(a.parent || 'bar')).id }),
    'bookmarks.remove': (a) => { bookmarks.remove(Number(a.id)); return { ok: true }; },
    'bookmarks.open': (a) => openBookmark(bookmarks.items.find((b) => b.id === Number(a.id)), a.how),
    'bookmarks.contextMenu': (a) => {
      const b = bookmarks.node(Number(a.id));
      if (!b) return;
      if (b.type === 'folder') {
        popup([
          { label: 'Open all in new tabs', click: () => openAll(b.id) },
          { type: 'separator' },
          { label: 'Rename…', click: () => browser.openInternal('bookmarks') },
          { label: 'Delete folder', click: () => bookmarks.remove(b.id) },
        ], a.x, a.y);
        return;
      }
      popup([
        { label: 'Open in new tab', click: () => openBookmark(b, 'tab') },
        { label: 'Open in private window', click: () => openBookmark(b, 'private') },
        { type: 'separator' },
        { label: 'Edit…', click: () => browser.openInternal('bookmarks') },
        { label: 'Delete', click: () => bookmarks.remove(b.id) },
      ], a.x, a.y);
    },
    // ---- the tab strip: right-click menus, groups, drag and drop ----
    'tabs.contextMenu': (a) => {
      const t = browser.tabs.get(Number(a.id));
      if (!t) return;
      const kind = browser.kindOf(t);
      const others = [...browser.groups[kind].tabGroups.values()].filter((g) => g.id !== t.groupId);
      const newGroup = () => browser.emit('group-edit', browser.addToGroup(t.id), kind); // then name it
      popup([
        { label: 'New tab to the right', click: () => browser.createTab({ incognito: t.incognito, openerPartition: t.id }) },
        { type: 'separator' },
        others.length
          ? { label: 'Add tab to group', submenu: [{ label: 'New group', click: newGroup }, { type: 'separator' }, ...others.map((g) => ({ label: groupName(g), icon: swatch(g.color), click: () => browser.addToGroup(t.id, g.id) }))] }
          : { label: 'Add tab to new group', accelerator: 'CmdOrCtrl+Shift+K', registerAccelerator: false, click: newGroup },
        ...(t.groupId != null ? [{ label: 'Remove from group', accelerator: 'CmdOrCtrl+Shift+U', registerAccelerator: false, click: () => browser.removeFromGroup(t.id) }] : []),
        { type: 'separator' },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', registerAccelerator: false, click: () => browser.reload(t.id) },
        { label: 'Duplicate', click: () => browser.duplicateTab(t.id) },
        { label: t.pinned ? 'Unpin' : 'Pin', click: () => browser.setPinned(t.id, !t.pinned) },
        ...(t.incognito ? [] : [
          { label: 'Move tab to new window', enabled: browser.groups[kind].order.length > 1, click: () => browser.moveTabToNewWindow(t.id, boundsAt({})) },
          ...(otherWindows(kind).length ? [{ label: 'Move tab to another window', submenu: otherWindows(kind).map((w) => ({ label: w.label, click: () => browser.moveTabToWindow(t.id, w.key) })) }] : []),
        ]),
        { label: t.muted ? 'Unmute tab' : 'Mute tab', enabled: !!t.wc, click: () => browser.toggleMute(t.id) },
        { type: 'separator' },
        { label: 'Close', accelerator: 'CmdOrCtrl+W', registerAccelerator: false, click: () => browser.closeTab(t.id) },
        { label: 'Close other tabs', click: () => browser.closeOthers(t.id) },
        { label: 'Close tabs to the right', click: () => browser.closeOthers(t.id, { toRight: true }) },
        { type: 'separator' },
        { label: 'Reopen closed tab', accelerator: 'CmdOrCtrl+Shift+T', registerAccelerator: false, enabled: browser.closed.length > 0, click: () => browser.reopenClosed() },
      ], a.x, a.y);
    },
    'tabs.groupMenu': (a) => {
      const kind = browser.groupKind(String(a.id));
      const g = browser.groups[kind].tabGroups.get(String(a.id));
      if (!g) return;
      const last = browser.groups[kind].order.filter((x) => browser.tabs.get(x).groupId === g.id).pop();
      popup([
        { label: 'Rename…', click: () => browser.emit('group-edit', g.id, kind) },
        { label: 'Colour', submenu: COLORS.map((c) => ({ label: c[0].toUpperCase() + c.slice(1), icon: swatch(c), type: 'radio', checked: g.color === c, click: () => browser.updateGroup(g.id, { color: c }) })) },
        { label: g.collapsed ? 'Expand' : 'Collapse', accelerator: 'CmdOrCtrl+Shift+L', registerAccelerator: false, click: () => browser.updateGroup(g.id, { collapsed: !g.collapsed }) },
        { type: 'separator' },
        { label: 'New tab in group', click: () => browser.createTab({ incognito: kind === 'private', openerPartition: last }) },
        ...(kind === 'private' ? [] : [{ label: 'Move group to new window', click: () => browser.moveGroupToNewWindow(g.id, boundsAt({})) }]),
        { label: 'Ungroup', click: () => browser.ungroup(g.id) },
        { label: 'Close group', click: () => browser.closeGroup(g.id) },
      ], a.x, a.y);
    },
    'tabs.groupUpdate': (a) => browser.updateGroup(String(a.id), { ...(a.title != null ? { title: String(a.title) } : {}), ...(a.collapsed != null ? { collapsed: !!a.collapsed } : {}) }),
    'tabs.move': (a) => browser.moveTab(Number(a.id), Number(a.index), a.groupId != null ? String(a.groupId) : null),
    'tabs.addToGroup': (a) => browser.addToGroup(Number(a.id), String(a.groupId)),
    // ---- several windows (1.6): new window, drag a tab or group out of the strip or into another window ----
    'window.new': () => browser.newWindow && browser.newWindow(),
    'tabs.detach': (a) => browser.moveTabToNewWindow(Number(a.id), boundsAt(a)),
    'tabs.detachGroup': (a) => browser.moveGroupToNewWindow(String(a.id), boundsAt(a)),
    // Dropped on this window's strip (the call comes from it, so browser.cur is this window).
    'tabs.moveHere': (a) => browser.moveTabToWindow(Number(a.id), browser.cur, Number(a.index), a.groupId != null ? String(a.groupId) : null),
    'tabs.moveGroupHere': (a) => browser.moveGroupToWindow(String(a.id), browser.cur, Number(a.index)),
    'tabs.moveGroup': (a) => browser.moveGroup(String(a.id), Number(a.index)),
    'bookmarks.listMenu': (a) => {
      // A folder (or 'other'), or the bookmarks that did not fit on the bar (the » menu).
      const parent = /^\d+$/.test(String(a.parent)) ? Number(a.parent) : a.parent;
      const list = a.ids ? a.ids.map((id) => bookmarks.node(Number(id))).filter(Boolean) : bookmarks.isContainer(parent) ? bookmarks.children(parent) : [];
      if (list.length) popup(bookmarkItems(list), a.x, a.y);
    },
    'bookmarks.addAllTabs': () => {
      const folder = 'Tabs ' + new Date().toISOString().slice(0, 10);
      const f = bookmarks.addFolder(folder, 'bar');
      for (const id of browser.order) { const t = browser.tabs.get(id); if (t && !t.incognito && /^https?:/i.test(t.url || '')) bookmarks.add({ url: t.url, title: t.title, parent: f.id }); }
      if (!bookmarks.children(f.id).length) bookmarks.remove(f.id);
      return { ok: true, folder };
    },
    'bookmarks.setBar': (a) => { settings.set({ showBookmarksBar: !!a.show }); relayout(); pushBookmarks(); return { ok: true }; },
    // The browsers found on this PC (name and profile only; the page asks by position, never by path).
    'bookmarks.browsers': () => ({ list: bookmarkImport.detectBrowsers().map(({ browser, profile }) => ({ browser, profile })) }),
    'bookmarks.importFrom': (a) => {
      const entry = bookmarkImport.detectBrowsers()[Number(a.index)];
      if (!entry) return { ok: false, error: 'That browser is not there any more.' };
      try { return { ok: true, ...bookmarks.importTree(bookmarkImport.readBrowser(entry)) }; } catch (e) {
        return { ok: false, error: entry.kind === 'firefox' ? "Could not read Firefox's bookmarks. In Firefox, export them (Bookmarks → Manage bookmarks → Import and Backup → Export to HTML) and use \"From a file\"." : e.message };
      }
    },
    'bookmarks.import': async () => {
      const r = await dialog.showOpenDialog(getWindow(), { title: 'Import bookmarks', properties: ['openFile'], filters: [{ name: 'Bookmarks (HTML or Chrome file)', extensions: ['html', 'htm', '*'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      try { return { ok: true, ...bookmarks.importTree(bookmarkImport.fromFileText(fs.readFileSync(r.filePaths[0], 'utf8'))) }; } catch (e) { return { ok: false, error: e.message }; }
    },
    'bookmarks.export': async () => {
      const r = await dialog.showSaveDialog(getWindow(), { title: 'Export bookmarks', defaultPath: 'NovaDM bookmarks.html', filters: [{ name: 'Bookmarks (HTML)', extensions: ['html'] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      fs.writeFileSync(r.filePath, bookmarks.exportHtml());
      return { ok: true };
    },

    'history.search': (a) => ({ items: history.search({ q: a.q || '', limit: Math.min(Number(a.limit) || 150, 500), before: Number(a.before) || Infinity }) }),
    'history.remove': (a) => { history.remove((a.ids || []).map(Number)); return { ok: true }; },
    'history.clear': (a) => clearData(a),
    'history.open': (a) => { if (/^https?:/i.test(a.url || '')) { if (a.newTab) browser.createTab({ url: a.url, background: true }); else browser.navigate(browser.activeId, a.url); } },

    'reader.open': () => openReader(),
    'reader.get': (a) => { const p = readerPages.get(String(a.id)); return p ? { ok: true, ...p } : { ok: false }; },
    'reader.original': (a) => { const p = readerPages.get(String(a.id)); if (p) browser.navigate(browser.activeId, p.url); },

  };

  return {
    history, bookmarks, tabSession, shields, handlers,
    chromeHeight, findBounds, createFindView, openFind, closeFind, applyScale, openStartTabs, onQuit, clearData,
    toggleActiveBookmark, openReader, bookmarkState, memoryCheck,
    get findView() { return find.view; },
    get findOpen() { return find.open; },
    useFind(f) { find = f; },
    scale,
  };
}

module.exports = { setupBrowsing };
