'use strict';
// Tab manager: one WebContentsView per tab, navigation, the pop-up guard, site permissions, and
// the media sniffer (request-header capture + response classification into the media registry).
const path = require('path');
const { EventEmitter } = require('events');
const { WebContentsView, session: electronSession, ipcMain } = require('electron');
const net = require('./net');
const { siteOf, hostOf } = require('./util');

const DETECT_PRELOAD = path.join(__dirname, 'detect-preload.js');
const NEWTAB = 'novadm://newtab';

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
    this.normalSession = electronSession.fromPartition('persist:browser');
    this.incognitoSession = electronSession.fromPartition('novadm-incognito');
    this._sessionsReady = new Set();
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

  createTab({ url = NEWTAB, incognito = false, background = false, openerPartition } = {}) {
    const id = ++this._seq;
    const ses = incognito ? this.incognitoSession : this.normalSession;
    this.prepareSession(ses);
    const view = new WebContentsView({
      webPreferences: {
        session: ses, preload: DETECT_PRELOAD, contextIsolation: true, sandbox: true,
        nodeIntegration: false, backgroundThrottling: true, spellcheck: true,
        enablePreferredSizeMode: false,
      },
    });
    view.setBackgroundColor('#ffffff');
    const wc = view.webContents;
    const tab = {
      id, view, wc, wcId: wc.id, incognito, url: '', title: 'New tab', favicon: '',
      loading: false, canGoBack: false, canGoForward: false, secure: false, muted: false,
    };
    this.tabs.set(id, tab);
    if (openerPartition != null) { const i = this.order.indexOf(openerPartition); this.order.splice(i >= 0 ? i + 1 : this.order.length, 0, id); }
    else this.order.push(id);
    this.wireTab(tab);
    if (this.parentView) { this.parentView.addChildView(view); if (this.onRestack) this.onRestack(); }
    this.emit('tab-created', tab);
    this.loadInTab(tab, url);
    if (!background || this.activeId == null) this.selectTab(id);
    else view.setVisible(false);
    this.emitTabs();
    return id;
  }

  wireTab(tab) {
    const wc = tab.wc;
    const update = () => this.refreshTabState(tab);
    wc.on('page-title-updated', (_e, title) => { tab.title = title; update(); });
    wc.on('did-start-loading', () => { tab.loading = true; update(); });
    wc.on('did-stop-loading', () => { tab.loading = false; update(); });
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
      update();
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      // -3 = aborted (user navigated away / download started): not an error.
      if (!isMain || code === -3 || !/^https?:/i.test(url)) return;
      tab.failed = { url, code, desc };
      tab.loading = false;
      wc.loadFile(path.join(__dirname, '..', 'ui', 'error.html'), { query: { u: url, c: String(code), d: desc || '' } }).catch(() => {});
    });
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) { tab.url = internalUrl(url) || url; update(); } });
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
    const target = normalizeUrl(url, this.settings);
    if (target.startsWith('novadm://')) {
      const page = target.slice('novadm://'.length).split(/[?#]/)[0] || 'newtab';
      tab.url = target; tab.title = page === 'newtab' ? 'New tab' : page;
      tab.wc.loadFile(path.join(__dirname, '..', 'ui', `${page}.html`)).catch(() => {});
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
    return [...this.tabs.values()].filter((t) => t.url === url && !t.wc.isDestroyed());
  }

  navigate(tabId, input) {
    const tab = this.tabs.get(tabId || this.activeId);
    if (!tab) return;
    this.loadInTab(tab, input);
  }

  selectTab(id) {
    if (!this.tabs.has(id)) return;
    if (this.activeId != null && this.tabs.has(this.activeId)) this.tabs.get(this.activeId).view.setVisible(false);
    this.activeId = id;
    const tab = this.tabs.get(id);
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
    if (this.adblock) this.adblock.removeTab(tab.wcId);
    this.media.removeTab(tab.id);
    try { if (this.parentView) this.parentView.removeChildView(tab.view); } catch {}
    try { tab.wc.close(); } catch {}
    if (this.shuttingDown) { this.emitTabs(); return; } // window closing: no replacement tab
    if (this.activeId === id) {
      const next = this.order[idx] || this.order[idx - 1] || null;
      this.activeId = null;
      if (next != null) this.selectTab(next);
      else this.createTab({ url: NEWTAB });
    }
    this.emitTabs();
  }

  back(id) { const t = this.tabs.get(id || this.activeId); if (t && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack(); }
  forward(id) { const t = this.tabs.get(id || this.activeId); if (t && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward(); }
  reload(id) {
    const t = this.tabs.get(id || this.activeId);
    if (!t) return;
    // On the error page, retry the address that failed rather than reloading the error page.
    if (internalUrl(t.wc.getURL()) === 'novadm://error' && t.failed) this.loadInTab(t, t.failed.url);
    else t.wc.reload();
  }
  stop(id) { const t = this.tabs.get(id || this.activeId); if (t) t.wc.stop(); }

  activeTab() { return this.tabs.get(this.activeId); }

  refreshTabState(tab) {
    try {
      tab.canGoBack = tab.wc.navigationHistory.canGoBack();
      tab.canGoForward = tab.wc.navigationHistory.canGoForward();
    } catch {}
    this.emit('tab-updated', this.serializeTab(tab));
    if (tab.id === this.activeId) this.emitActive();
  }

  serializeTab(tab) {
    return {
      id: tab.id, title: tab.title || 'New tab', url: displayUrl(tab.url), favicon: tab.favicon,
      loading: tab.loading, incognito: tab.incognito, secure: tab.secure,
      canGoBack: tab.canGoBack, canGoForward: tab.canGoForward, active: tab.id === this.activeId,
    };
  }

  emitTabs() { this.emit('tabs', this.order.map((id) => this.serializeTab(this.tabs.get(id))).filter(Boolean), this.activeId); }
  emitActive() { const t = this.activeTab(); if (t) this.emit('active', this.serializeTab(t)); }

  destroy() {
    for (const tab of this.tabs.values()) { try { tab.wc.close(); } catch {} }
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
  const m = /[\\/]ui[\\/](\w+)\.html$/.exec(u || '');
  return m ? 'novadm://' + (m[1] === 'newtab' ? 'newtab' : m[1]) : '';
}

function displayUrl(u) { return (u || '').startsWith('novadm://') ? '' : (u || ''); }

function normalizeUrl(input, settings) {
  let s = String(input || '').trim();
  if (!s) return NEWTAB;
  if (s.startsWith('novadm://') || s.startsWith('about:')) return s;
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s)) return s;
  // A single token with a dot and no spaces is treated as a domain; otherwise search.
  const looksDomain = /^[^\s]+\.[^\s]{2,}(\/|$|:)/.test(s) || s.startsWith('localhost');
  if (looksDomain && !s.includes(' ')) return 'https://' + s;
  return settings.searchUrl(s);
}

module.exports = { Browser, NEWTAB };
