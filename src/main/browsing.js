'use strict';
// Everyday-browser features around the tab manager: history, bookmarks (+ bar), find in page,
// restoring tabs, address-bar suggestions, reader view, unloading idle tabs, the size of NovaDM's
// own screens, Shields rules and "clear when NovaDM closes".
const fs = require('fs');
const path = require('path');
const { WebContentsView, Menu, dialog } = require('electron');
const { History, Bookmarks, TabSession } = require('./library');
const { Shields } = require('./shields');

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

  let findView = null;
  let findOpen = false;
  const readerPages = new Map(); // id -> { article, url }
  let readerSeq = 0;

  const scale = () => Math.max(0.75, Math.min(2, (Number(settings.get('uiScale')) || 100) / 100));
  const barVisible = () => settings.get('showBookmarksBar') !== false && bookmarks.items.length > 0;
  const chromeHeight = () => Math.round((BASE_CHROME + (barVisible() ? BAR_HEIGHT : 0)) * scale());

  // ---- history ----
  browser.on('visit', (tab, url) => { history.add(url, tab.title); saveSession(); });
  browser.on('title', (tab, title) => { if (tab.wc && !tab.wc.isDestroyed()) history.setTitle(tab.wc.getURL(), title); });

  // ---- restore tabs ----
  function saveSession() {
    if (browser.shuttingDown || settings.get('restoreTabs') === false) return;
    const list = browser.order.map((id) => browser.tabs.get(id)).filter((t) => t && !t.incognito && /^(https?|novadm):/i.test(t.url || ''));
    tabSession.save(list, Math.max(0, list.findIndex((t) => t.id === browser.activeId)));
  }
  browser.on('tabs', saveSession);

  /** First tabs at start-up: the saved ones (only the active one loads right away), or a new tab. */
  function openStartTabs(openUrl) {
    if (openUrl) return browser.createTab({ url: openUrl });
    const s = settings.get('restoreTabs') !== false ? tabSession.load() : { tabs: [] };
    if (!s.tabs.length) return browser.createTab({ url: 'novadm://newtab' });
    const ids = s.tabs.map((t) => browser.createTab({ url: t.url, title: t.title, background: true, lazy: true }));
    browser.selectTab(ids[s.active] || ids[0]);
    return ids[s.active] || ids[0];
  }

  // ---- unload idle tabs ----
  setInterval(() => {
    const minutes = Number(settings.get('discardTabsAfter')) || 0;
    if (minutes > 0) browser.discardIdle(minutes);
  }, 60000).unref();

  // ---- find in page ----
  function createFindView(parent) {
    findView = new WebContentsView({ webPreferences: { preload: UI_PRELOAD, contextIsolation: true, sandbox: false, transparent: true } });
    findView.setBackgroundColor('#00000000');
    findView.webContents.loadFile(path.join(UI_DIR, 'find.html'));
    findView.setVisible(false);
    parent.addChildView(findView);
    findView.webContents.on('did-finish-load', () => findView.webContents.setZoomFactor(scale()));
    return findView;
  }
  function sendFind(name, data) { if (findView && !findView.webContents.isDestroyed()) findView.webContents.send('novadm:event', name, data); }
  function findBounds(content) {
    const s = scale();
    const w = Math.min(Math.round(FIND_W * s), content.width);
    return { x: content.x + content.width - w - Math.round(12 * s), y: content.y + Math.round(6 * s), width: w, height: Math.round(FIND_H * s) };
  }
  function openFind(text) {
    if (!findView) return;
    findOpen = true;
    findView.setVisible(true);
    relayout();
    restack();
    findView.webContents.focus();
    sendFind('find-open', { text: text || '' });
  }
  function closeFind() {
    if (!findOpen) return;
    findOpen = false;
    if (findView) findView.setVisible(false);
    browser.stopFind();
    const t = browser.activeTab();
    if (t && t.wc) t.wc.focus();
  }
  browser.on('found', (tab, r) => { if (tab.id === browser.activeId && r) sendFind('find-result', { active: r.activeMatchOrdinal || 0, matches: r.matches || 0 }); });
  browser.on('tab-selected', () => closeFind());

  // ---- bookmarks ----
  function bookmarkState() {
    return {
      items: bookmarks.list().map(({ id, url, title, folder, icon }) => ({ id, url, title, folder, icon: icon || '' })),
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
  function bookmarkItems(list) {
    return list.map((b) => ({ label: (b.title || b.url).slice(0, 60), click: () => openBookmark(b, 'here') }));
  }

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
    'bookmarks.remove': (a) => { bookmarks.remove(Number(a.id)); return { ok: true }; },
    'bookmarks.move': (a) => { bookmarks.move(Number(a.id), Number(a.index)); return { ok: true }; },
    'bookmarks.open': (a) => openBookmark(bookmarks.items.find((b) => b.id === Number(a.id)), a.how),
    'bookmarks.contextMenu': (a) => {
      const b = bookmarks.items.find((x) => x.id === Number(a.id));
      if (!b) return;
      popup([
        { label: 'Open in new tab', click: () => openBookmark(b, 'tab') },
        { label: 'Open in private tab', click: () => openBookmark(b, 'private') },
        { type: 'separator' },
        { label: 'Edit…', click: () => browser.openInternal('bookmarks') },
        { label: 'Delete', click: () => bookmarks.remove(b.id) },
      ], a.x, a.y);
    },
    'bookmarks.listMenu': (a) => {
      const list = a.folder ? bookmarks.items.filter((b) => b.folder === a.folder) : bookmarks.items.filter((b) => (a.ids || []).includes(b.id));
      if (list.length) popup(bookmarkItems(list), a.x, a.y);
    },
    'bookmarks.setBar': (a) => { settings.set({ showBookmarksBar: !!a.show }); relayout(); pushBookmarks(); return { ok: true }; },
    'bookmarks.import': async () => {
      const r = await dialog.showOpenDialog(getWindow(), { title: 'Import bookmarks', properties: ['openFile'], filters: [{ name: 'Bookmarks (HTML)', extensions: ['html', 'htm'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      try { return { ok: true, ...bookmarks.importHtml(fs.readFileSync(r.filePaths[0], 'utf8')) }; } catch (e) { return { ok: false, error: e.message }; }
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

    'tabs.unload': (a) => ({ ok: browser.discard(Number(a.id)) }),
  };

  return {
    history, bookmarks, tabSession, shields, handlers,
    chromeHeight, findBounds, createFindView, openFind, closeFind, applyScale, openStartTabs, onQuit, clearData,
    toggleActiveBookmark, openReader, bookmarkState,
    get findView() { return findView; },
    get findOpen() { return findOpen; },
    scale,
  };
}

module.exports = { setupBrowsing };
