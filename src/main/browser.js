'use strict';
// Tab manager: one WebContentsView per tab, navigation, the pop-up guard, site permissions, and
// the media sniffer (request-header capture + response classification into the media registry).
const path = require('path');
const { EventEmitter } = require('events');
const { app, WebContentsView, session: electronSession, ipcMain } = require('electron');
const net = require('./net');
const { shortcutFor } = require('./shortcuts');

const DETECT_PRELOAD = path.join(__dirname, 'detect-preload.js');
const SHIELD_PRELOAD = path.join(__dirname, 'shield-preload.js');
const NEWTAB = 'novadm://newtab';
// novadm:// pages and their tab titles.
const INTERNAL_PAGES = new Map([
  ['newtab', 'New tab'], ['downloads', 'Downloads'], ['settings', 'Settings'], ['history', 'History'],
  ['bookmarks', 'Bookmarks'], ['reader', 'Reader view'],
]);

class Browser extends EventEmitter {
  constructor({ settings, media, adblock, popup }) {
    super();
    this.settings = settings;
    this.media = media;
    this.adblock = adblock;
    this.popup = popup;
    this.tabs = new Map(); // tabId -> tab
    this.order = [];
    this.activeId = null;
    this.bounds = { x: 0, y: 0, width: 800, height: 600 };
    this._seq = 0;
    // WebRTC: local network addresses hidden; with a proxy, nothing bypasses it (setWebRTCPolicy).
    this.webrtcPolicy = 'default_public_interface_only';
    // A plain Chrome name everywhere (pages, request headers): sites and bot checks refuse "Electron".
    app.userAgentFallback = cleanUserAgent(app.userAgentFallback);
    this.normalSession = electronSession.fromPartition('persist:browser');
    this.incognitoSession = electronSession.fromPartition('novadm-incognito');
    this._sessionsReady = new Set();
    this.closed = []; // recently closed tabs (Ctrl+Shift+T)
    this._nonGet = new Map(); // url -> time: recent POST/PUT responses (their downloads can't be re-requested)
    this.parentView = null; // set by main: the BaseWindow contentView to add tab views to
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
    ses.registerPreloadScript({ type: 'frame', filePath: SHIELD_PRELOAD }); // Tor-style protections (hardening.js)
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

  /**
   * `lazy` (background tabs only): the tab is listed but its page loads when it is first selected
   * (restored tabs), like an unloaded tab.
   */
  createTab({ url = NEWTAB, incognito = false, background = false, openerPartition, lazy = false, title = '' } = {}) {
    const id = ++this._seq;
    const tab = {
      id, view: null, wc: null, wcId: null, incognito, url: '', title: title || 'New tab', favicon: '',
      loading: false, canGoBack: false, canGoForward: false, secure: false, muted: false,
      discarded: false, saved: null, hiddenAt: Date.now(), readable: false,
    };
    this.tabs.set(id, tab);
    if (openerPartition != null) { const i = this.order.indexOf(openerPartition); this.order.splice(i >= 0 ? i + 1 : this.order.length, 0, id); }
    else this.order.push(id);
    if (lazy && background) {
      tab.url = normalizeUrl(url, this.settings);
      tab.secure = tab.url.startsWith('https:');
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
      if (tab.discarded || tab.id === this.activeId || !tab.wc || tab.wc.isDestroyed()) continue;
      if (now - (tab.hiddenAt || now) < minutes * 60000) continue;
      if (tab.loading || tab.wc.isCurrentlyAudible() || tab.keepLoaded) continue;
      if (this.discard(tab.id)) out.push(tab.id);
    }
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
      tab.secure = url.startsWith('https:');
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
    wc.session.setPermissionCheckHandler((wcc, permission, origin) => this.checkPermission(origin, permission));

  }

  zoom(tab, action) {
    const wc = tab.wc;
    const level = action === 'zoom-reset' ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + (action === 'zoom-in' ? 0.5 : -0.5)));
    wc.setZoomLevel(level);
    this.emit('zoom', tab, Math.round(Math.pow(1.2, level) * 100));
  }

  /** Ctrl+Shift+T: the last closed (non-private) tab, back where it was. */
  reopenClosed() {
    const last = this.closed.pop();
    if (!last) return null;
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
            id: 'dom-' + Math.random(), url: m.url, method: 'GET', statusCode: 200,
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
        const background = disposition === 'background-tab' || !!(click && click.mods);
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
    const stored = this.getStoredPermission(origin, permission);
    if (stored === 'granted') return callback(true);
    if (stored === 'denied') return callback(false);
    const auto = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
    if (auto.has(permission)) return callback(true);
    this.emit('permission-ask', { tabId: tab.id, origin, permission }, callback);
  }

  checkPermission(origin, permission) {
    const stored = this.getStoredPermission(originOf(origin), permission);
    return stored === 'granted';
  }

  getStoredPermission(origin, permission) {
    const all = this.settings.get('sitePermissions') || {};
    return all[origin] && all[origin][permission];
  }

  setPermission(origin, permission, value) {
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
      tab.url = 'novadm://' + page; tab.title = INTERNAL_PAGES.get(page);
      tab.wc.loadFile(path.join(__dirname, '..', 'ui', `${page}.html`), { query }).catch(() => {});
    } else {
      tab.url = target;
      tab.wc.loadURL(target).catch(() => {});
    }
  }

  /** Show an internal page (e.g. 'downloads'): reuse its tab if one is open, else open a new tab. */
  openInternal(page) {
    const url = 'novadm://' + page;
    for (const id of this.order) {
      const t = this.tabs.get(id);
      if (t && t.url === url && !t.incognito) { this.selectTab(id); return id; }
    }
    return this.createTab({ url });
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
    if (!tab.incognito && /^(https?|novadm):/i.test(tab.url || '')) {
      let saved = tab.saved;
      try { if (tab.wc) saved = { entries: tab.wc.navigationHistory.getAllEntries(), index: tab.wc.navigationHistory.getActiveIndex() }; } catch {}
      this.closed.push({ url: tab.url, title: tab.title, saved });
      if (this.closed.length > 25) this.closed.shift();
    }
    if (tab.view) { try { if (this.parentView) this.parentView.removeChildView(tab.view); } catch {} }
    if (tab.wc) { try { tab.wc.close(); } catch {} }
    if (this.shuttingDown) { this.emitTabs(); return; } // window closing: no replacement tab
    if (this.activeId === id) {
      const next = this.order[idx] || this.order[idx - 1] || null;
      this.activeId = null;
      if (next != null) this.selectTab(next);
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
    };
  }

  emitTabs() { this.emit('tabs', this.order.map((id) => this.serializeTab(this.tabs.get(id))).filter(Boolean), this.activeId); }
  emitActive() { const t = this.activeTab(); if (t) this.emit('active', this.serializeTab(t)); }

  destroy() {
    for (const tab of this.tabs.values()) { if (tab.wc) { try { tab.wc.close(); } catch {} } }
    this.tabs.clear(); this.order = [];
  }
}

