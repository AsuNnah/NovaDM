'use strict';
// Tab manager: one WebContentsView per tab, navigation, the pop-up guard, site permissions, and
// the media sniffer (request-header capture + response classification into the media registry).
const diagnostics = require('./diagnostics');
const path = require('path');
const { EventEmitter } = require('events');
const { app, WebContentsView, session: electronSession, ipcMain } = require('electron');
const net = require('./net');
const { shortcutFor } = require('./shortcuts');
const { normalizeOrder, nextColor, cleanGroup, stepTab, COLOR_HEX } = require('./tab-groups');

const DETECT_PRELOAD = path.join(__dirname, 'detect-preload.js');
const SHIELD_PRELOAD = path.join(__dirname, 'shield-preload.js');
const { normalizeUrl, NEWTAB } = require('./address');
// novadm:// pages and their tab titles.
const INTERNAL_PAGES = new Map([
  ['newtab', 'New tab'], ['downloads', 'Downloads'], ['settings', 'Settings'], ['history', 'History'],
  ['bookmarks', 'Bookmarks'], ['reader', 'Reader view'],
]);

// NovaDM's own pages that are open once per window; asking for one again goes to the open tab (the new-tab
// page and the reader view are not in this list: those are new tabs every time).
const ONE_PER_WINDOW = /^novadm:\/\/(downloads|settings|history|bookmarks)\/?(?:[?#].*)?$/i;
/** 'settings' | 'downloads' | 'history' | 'bookmarks' for that page's address (with or without ?section=…), else ''. */
function onePerWindow(url) { const m = ONE_PER_WINDOW.exec(String(url || '')); return m ? m[1].toLowerCase() : ''; }

class Browser extends EventEmitter {
  constructor({ settings, media, adblock, popup }) {
    super();
    this.settings = settings;
    this.media = media;
    this.adblock = adblock;
    this.popup = popup;
    this.tabs = new Map(); // tabId -> tab
    // Two windows: normal tabs and private tabs each have their own window, tab order, active tab,
    // size and parent view. `cur` is the window being worked on (main.js switches it); methods that
    // act on one tab switch to that tab's window themselves (see the end of this file).
    // tabGroups: the window's tab groups, id -> { id, title, color, collapsed } (tab-groups.js).
    // 1.6: one entry per window, keyed by window id: 'normal' (the first normal window), 'n2', 'n3' …
    // for more normal windows, and 'private'. A tab knows its window (tab.win).
    this.newGroup = () => ({ order: [], activeId: null, bounds: { x: 0, y: 0, width: 800, height: 600 }, parentView: null, onRestack: null, closing: false, tabGroups: new Map() });
    this.groups = { normal: this.newGroup(), private: this.newGroup() };
    this.cur = 'normal';
    this.lastNormal = 'normal'; // the normal window used last (main.js keeps it up to date)
    this.newWindow = null; // set by main: ({ bounds, empty }) => id of a new normal window
    this.ensureWindow = null; // set by main: (kind) => opens the window for that kind of tab if needed
    this._seq = 0;
    // WebRTC: local network addresses hidden; with a proxy, nothing bypasses it (setWebRTCPolicy).
    this.webrtcPolicy = 'default_public_interface_only';
    // A plain Chrome name everywhere (pages, request headers): sites and bot checks refuse "Electron".
    app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
    this.normalSession = electronSession.fromPartition('persist:browser');
    this.incognitoSession = electronSession.fromPartition('novadm-incognito');
    this._sessionsReady = new Set();
    this.closed = []; // recently closed tabs (Ctrl+Shift+T)
    this.privatePermissions = {}; // "remember" answers given in private tabs, until the private window closes
    // Certificate errors, as in Chrome: the warning page's "Proceed (unsafe)" trusts that site with
    // that exact certificate until NovaDM closes (private windows apart). A changed certificate warns again.
    this.certSeen = new Map(); // 'n|host' or 'p|host' -> fingerprint of the certificate it showed last
    this.certAllowed = new Set(); // 'n|host|fingerprint'
    app.on('certificate-error', (event, wc, url, _error, cert, callback) => {
      const key = certKey(wc.session === this.incognitoSession, url);
      if (key && cert && this.certAllowed.has(`${key}|${cert.fingerprint}`)) { event.preventDefault(); callback(true); return; }
      if (key && cert) this.certSeen.set(key, cert.fingerprint);
      callback(false);
    });
    this._nonGet = new Map(); // url -> time: recent POST/PUT responses (their downloads can't be re-requested)
    // Messages from the detect preload in any tab (page meta, detected media, EME, nav).
    ipcMain.on('novadm:tab', (event, msg) => {
      const tabId = this.tabIdForWc(event.sender.id);
      if (tabId == null || !msg) return;
      if (msg.ch === 'novadm:navigate') this.navigate(tabId, msg.payload && msg.payload.input);
      else this.onPreloadMessage(this.tabs.get(tabId), msg.ch, msg.payload);
    });
  }

  prepareSession(ses) {
    if (this._sessionsReady.has(ses)) return;
    this._sessionsReady.add(ses);
    // Present a plain Chrome user agent (like Brave does): some sites, Google sign-in and the
    // Chrome Web Store refuse browsers that announce "Electron".
    ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
    net.installRefererHook(ses);
    ses.registerPreloadScript({ type: 'frame', filePath: SHIELD_PRELOAD }); // Guard Extended (hardening.js)
    if (this.adblock) this.adblock.attach(ses);
    this.installSniffer(ses);
    // Downloads started by pages go to NovaDM (see main.js) instead of Chromium's downloader.
    ses.on('will-download', (event, item, wc) => this.onWillDownload(event, item, wc, ses));
  }

  onWillDownload(event, item, wc, ses) {
    const tabId = wc && !wc.isDestroyed() ? this.tabIdForWc(wc.id) : null;
    const tab = tabId != null ? this.tabs.get(tabId) : null;
    const url = item.getURL();
    const posted = this._nonGet.get(url);
    const info = {
      url, name: item.getFilename(), size: item.getTotalBytes() || -1, mime: item.getMimeType(),
      pageUrl: tab ? tab.url : (wc && !wc.isDestroyed() ? wc.getURL() : ''), tabId,
      incognito: tab ? !!tab.incognito : ses === this.incognitoSession,
      // A form POST that answered with a file: asking again with GET would not get the same file.
      viaPost: !!(posted && Date.now() - posted < 120000),
    };
    this.emit('download', event, item, info);
  }

  // Capture request headers (for replay) and classify responses into the media registry.
  installSniffer(ses) {
    ses.webRequest.onSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      if (!details.webContents) return;
      const tabId = this.tabIdForWc(details.webContents.id);
      if (tabId == null) return;
      this.media.recordRequestHeaders(details.id, net.replayableHeaders(details.requestHeaders));
    });
    ses.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      if (details.method && details.method !== 'GET' && details.resourceType === 'mainFrame') {
        this._nonGet.set(details.url, Date.now());
        if (this._nonGet.size > 50) this._nonGet.delete(this._nonGet.keys().next().value);
      }
      if (!details.webContents) return;
      const tabId = this.tabIdForWc(details.webContents.id);
      if (tabId == null) return;
      const headers = {};
      for (const [k, v] of Object.entries(details.responseHeaders || {})) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      this.media.onResponse(tabId, {
        id: details.id, url: details.url, method: details.method, statusCode: details.statusCode,
        resourceType: details.resourceType, headers,
      });
    });
  }

  tabIdForWc(wcId) {
    for (const t of this.tabs.values()) if (t.wcId === wcId) return t.id;
    return null;
  }

  setBounds(bounds) {
    this.bounds = bounds;
    const t = this.tabs.get(this.activeId);
    if (t) t.view.setBounds(bounds);
  }

  setParentView(view) { this.parentView = view; }

  // The current window's state (see `groups`).
  get order() { return this.groups[this.cur].order; }
  set order(v) { this.groups[this.cur].order = v; }
  get activeId() { return this.groups[this.cur].activeId; }
  set activeId(v) { this.groups[this.cur].activeId = v; }
  get bounds() { return this.groups[this.cur].bounds; }
  set bounds(v) { this.groups[this.cur].bounds = v; }
  get parentView() { return this.groups[this.cur].parentView; }
  set parentView(v) { this.groups[this.cur].parentView = v; }
  get onRestack() { return this.groups[this.cur].onRestack; }
  set onRestack(v) { this.groups[this.cur].onRestack = v; }
  get tabGroups() { return this.groups[this.cur].tabGroups; }

  /** The id of the window a tab is in. */
  kindOf(tab) { return tab ? tab.win || (tab.incognito ? 'private' : 'normal') : 'normal'; }
  /** The normal window to open things in: the one used last, else any open one, else the first. */
  normalWindow() {
    const open = (k) => k !== 'private' && this.groups[k] && this.groups[k].parentView;
    if (open(this.lastNormal)) return this.lastNormal;
    return Object.keys(this.groups).find(open) || 'normal';
  }
  /** Normal windows that are open, by id. */
  normalWindows() { return Object.keys(this.groups).filter((k) => k !== 'private' && this.groups[k].parentView); }
  /** Run fn with window `kind` as the current one. */
  inGroup(kind, fn) {
    const prev = this.cur;
    this.cur = kind;
    try { return fn(); } finally {
      this.cur = prev;
      // Its last tab just closed (private) or the window is gone: the normal window used last.
      if (!this.groups[this.cur] || (this.cur === 'private' && !this.groups.private.order.length)) this.cur = this.normalWindow();
    }
  }
  isActive(tab) { return this.groups[this.kindOf(tab)].activeId === tab.id; }

  /**
   * `lazy` (background tabs only): the tab is listed but its page loads when it is first selected
   * (restored tabs), like an unloaded tab.
   */
  createTab(opts = {}) {
    // Private tabs: the private window. Others: the given window, the opener's (links), the current
    // normal window, or the normal window used last.
    const opener = opts.openerPartition != null ? this.tabs.get(opts.openerPartition) : null;
    const usable = (k) => k && k !== 'private' && this.groups[k];
    const kind = opts.incognito ? 'private'
      : usable(opts.win) ? opts.win : opener && !opener.incognito && usable(opener.win) ? opener.win
        : usable(this.cur) && this.groups[this.cur].parentView ? this.cur : this.normalWindow();
    if (this.ensureWindow) this.ensureWindow(kind); // a private tab opens the private window
    return this.inGroup(kind, () => this._createTab(opts));
  }

  _createTab({ url = NEWTAB, incognito = false, background = false, openerPartition, lazy = false, title = '', pinned = false, groupId = null } = {}) {
    const id = ++this._seq;
    // A link opened from a grouped tab joins that group (as in Chrome).
    const opener = openerPartition != null ? this.tabs.get(openerPartition) : null;
    if (groupId == null && opener && !opener.pinned) groupId = opener.groupId;
    const tab = {
      id, win: incognito ? 'private' : this.cur, view: null, wc: null, wcId: null, incognito, url: '', title: title || 'New tab', favicon: '',
      loading: false, canGoBack: false, canGoForward: false, secure: false, muted: false,
      discarded: false, saved: null, hiddenAt: Date.now(), readable: false,
      pinned: !!pinned, groupId: !pinned && groupId != null && this.tabGroups.has(groupId) ? groupId : null,
    };
    this.tabs.set(id, tab);
    if (openerPartition != null) { const i = this.order.indexOf(openerPartition); this.order.splice(i >= 0 ? i + 1 : this.order.length, 0, id); }
    else this.order.push(id);
    this.tidyOrder();
    if (lazy && background) {
      tab.url = normalizeUrl(url, this.settings);
      tab.secure = tab.url.startsWith('https:') && !this.certBypassed(tab, tab.url);
      tab.discarded = true;
    } else {
      this.makeView(tab);
      this.loadInTab(tab, url);
    }
    // A lazy tab is never selected here: whoever restores tabs selects the right one afterwards.
    if (!background || (this.activeId == null && !lazy)) this.selectTab(id);
    else if (tab.view) tab.view.setVisible(false);
    this.emitTabs();
    if (!background && url === NEWTAB) this.emit('blank-tab', tab); // type straight into the address bar
    return id;
  }

  /** 'disable_non_proxied_udp' while a proxy is in use: WebRTC would otherwise reveal the real address. */
  setWebRTCPolicy(policy) {
    this.webrtcPolicy = policy;
    for (const t of this.tabs.values()) if (t.wc && !t.wc.isDestroyed()) t.wc.setWebRTCIPHandlingPolicy(policy);
  }

  /** The page view of a tab (new, or again after the tab was unloaded). */
  makeView(tab) {
    const ses = tab.incognito ? this.incognitoSession : this.normalSession;
    this.prepareSession(ses);
    const view = new WebContentsView({
      webPreferences: {
        session: ses, preload: DETECT_PRELOAD, contextIsolation: true, sandbox: true,
        nodeIntegration: false, backgroundThrottling: true, spellcheck: true,
        nodeIntegrationInSubFrames: true, // preloads (not Node) in embedded frames too: shield-preload.js protects them
        enablePreferredSizeMode: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    view.webContents.setWebRTCIPHandlingPolicy(this.webrtcPolicy);
    tab.view = view;
    tab.wc = view.webContents;
    tab.wcId = tab.wc.id;
    tab.discarded = false;
    this.wireTab(tab);
    if (this.parentView) { this.parentView.addChildView(view); if (this.onRestack) this.onRestack(); }
    if (tab.id !== this.activeId) view.setVisible(false);
    this.emit('tab-created', tab);
  }

  /** Load an unloaded tab again: its back/forward list, scroll position and form values come back. */
  revive(tab) {
    const saved = tab.saved;
    tab.saved = null;
    this.makeView(tab);
    if (saved && saved.entries && saved.entries.length) {
      tab.wc.navigationHistory.restore({ entries: saved.entries, index: saved.index }).catch(() => this.loadInTab(tab, tab.url));
    } else {
      this.loadInTab(tab, tab.url || NEWTAB);
    }
  }

  /**
   * Unload a background tab to free its memory and CPU (Settings → Unload inactive tabs). The tab
   * stays in the strip; selecting it loads it again. Returns true if it was unloaded.
   */
  discard(id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.discarded || id === this.activeId || !tab.wc || tab.wc.isDestroyed()) return false;
    let entries = [];
    let index = 0;
    try {
      entries = tab.wc.navigationHistory.getAllEntries().map((e) => ({ url: e.url, title: e.title, pageState: e.pageState }));
      index = tab.wc.navigationHistory.getActiveIndex();
    } catch {}
    tab.saved = { entries, index };
    if (this.adblock) this.adblock.removeTab(tab.wcId);
    try { if (this.parentView) this.parentView.removeChildView(tab.view); } catch {}
    try { tab.wc.close(); } catch {}
    tab.view = null; tab.wc = null; tab.wcId = null;
    tab.discarded = true; tab.loading = false;
    this.emit('tab-discarded', tab);
    this.emitTabs();
    return true;
  }

  /** Background tabs idle for `minutes` that aren't playing sound or loading. */
  discardIdle(minutes, now = Date.now()) {
    const out = [];
    for (const tab of this.tabs.values()) {
      if (tab.discarded || this.isActive(tab) || !tab.wc || tab.wc.isDestroyed()) continue;
      if (now - (tab.hiddenAt || now) < minutes * 60000) continue;
      if (tab.loading || tab.wc.isCurrentlyAudible() || tab.keepLoaded) continue;
      if (this.discard(tab.id)) out.push(tab.id);
    }
    return out;
  }

  /**
   * Memory overload protection: unload up to `max` background tabs, the longest unused first.
   * Never the open tab of a window, a tab playing sound or loading, or one marked to stay loaded.
   */
  discardForMemory(max = 3) {
    const candidates = [...this.tabs.values()]
      .filter((t) => !t.discarded && !this.isActive(t) && t.wc && !t.wc.isDestroyed() && !t.loading && !t.keepLoaded && !t.wc.isCurrentlyAudible())
      .sort((a, b) => (a.hiddenAt || 0) - (b.hiddenAt || 0));
    const out = [];
    for (const t of candidates) { if (out.length >= max) break; if (this.discard(t.id)) out.push(t.id); }
    return out;
  }

  wireTab(tab) {
    const wc = tab.wc;
    const update = () => this.refreshTabState(tab);
    wc.on('page-title-updated', (_e, title) => { tab.title = title; update(); if (!tab.incognito) this.emit('title', tab, title); });
    wc.on('found-in-page', (_e, result) => this.emit('found', tab, result));
    wc.on('did-start-loading', () => { tab.loading = true; update(); });
    wc.on('did-stop-loading', () => { tab.loading = false; update(); });
    wc.on('did-finish-load', () => this.emit('page-loaded', tab));
    // Browser shortcuts also while a page has the keyboard; Ctrl +/-/0 zoom the page (per site).
    // Browser shortcuts also while a page has the keyboard (shortcuts.js); Ctrl +/-/0 and
    // Ctrl+wheel zoom the page (per site).
    wc.on('before-input-event', (e, input) => {
      const action = shortcutFor(input);
      if (!action || (action === 'stop' && !tab.loading)) return; // Esc stays the page's unless it's loading
      e.preventDefault();
      if (action.startsWith('zoom')) return this.zoom(tab, action);
      this.emit('shortcut', tab, action);
    });
    wc.on('zoom-changed', (_e, dir) => this.zoom(tab, dir === 'in' ? 'zoom-in' : 'zoom-out'));
    wc.on('will-navigate', (e) => {
      if (/^magnet:\?/i.test(e.url || '')) { e.preventDefault(); this.emit('magnet', tab, e.url); }
    });
    wc.on('did-start-navigation', (e) => {
      // Only a real page change resets per-page state; SPA URL changes (same document) keep it.
      if (!e.isMainFrame || e.isSameDocument) return;
      this.media.resetTab(tab.id, e.url || wc.getURL());
      if (this.adblock) this.adblock.resetTab(tab.wcId);
      tab.clicks = [];
      this.emit('page-changed', tab.id);
    });
    wc.on('did-navigate', (_e, url) => {
      const internal = internalUrl(url);
      // The error page keeps showing the address that failed, so Reload/Enter retries it.
      tab.url = internal === 'novadm://error' && tab.failed ? tab.failed.url : (internal || url);
      if (internal !== 'novadm://error') tab.failed = null;
      tab.secure = url.startsWith('https:') && !this.certBypassed(tab, url); // no lock after "Proceed (unsafe)"
      tab.readable = false;
      if (tab.ampFrom && url !== tab.ampFrom) {
        // Arrived on the real page: drop the AMP page from the back list so Back doesn't bounce.
        try {
          const nh = wc.navigationHistory;
          const i = nh.getActiveIndex() - 1;
          if (i >= 0 && nh.getEntryAtIndex(i).url === tab.ampFrom) nh.removeEntryAtIndex(i);
        } catch {}
        tab.ampFrom = null;
      }
      update();
      if (!tab.incognito) this.emit('visit', tab, url);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      // -3 = aborted (user navigated away / download started): not an error.
      if (isMain && code !== -3 && !tab.incognito) diagnostics.add('load', [`tab: ${desc} (${code}) ${url}`]); // the report keeps the site only
      if (!isMain || code === -3 || !/^https?:/i.test(url)) return;
      // A link NovaDM upgraded to HTTPS, and the site has no working HTTPS: open it as it was.
      const plain = this.shields ? this.shields.fallback(url) : null;
      if (plain) { tab.wc.loadURL(plain).catch(() => {}); return; }
      tab.failed = { url, code, desc };
      tab.loading = false;
      const phishing = code === -20 && !!this.adblock && this.adblock.phishBlocked.delete(url); // -20: blocked by NovaDM
      wc.loadFile(path.join(__dirname, '..', 'ui', 'error.html'), { query: { u: url, c: String(code), d: desc || '', p: phishing ? '1' : '' } }).catch(() => {});
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => {
      if (!isMain) return;
      tab.url = internalUrl(url) || url;
      update();
      if (!tab.incognito) this.emit('visit', tab, url);
    });
    wc.on('page-favicon-updated', (_e, icons) => { tab.favicon = icons && icons[0] || ''; update(); });
    wc.on('media-started-playing', update);
    wc.on('enter-html-full-screen', () => this.emit('fullscreen', tab, true));
    wc.on('leave-html-full-screen', () => this.emit('fullscreen', tab, false));
    wc.on('render-process-gone', () => { tab.title = 'Page crashed'; tab.loading = false; update(); });

    wc.setWindowOpenHandler((details) => this.handleWindowOpen(tab, details));
    wc.on('context-menu', (_e, params) => this.emit('context-menu', tab, params));
    // Pages that send the current tab to a known ad site (click hijacking) are stopped.
    wc.on('will-navigate', (e) => {
      if (this.adblock && /^https?:/i.test(e.url) && this.adblock.isAdUrl(e.url, tab.url)) {
        e.preventDefault();
        this.emit('popup-blocked', tab.id, e.url, 'ad-redirect');
      }
    });
    wc.session.setPermissionRequestHandler((wcc, permission, cb, detailsP) => this.handlePermission(tab, permission, detailsP, cb));
    wc.session.setPermissionCheckHandler((wcc, permission, origin) => this.checkPermission(origin, permission, tab.incognito));

  }

  zoom(tab, action) {
    const wc = tab.wc;
    const level = action === 'zoom-reset' ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + (action === 'zoom-in' ? 0.5 : -0.5)));
    wc.setZoomLevel(level);
    this.emit('zoom', tab, Math.round(Math.pow(1.2, level) * 100));
  }

  /** Ctrl+Shift+T: the last closed (non-private) tab, back where it was; from a private window, nothing. */
  reopenClosed(fromPrivate = this.cur === 'private') {
    if (fromPrivate) return null;
    const last = this.closed.pop();
    if (!last) return null;
    if (last.window) { // a closed window: back with its tabs and groups
      if (!this.newWindow) return null;
      const win = this.newWindow({ bounds: last.window.bounds, empty: true });
      const gids = new Map(last.window.groups.map((g) => [g.id, this.restoreGroup(g, win)]));
      const ids = last.window.tabs.map((t) => {
        const id = this.createTab({ win, url: t.url, title: t.title, lazy: true, background: true, pinned: t.pinned, groupId: gids.get(t.group) ?? null });
        this.tabs.get(id).saved = t.saved;
        return id;
      });
      if (ids.length) this.selectTab(ids[0]);
      return ids[0];
    }
    const id = this.createTab({ url: last.url, lazy: true, background: true, title: last.title });
    this.tabs.get(id).saved = last.saved;
    this.selectTab(id);
    return id;
  }

  onPreloadMessage(tab, channel, payload) {
    switch (channel) {
      case 'novadm:page-meta':
        this.media.setPageInfo(tab.id, payload);
        if (payload && payload.title) { tab.title = payload.title; this.refreshTabState(tab); }
        break;
      case 'novadm:dom-media':
        for (const m of payload || []) {
          this.media.onResponse(tab.id, {
            id: 'dom-' + require('crypto').randomUUID(), url: m.url, method: 'GET', statusCode: 200,
            resourceType: 'media', headers: { 'content-type': guessMime(m) },
          });
        }
        break;
      case 'novadm:eme':
        this.media.markEme(tab.id, payload && payload.keySystem);
        break;
      case 'novadm:download-video':
        this.emit('download-video-request', tab.id);
        break;
      case 'novadm:readable':
        if (payload && payload.url === (tab.wc && tab.wc.getURL()) && tab.readable !== !!payload.ok) { tab.readable = !!payload.ok; this.refreshTabState(tab); }
        break;
      case 'novadm:amp': {
        // De-AMP: open the publisher's own page; the AMP copy is taken out of the back list.
        if (this.settings.get('deAmp') === false || !payload || !/^https?:/i.test(payload.canonical || '')) break;
        if (!tab.wc || payload.from !== tab.wc.getURL() || tab.ampFrom === payload.from) break;
        tab.ampFrom = payload.from;
        if (this.shields) this.shields.stats.deAmp++;
        tab.wc.loadURL(payload.canonical).catch(() => {});
        break;
      }
      case 'novadm:download-link':
        if (payload && /^https?:/i.test(payload.href || '')) this.emit('download-link', tab, payload.href);
        break;
      case 'novadm:link-click': {
        const list = (tab.clicks || []).filter((c) => Date.now() - c.t < 3000);
        list.push({ href: payload.href, mods: !!payload.mods, t: Date.now() });
        tab.clicks = list.slice(-5);
        break;
      }
    }
  }

  // A real click on a link pointing at `url` in the last couple of seconds, if any.
  takeClick(tab, url) {
    const strip = (u) => String(u || '').split('#')[0];
    const list = tab.clicks || [];
    const i = list.findIndex((c) => Date.now() - c.t < 2500 && strip(c.href) === strip(url));
    if (i < 0) return null;
    return list.splice(i, 1)[0];
  }

  handleWindowOpen(tab, details) {
    if (/^magnet:\?/i.test(details.url || '')) { this.emit('magnet', tab, details.url); return { action: 'deny' }; }
    // Always deny the raw request and decide a moment later: the preload's click report travels
    // on a separate channel and may arrive just after this call. Allowed windows open as tabs.
    setTimeout(() => this.decideWindowOpen(tab, details), 60);
    return { action: 'deny' };
  }

  decideWindowOpen(tab, { url, disposition }) {
    if (!this.tabs.has(tab.id)) return;
    const click = this.takeClick(tab, url);
    const isAd = !!(this.adblock && /^https?:/i.test(url) && this.adblock.isAdUrl(url, tab.url));
    const decision = this.popup.decideRequest({ pageUrl: tab.url, url, click, isAd });
    if (decision === 'open') {
      if (/^https?:|^novadm:/i.test(url)) {
        // As in Chrome: Ctrl+click / middle-click behind, Ctrl+Shift+click and Shift+click in front.
        const background = disposition === 'background-tab' || (!['foreground-tab', 'new-window'].includes(disposition) && !!(click && click.mods));
        this.createTab({ url, incognito: tab.incognito, background, openerPartition: tab.id });
      }
      return;
    }
    if (decision === 'block') { this.emit('popup-blocked', tab.id, url, isAd ? 'ad' : 'popup'); return; }
    this.emit('popup-ask', { tabId: tab.id, pageUrl: tab.url, url, fromClick: !!click });
  }

  handlePermission(tab, permission, details, callback) {
    // A magnet: link opens in NovaDM instead of asking Windows for another torrent app.
    if (permission === 'openExternal' && details && /^magnet:\?/i.test(details.externalURL || '')) {
      callback(false);
      this.emit('magnet', tab, details.externalURL);
      return;
    }
    const origin = (details && details.requestingUrl) ? originOf(details.requestingUrl) : originOf(tab.url);
    const stored = this.getStoredPermission(origin, permission, tab.incognito);
    if (stored === 'granted') return callback(true);
    if (stored === 'denied') return callback(false);
    const auto = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
    if (auto.has(permission)) return callback(true);
    this.emit('permission-ask', { tabId: tab.id, origin, permission, incognito: !!tab.incognito }, callback);
  }

  checkPermission(origin, permission, incognito = false) {
    const stored = this.getStoredPermission(originOf(origin), permission, incognito);
    return stored === 'granted';
  }

  getStoredPermission(origin, permission, incognito = false) {
    const all = this.settings.get('sitePermissions') || {};
    const saved = all[origin] && all[origin][permission];
    if (!incognito) return saved;
    // Private tabs: their own answers; from normal browsing only a block carries over (as in Chrome), never an allow.
    const own = this.privatePermissions[origin] && this.privatePermissions[origin][permission];
    return own || (saved === 'denied' ? 'denied' : undefined);
  }

  setPermission(origin, permission, value, incognito = false) {
    if (incognito) { this.privatePermissions[origin] = { ...(this.privatePermissions[origin] || {}), [permission]: value }; return; }
    const all = { ...(this.settings.get('sitePermissions') || {}) };
    all[origin] = { ...(all[origin] || {}), [permission]: value };
    this.settings.set({ sitePermissions: all });
  }

  loadInTab(tab, url) {
    if (!tab.wc) { tab.saved = null; this.makeView(tab); } // an unloaded tab told to go somewhere else
    const target = normalizeUrl(url, this.settings);
    if (target.startsWith('novadm://')) {
      const rest = target.slice('novadm://'.length);
      const page = rest.split(/[?#]/)[0] || 'newtab';
      if (!INTERNAL_PAGES.has(page)) { tab.url = target; tab.wc.loadFile(path.join(__dirname, '..', 'ui', 'newtab.html')).catch(() => {}); return; }
      const query = Object.fromEntries(new URLSearchParams(rest.includes('?') ? rest.slice(rest.indexOf('?') + 1) : ''));
      if (tab.incognito) query.private = '1'; // the page shows the private look (theme.css)
      tab.url = 'novadm://' + page; tab.title = INTERNAL_PAGES.get(page);
      tab.wc.loadFile(path.join(__dirname, '..', 'ui', `${page}.html`), { query }).catch(() => {});
    } else {
      tab.url = target;
      tab.wc.loadURL(target).catch(() => {});
    }
  }

  /** Show an internal page (e.g. 'downloads'): reuse its tab if one is open, else open a new tab. */
  openInternal(page) {
    return this.inGroup(this.normalWindow(), () => this._openInternal(page)); // NovaDM's pages: the normal window in use
  }

  _openInternal(page) { return this.openPage('novadm://' + page); }

  /**
   * Open an address in a new tab, except NovaDM's own settings / downloads / history / bookmarks pages: those are
   * open once per window, so a second request goes to the open tab (and to the section asked for, ?section=about).
   */
  openPage(url) {
    const page = onePerWindow(url);
    const open = page && this.order.map((id) => this.tabs.get(id)).find((t) => t && onePerWindow(t.url) === page);
    if (!open) return this.createTab({ url });
    this.selectTab(open.id);
    if (/[?#]/.test(url)) this.loadInTab(open, url);
    return open.id;
  }

  /** Tabs currently showing an internal page, for pushing live updates to them. */
  internalTabs(page) {
    const url = 'novadm://' + page;
    return [...this.tabs.values()].filter((t) => t.url === url && t.wc && !t.wc.isDestroyed());
  }

  // ---- find in page (Ctrl+F) ----
  /** `followUp`: the next/previous match of the same text (Electron's findNext means "new search"). */
  find(text, { forward = true, followUp = false } = {}) {
    const t = this.activeTab();
    if (!t || !t.wc) return;
    if (!text) { t.wc.stopFindInPage('clearSelection'); return; }
    t.wc.findInPage(String(text).slice(0, 500), { forward, findNext: !followUp });
  }

  stopFind(action = 'clearSelection') {
    for (const t of this.tabs.values()) if (t.wc && !t.wc.isDestroyed()) { try { t.wc.stopFindInPage(action); } catch {} }
  }

  navigate(tabId, input) {
    const tab = this.tabs.get(tabId || this.activeId);
    if (!tab) return;
    this.loadInTab(tab, input);
  }

  selectTab(id) {
    if (!this.tabs.has(id)) return;
    const prev = this.tabs.get(this.activeId);
    if (prev && prev.id !== id) { prev.hiddenAt = Date.now(); if (prev.view) prev.view.setVisible(false); }
    this.activeId = id;
    const tab = this.tabs.get(id);
    const g = tab.groupId != null && this.tabGroups.get(tab.groupId);
    if (g && g.collapsed) g.collapsed = false; // a tab in a folded group opens it
    if (tab.discarded) this.revive(tab);
    tab.view.setBounds(this.bounds);
    tab.view.setVisible(true);
    try { if (this.parentView) this.parentView.addChildView(tab.view); } catch {} // raise to top
    if (this.onRestack) this.onRestack(); // keep chrome + overlay above the page
    this.emit('tab-selected', tab);
    this.refreshTabState(tab);
    this.emitActive();
    this.emitTabs();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const idx = this.order.indexOf(id);
    this.order.splice(idx, 1);
    this.tabs.delete(id);
    if (this.adblock && tab.wcId != null) this.adblock.removeTab(tab.wcId);
    this.media.removeTab(tab.id);
    this.emit('tab-closed', tab);
    if (!tab.incognito && !this.groups[this.cur].closing && /^(https?|novadm):/i.test(tab.url || '')) {
      let saved = tab.saved;
      try { if (tab.wc) saved = { entries: tab.wc.navigationHistory.getAllEntries(), index: tab.wc.navigationHistory.getActiveIndex() }; } catch {}
      this.closed.push({ url: tab.url, title: tab.title, saved });
      if (this.closed.length > 25) this.closed.shift();
    }
    if (tab.view) { try { if (this.parentView) this.parentView.removeChildView(tab.view); } catch {} }
    if (tab.wc) { try { tab.wc.close(); } catch {} }
    this.dropEmptyGroups();
    if (this.shuttingDown || this.groups[this.cur].closing) { this.emitTabs(); return; } // window closing: no replacement tab
    if (this.activeId === id) {
      // The next tab to the right (else left), preferring one that isn't in a folded group.
      const shown = (x) => !this.isFolded(this.tabs.get(x));
      const next = this.order.slice(idx).find(shown) || this.order.slice(0, idx).reverse().find(shown) || this.order[idx] || this.order[idx - 1] || null;
      this.activeId = null;
      if (next != null) this.selectTab(next);
      else if (this.cur === 'private' || this.normalWindows().length > 1) { this.emitTabs(); this.emit('group-empty', this.cur); return; } // its last tab: the window closes
      else this.createTab({ url: NEWTAB });
    }
    this.emitTabs();
  }

  back(id) { const t = this.tabs.get(id || this.activeId); if (t && t.wc && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack(); }
  forward(id) { const t = this.tabs.get(id || this.activeId); if (t && t.wc && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward(); }
  reload(id) {
    const t = this.tabs.get(id || this.activeId);
    if (!t || !t.wc) return;
    // On the error page, retry the address that failed rather than reloading the error page.
    if (internalUrl(t.wc.getURL()) === 'novadm://error' && t.failed) this.loadInTab(t, t.failed.url);
    else t.wc.reload();
  }
  stop(id) { const t = this.tabs.get(id || this.activeId); if (t && t.wc) t.wc.stop(); }

  activeTab() { return this.tabs.get(this.activeId); }

  refreshTabState(tab) {
    if (tab.wc && !tab.wc.isDestroyed()) {
      try {
        tab.canGoBack = tab.wc.navigationHistory.canGoBack();
        tab.canGoForward = tab.wc.navigationHistory.canGoForward();
      } catch {}
    }
    this.emit('tab-updated', this.serializeTab(tab));
    if (tab.id === this.activeId) this.emitActive();
  }

  serializeTab(tab) {
    return {
      id: tab.id, title: tab.title || 'New tab', url: displayUrl(tab.url), favicon: tab.favicon,
      loading: tab.loading, incognito: tab.incognito, secure: tab.secure,
      canGoBack: tab.canGoBack, canGoForward: tab.canGoForward, active: tab.id === this.activeId,
      discarded: !!tab.discarded, readable: !!tab.readable,
      bookmarked: this.isBookmarked ? this.isBookmarked(tab.url) : false,
      bookmarkIn: this.bookmarkFolder ? this.bookmarkFolder(tab.url) : '', // where it is, for the star's tooltip
      pinned: !!tab.pinned, muted: !!tab.muted,
      group: tab.groupId != null && this.tabGroups.has(tab.groupId) ? { ...this.tabGroups.get(tab.groupId), hex: COLOR_HEX[this.tabGroups.get(tab.groupId).color] } : null,
    };
  }

  /** "Proceed (unsafe)": trust the certificate the site showed last; false when there is none. */
  allowCert(tab, url) {
    const key = certKey(tab.incognito, url);
    const fp = key && this.certSeen.get(key);
    if (!fp) return false;
    this.certAllowed.add(`${key}|${fp}`);
    return true;
  }
  certBypassed(tab, url) {
    const key = certKey(tab.incognito, url);
    return !!key && [...this.certAllowed].some((x) => x.startsWith(key + '|'));
  }

  // ---- pinned tabs, tab groups and the tab menu (order rules: tab-groups.js) ----
  tidyOrder() { this.order = normalizeOrder(this.order, (x) => this.tabs.get(x)); }
  isFolded(tab) { const g = tab && tab.groupId != null && this.tabGroups.get(tab.groupId); return !!(g && g.collapsed); }
  dropEmptyGroups() {
    for (const gid of [...this.tabGroups.keys()]) if (!this.order.some((x) => this.tabs.get(x).groupId === gid)) this.tabGroups.delete(gid);
  }
  /** After pinning, grouping or moving: groups without tabs go, the order is tidied, the strip redrawn. */
  groupsChanged() { this.dropEmptyGroups(); this.tidyOrder(); this.emitTabs(); }
  /** The window a tab group belongs to. */
  groupKind(gid) { return Object.keys(this.groups).find((k) => this.groups[k].tabGroups.has(gid)) || this.cur; }

  setPinned(id, pinned) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.pinned = !!pinned;
    if (tab.pinned) tab.groupId = null; // pinned tabs are never in a group
    this.groupsChanged();
  }

  /** Put a tab in a group, at the group's end; a new group when `gid` is empty. Returns the group id. */
  addToGroup(id, gid) {
    const tab = this.tabs.get(id);
    if (!tab) return null;
    let g = gid != null ? this.tabGroups.get(gid) : null;
    if (!g) {
      g = { id: 'g' + (++this._seq), ...cleanGroup({ color: nextColor([...this.tabGroups.values()].map((x) => x.color)) }) };
      this.tabGroups.set(g.id, g);
    }
    tab.pinned = false;
    tab.groupId = null;
    const at = this.order.indexOf(id);
    this.order.splice(at, 1);
    const last = this.order.map((x) => this.tabs.get(x).groupId).lastIndexOf(g.id);
    this.order.splice(last >= 0 ? last + 1 : at, 0, id); // a new group starts where the tab is
    tab.groupId = g.id;
    g.collapsed = false;
    this.groupsChanged();
    return g.id;
  }

  /** Take a tab out of its group; it goes just after the group. */
  removeFromGroup(id) {
    const tab = this.tabs.get(id);
    if (!tab || tab.groupId == null) return;
    const gid = tab.groupId;
    tab.groupId = null;
    const at = this.order.indexOf(id);
    this.order.splice(at, 1);
    const last = this.order.map((x) => this.tabs.get(x).groupId).lastIndexOf(gid);
    this.order.splice(last >= 0 ? last + 1 : at, 0, id); // the group's only tab stays where it is
    this.groupsChanged();
  }

  /** Drag and drop: the tab goes to `index` (in the order without it), in group `gid` or none. */
  moveTab(id, index, gid = null) {
    const tab = this.tabs.get(id);
    if (!tab || !this.order.includes(id)) return;
    this.order.splice(this.order.indexOf(id), 1);
    this.order.splice(Math.max(0, Math.min(Number(index) || 0, this.order.length)), 0, id);
    if (!tab.pinned) tab.groupId = gid != null && this.tabGroups.has(gid) ? gid : null;
    this.groupsChanged();
  }

  /** Keyboard move (Ctrl+Shift+PgUp / PgDn), see stepTab. */
  stepTab(id, dir) {
    const r = stepTab(this.order, (x) => this.tabs.get(x), (gid) => !!(this.tabGroups.get(gid) || {}).collapsed, id, dir);
    if (!r) return;
    this.order = r.order;
    this.tabs.get(id).groupId = r.groupId;
    this.groupsChanged();
  }

  /** Drag a group's chip: its tabs move together to `index` (in the order without them). */
  moveGroup(gid, index) {
    this.inGroup(this.groupKind(gid), () => {
      const members = this.order.filter((x) => this.tabs.get(x).groupId === gid);
      if (!members.length) return;
      const rest = this.order.filter((x) => !members.includes(x));
      rest.splice(Math.max(0, Math.min(Number(index) || 0, rest.length)), 0, ...members);
      this.order = rest;
      this.groupsChanged();
    });
  }

  /** Rename, recolour, fold or unfold a group. Folding moves away from a tab inside it. */
  updateGroup(gid, patch = {}) {
    return this.inGroup(this.groupKind(gid), () => {
      const g = this.tabGroups.get(gid);
      if (!g) return;
      Object.assign(g, cleanGroup({ ...g, ...patch }));
      if (g.collapsed && this.isFolded(this.activeTab())) this.leaveGroup(gid);
      this.emitTabs();
    });
  }

  /** Select a tab outside group `gid` (the nearest to the right, else left), or open a new tab. */
  leaveGroup(gid) {
    const idx = this.order.indexOf(this.activeId);
    const outside = (x) => this.tabs.get(x).groupId !== gid && !this.isFolded(this.tabs.get(x));
    const next = this.order.slice(idx + 1).find(outside) || this.order.slice(0, Math.max(0, idx)).reverse().find(outside);
    if (next != null) this.selectTab(next);
    else this.createTab({ url: NEWTAB, incognito: this.cur === 'private' });
  }

  ungroup(gid) {
    this.inGroup(this.groupKind(gid), () => {
      for (const x of this.order) if (this.tabs.get(x).groupId === gid) this.tabs.get(x).groupId = null;
      this.groupsChanged();
    });
  }

  closeGroup(gid) {
    this.inGroup(this.groupKind(gid), () => {
      const ids = this.order.filter((x) => this.tabs.get(x).groupId === gid);
      if (ids.includes(this.activeId)) this.leaveGroup(gid); // so no tab of the group gets loaded on the way
      for (const x of ids) this.closeTab(x);
    });
  }

  /** A group from a saved session; returns its new id. */
  restoreGroup(saved, win = 'normal') {
    return this.inGroup(win, () => {
      const g = { id: 'g' + (++this._seq), ...cleanGroup(saved) };
      this.tabGroups.set(g.id, g);
      return g.id;
    });
  }

  // ---- several windows (1.6) ----
  /**
   * Move a tab to another normal window, its page kept loaded: at `index` of that window's order, in
   * group `groupId` there (or none). The window it leaves closes when that was its last tab.
   */
  moveTabToWindow(id, to, index = Infinity, groupId = null) {
    const tab = this.tabs.get(id);
    const from = tab && this.kindOf(tab);
    if (!tab || tab.incognito || to === 'private' || !this.groups[to] || from === to) return false;
    const src = this.groups[from];
    const dst = this.groups[to];
    this.inGroup(from, () => {
      const i = this.order.indexOf(id);
      if (i >= 0) this.order.splice(i, 1);
      if (tab.view) { try { if (this.parentView) this.parentView.removeChildView(tab.view); } catch {} }
      if (this.activeId === id) {
        this.activeId = null;
        const next = this.order[i] || this.order[i - 1];
        if (next != null) this.selectTab(next);
      }
      tab.groupId = null;
      this.dropEmptyGroups();
      this.emitTabs();
    });
    this.inGroup(to, () => {
      tab.win = to;
      tab.groupId = groupId != null && this.tabGroups.has(groupId) ? groupId : null;
      tab.pinned = tab.pinned && !tab.groupId;
      this.order.splice(Math.max(0, Math.min(Number(index), this.order.length)), 0, id);
      this.tidyOrder();
      if (tab.view && this.parentView) { try { this.parentView.addChildView(tab.view); tab.view.setVisible(false); } catch {} }
      this.selectTab(id);
    });
    if (!src.order.length) this.emit('group-empty', from);
    return true;
  }

  /** "Move tab to new window" / a tab dragged out of the strip. Not the only tab of a window. */
  moveTabToNewWindow(id, bounds) {
    const tab = this.tabs.get(id);
    if (!tab || tab.incognito || !this.newWindow || this.groups[this.kindOf(tab)].order.length < 2) return null;
    const win = this.newWindow({ bounds, empty: true });
    this.moveTabToWindow(id, win, 0);
    return win;
  }

  /** A whole tab group, with its name and colour, into another normal window at `index`. */
  moveGroupToWindow(gid, to, index = Infinity) {
    const from = this.groupKind(gid);
    const g = this.groups[from] && this.groups[from].tabGroups.get(gid);
    if (!g || from === 'private' || to === 'private' || !this.groups[to] || from === to) return false;
    const ids = this.groups[from].order.filter((x) => this.tabs.get(x).groupId === gid);
    const ng = this.restoreGroup({ title: g.title, color: g.color, collapsed: false }, to);
    const at = Math.min(Number(index), this.groups[to].order.length);
    ids.forEach((x, i) => this.moveTabToWindow(x, to, at + i, ng));
    return true;
  }

  /** Tear off a tab group: all its tabs, with its name and colour, into a new window. */
  moveGroupToNewWindow(gid, bounds) {
    const from = this.groupKind(gid);
    if (!this.groups[from] || !this.groups[from].tabGroups.has(gid) || from === 'private' || !this.newWindow) return null;
    const win = this.newWindow({ bounds, empty: true });
    this.moveGroupToWindow(gid, win, 0);
    return win;
  }

  /** The tabs of a closing normal window, for Ctrl+Shift+T to bring the whole window back. */
  rememberWindow(win, bounds) {
    const g = this.groups[win];
    if (!g || win === 'private') return;
    const tabs = g.order.map((x) => this.tabs.get(x)).filter((t) => t && /^(https?|novadm):/i.test(t.url || '')).map((t) => {
      let saved = t.saved;
      try { if (t.wc) saved = { entries: t.wc.navigationHistory.getAllEntries(), index: t.wc.navigationHistory.getActiveIndex() }; } catch {}
      return { url: t.url, title: t.title, saved, pinned: !!t.pinned, group: t.groupId };
    });
    if (!tabs.length) return;
    const groups = [...g.tabGroups.values()].map((x) => ({ ...x }));
    this.closed.push({ window: { bounds, tabs, groups } });
    if (this.closed.length > 25) this.closed.shift();
  }

  duplicateTab(id) {
    const tab = this.tabs.get(id);
    if (tab) this.createTab({ url: tab.url, incognito: tab.incognito, openerPartition: tab.id });
  }

  /** Close every other tab (`toRight`: only those to the right). Pinned tabs stay. */
  closeOthers(id, { toRight = false } = {}) {
    const idx = this.order.indexOf(id);
    if (idx < 0) return;
    const ids = this.order.filter((x, i) => x !== id && !this.tabs.get(x).pinned && (!toRight || i > idx));
    if (ids.includes(this.activeId)) this.selectTab(id);
    for (const x of ids) this.closeTab(x);
  }

  toggleMute(id) {
    const tab = this.tabs.get(id);
    if (!tab || !tab.wc) return;
    tab.muted = !tab.wc.isAudioMuted();
    tab.wc.setAudioMuted(tab.muted);
    this.refreshTabState(tab);
  }

  emitTabs() { this.emit('tabs', this.order.map((id) => this.serializeTab(this.tabs.get(id))).filter(Boolean), this.activeId, this.cur); }
  emitActive() { const t = this.activeTab(); if (t) this.emit('active', this.serializeTab(t), this.cur); }

  destroy() {
    for (const tab of this.tabs.values()) { if (tab.wc) { try { tab.wc.close(); } catch {} } }
    this.tabs.clear();
    for (const g of Object.values(this.groups)) { g.order = []; g.activeId = null; }
  }
}

// Methods for one tab work in that tab's window (its order, active tab, size and parent view).
for (const m of ['makeView', 'revive', 'discard', 'selectTab', 'closeTab', 'refreshTabState', 'serializeTab',
  'setPinned', 'addToGroup', 'removeFromGroup', 'moveTab', 'stepTab', 'duplicateTab', 'closeOthers', 'toggleMute']) {
  const f = Browser.prototype[m];
  Browser.prototype[m] = function (x, ...rest) {
    const tab = typeof x === 'object' && x ? x : this.tabs.get(x);
    return tab ? this.inGroup(this.kindOf(tab), () => f.call(this, x, ...rest)) : f.call(this, x, ...rest);
  };
}

function guessMime(m) {
  const ext = (/\.([a-z0-9]{1,5})(\?|#|$)/i.exec(m.url) || [])[1];
  const map = { m3u8: 'application/vnd.apple.mpegurl', mpd: 'application/dash+xml', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', vtt: 'text/vtt', srt: 'application/x-subrip' };
  return map[(ext || '').toLowerCase()] || (m.kind === 'audio' ? 'audio/mpeg' : m.kind === 'video' ? 'video/mp4' : 'application/octet-stream');
}

function certKey(incognito, url) {
  try { return `${incognito ? 'p' : 'n'}|${new URL(url).host.toLowerCase()}`; } catch { return ''; }
}

function originOf(u) { try { return new URL(u).origin; } catch { return u || ''; } }

// "… Chrome/156.0.0.0 novadm/0.1.0 Electron/45.0.0 Safari/537.36" -> "… Chrome/156.0.0.0 Safari/537.36"
function cleanUserAgent(ua) {
  return String(ua || '').replace(/\s+Electron\/\S+/i, '').replace(/\s+novadm\/\S+/i, '').replace(/\s{2,}/g, ' ').trim();
}

// Map the on-disk UI file URL back to its novadm:// address (so the omnibox stays clean).
function internalUrl(u) {
  if (!/^file:/i.test(u || '')) return '';
  const m = /[\\/]ui[\\/](\w+)\.html(?:[?#]|$)/.exec(u || '');
  return m ? 'novadm://' + (m[1] === 'newtab' ? 'newtab' : m[1]) : '';
}

function displayUrl(u) { return (u || '').startsWith('novadm://') ? '' : (u || ''); }

module.exports = { Browser, NEWTAB, onePerWindow };