function guessMime(m) {
  const ext = (/\.([a-z0-9]{1,5})(\?|#|$)/i.exec(m.url) || [])[1];
  const map = { m3u8: 'application/vnd.apple.mpegurl', mpd: 'application/dash+xml', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', vtt: 'text/vtt', srt: 'application/x-subrip' };
  return map[(ext || '').toLowerCase()] || (m.kind === 'audio' ? 'audio/mpeg' : m.kind === 'video' ? 'video/mp4' : 'application/octet-stream');
}

function originOf(u) { try { return new URL(u).origin; } catch { return u || ''; } }

// "… Chrome/152.0.0.0 novadm/0.1.0 Electron/44.7.0 Safari/537.36" -> "… Chrome/152.0.0.0 Safari/537.36"
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

function normalizeUrl(input, settings) {
  let s = String(input || '').trim();
  if (!s) return NEWTAB;
  if (s.startsWith('novadm://') || s.startsWith('about:') || /^view-source:https?:/i.test(s)) return s;
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s)) return s;
  // A single token with a dot and no spaces is treated as a domain; otherwise search.
  const looksDomain = /^[^\s]+\.[^\s]{2,}(\/|$|:)/.test(s) || s.startsWith('localhost');
  if (looksDomain && !s.includes(' ')) return 'https://' + s;
  return settings.searchUrl(s);
}

module.exports = { Browser, NEWTAB };
