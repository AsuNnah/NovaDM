'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BaseWindow, WebContentsView, shell, ipcMain, protocol, dialog, session: electronSession, nativeTheme, safeStorage } = require('electron');
const { Settings } = require('./settings');
const { AdBlocker } = require('./adblock');
const { PopupGuard } = require('./popup');
const { MediaRegistry } = require('./media/registry');
const { DownloadManager } = require('./download/manager');
const { Transport } = require('./transport');
const { AddFlow, specFromUrl } = require('./add-flow');
const { ClipboardWatcher } = require('./clipboard-watch');
const { notify } = require('./notify');
const { applyProxy, proxyCredentials, encryptPassword } = require('./proxy');
const { Scheduler } = require('./scheduler');
const { Background } = require('./background');
const { FFmpeg } = require('./ffmpeg');
const { Aria2 } = require('./torrent/aria2');
const { LocalApi, parseLaunchArgs } = require('./api');
const { YtDlp } = require('./ytdlp');
const { SiteExtensions } = require('./site-ext');
const { siteSettingsFor } = require('./rules');
const hooks = require('./hooks');
const { HttpDownload } = require('./download/http');
const util = require('./util');
const { Browser } = require('./browser');
const net = require('./net');
const { registerIpc } = require('./ipc');
const { applySecureDns, PROVIDERS } = require('./dns');
const { showContextMenu } = require('./contextmenu');
const { setupBrowsing } = require('./browsing');
const { shortcutFor, LIST: SHORTCUT_LIST } = require('./shortcuts');
const hardening = require('./hardening');
// Must load before the app is ready (registers the crx:// scheme for extension icons).
const { Extensions } = require('./extensions');

let dnsStatus = { mode: 'starting', servers: [] };

// Test runs use their own profile so they never touch the user's settings or downloads.
if (process.env.NOVADM_USERDATA) app.setPath('userData', process.env.NOVADM_USERDATA);
else migrateOldProfile();

// One NovaDM at a time (per profile): starting it again brings the running one forward.
// Third-party cookies (Settings → Privacy) use Chromium's own switch, which must be set before
// Chromium starts: read straight from the settings file. Blocked unless turned off.
try {
  const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8'));
  if (saved.blockThirdPartyCookies !== false) app.commandLine.appendSwitch('test-third-party-cookie-phaseout');
  // Security level Safer / Safest: no JIT compiler (like Tor Browser). Applies to every page.
  if (['safer', 'safest'].includes(saved.securityLevel)) app.commandLine.appendSwitch('js-flags', '--jitless');
} catch { app.commandLine.appendSwitch('test-third-party-cookie-phaseout'); }

const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();
// A second start (command line, novadm:// link, magnet link, .torrent file) hands its arguments over.
app.on('second-instance', (_e, argv) => { showWindow(); if (addFlow) handleLaunch(argv); });
// Started by Windows at sign-in: stay in the tray.
const startHidden = process.argv.includes('--hidden');

// The app was called "Swoop" before 0.2.0: move that profile (settings, downloads list,
// extensions, cookies) to NovaDM's folder once, if NovaDM has none yet.
function migrateOldProfile() {
  try {
    const oldDir = path.join(app.getPath('appData'), 'Swoop');
    const newDir = app.getPath('userData');
    if (oldDir.toLowerCase() === newDir.toLowerCase() || !fs.existsSync(oldDir) || fs.existsSync(newDir)) return;
    try { fs.renameSync(oldDir, newDir); } catch { fs.cpSync(oldDir, newDir, { recursive: true }); }
  } catch (e) {
    console.error('profile migration failed', e);
  }
}

const UI_DIR = path.join(__dirname, '..', 'ui');
const UI_PRELOAD = path.join(UI_DIR, 'preload-ui.js');

let win, chromeView, overlayView;
let settings, adblock, popup, media, downloads, browser, addFlow, clipboardWatcher, transport, scheduler, background, ffmpeg, aria2, api, ytdlp, siteExt, browsing;
const extensions = new Extensions();
if (process.env.NOVADM_SELFTEST) global.__novadmExtensions = extensions; // test access only
let panelOpen = false;

function contentBounds() {
  const [w, h] = win.getContentSize();
  const top = browsing.chromeHeight();
  return { x: 0, y: top, width: w, height: Math.max(0, h - top) };
}

function layout() {
  if (!win || win.isDestroyed() || !chromeView) return;
  const [w] = win.getContentSize();
  chromeView.setBounds({ x: 0, y: 0, width: w, height: browsing.chromeHeight() });
  const cb = contentBounds();
  overlayView.setBounds(cb);
  browser.setBounds(cb);
  if (browsing.findView) browsing.findView.setBounds(browsing.findBounds(cb));
}

function restack() {
  // Keep z-order: page tab (bottom) < find bar < overlay < chrome (top). Nothing to do once the
  // window is gone (tabs are still being closed while NovaDM quits).
  if (!win || win.isDestroyed()) return;
  const root = win.contentView;
  if (browsing && browsing.findView) { try { root.addChildView(browsing.findView); } catch {} }
  try { root.addChildView(overlayView); } catch {}
  try { root.addChildView(chromeView); } catch {}
}

function sendUI(name, data) {
  for (const v of [chromeView, overlayView]) {
    if (v && !v.webContents.isDestroyed()) v.webContents.send('novadm:event', name, data);
  }
}

function setPanel(open) {
  panelOpen = open;
  overlayView.setVisible(open);
  if (open) restack();
}

function showWindow() {
  if (!app.isReady()) return;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BaseWindow({
    width: 1280, height: 820, minWidth: 680, minHeight: 480, frame: false,
    backgroundColor: '#1b1d22', title: 'NovaDM', show: !startHidden,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
  });

  chromeView = new WebContentsView({ webPreferences: { preload: UI_PRELOAD, contextIsolation: true, sandbox: false } });
  chromeView.setBackgroundColor('#00000000');
  chromeView.webContents.loadFile(path.join(UI_DIR, 'chrome.html'));

  overlayView = new WebContentsView({ webPreferences: { preload: UI_PRELOAD, contextIsolation: true, sandbox: false, transparent: true } });
  overlayView.setBackgroundColor('#00000000');
  overlayView.webContents.loadFile(path.join(UI_DIR, 'panel.html'));
  overlayView.setVisible(false);

  win.contentView.addChildView(chromeView);
  win.contentView.addChildView(overlayView);
  browsing.createFindView(win.contentView);

  browser.setParentView(win.contentView);
  browser.onRestack = restack;

  layout();
  win.on('resize', layout);
  win.on('close', (e) => {
    // Downloads running: keep going in the tray instead of quitting (Settings → Background).
    if (background && background.keepRunningOnClose()) { e.preventDefault(); background.hideToTray(); return; }
    browser.shuttingDown = true;
  });
  win.on('closed', () => { browser.shuttingDown = true; win = null; });

  // Open links that must leave the app (none by default) in the OS browser.
  chromeView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // The tabs from last time (Settings → Restore tabs), or a new tab. NOVADM_OPEN (debug) opens a
  // given address instead.
  browsing.openStartTabs(process.env.NOVADM_OPEN || '');
}

function wireEvents() {
  browser.on('tabs', (tabs, activeId) => sendUI('tabs', { tabs, activeId }));
  browser.on('active', (tab) => { sendUI('active-tab', tab); refreshChromeIndicators(tab); });
  browser.on('tab-updated', (tab) => { if (tab.active) refreshChromeIndicators(tab); sendUI('tab-updated', tab); });
  browser.on('popup-ask', (info) => {
    // Only ask about the tab you're looking at; background tabs' pop-ups are blocked.
    if (info.tabId !== browser.activeId) { browser.emit('popup-blocked', info.tabId, info.url, 'background'); return; }
    setPanel(true);
    sendUI('popup-ask', info);
  });
  browser.on('popup-blocked', (tabId, url, reason) => {
    const list = blockedPopups.get(tabId) || [];
    const tab = browser.tabs.get(tabId);
    list.push({ url, reason, pageUrl: tab ? tab.url : '' });
    blockedPopups.set(tabId, list.slice(-20));
    sendPopupState();
  });
  browser.on('page-changed', (tabId) => { blockedPopups.delete(tabId); sendPopupState(); });
  browser.on('context-menu', (tab, params) => showContextMenu({ tab, params, browser, downloads, settings, extensions, win, addDownload: (spec, o) => addFlow.request(spec, o) }));
  browser.on('download', onPageDownload);
  browser.on('page-loaded', (tab) => { runSiteExtensions(tab); if (/^novadm:\/\//.test(tab.url || '')) styleUi(tab.wc); });
  browser.on('shortcut', (tab, action) => handleShortcut(tab, action));
  browser.on('download-link', (tab, url) => addFlow.request(specFromUrl(url, { pageUrl: tab.url, incognito: tab.incognito }), { origin: 'page' }));
  browser.on('magnet', (tab, url) => addFlow.requestLinks([url], { origin: 'page', pageUrl: tab.url, incognito: tab.incognito }));
  // Chrome extensions see normal (not private) tabs.
  browser.on('tab-created', (tab) => { if (extensions.ready && !tab.incognito) extensions.addTab(tab.wc, win); });
  browser.on('tab-selected', (tab) => { if (extensions.ready && !tab.incognito) extensions.selectTab(tab.wc); });
  browser.on('permission-ask', (info, cb) => {
    if (pendingPermission) { try { pendingPermission.cb(false); } catch {} }
    pendingPermission = { info, cb };
    setPanel(true);
    sendUI('permission-ask', info);
  });
  browser.on('download-video-request', (tabId) => downloadBestVideo(tabId));

  media.on('changed', (tabId) => {
    if (browser.activeId === tabId) sendMediaState();
    refreshFromMedia(tabId);
  });
  adblock.on('blocked', (wcId, n) => {
    const tab = browser.activeTab();
    if (tab && tab.wcId === wcId) sendUI('adblock-count', { count: n });
  });
  downloads.on('changed', () => sendUI('downloads', { list: downloads.list(), summary: downloads.activeSummary() }));
  downloads.on('completed', (rec) => {
    sendUI('download-complete', { name: rec.name, id: rec.id });
    afterDownloadHooks('finished', rec);
    if (rec.scan === 'threat') {
      // Always shown, whatever the notification setting.
      notify({ title: 'Microsoft Defender found a threat', body: `${rec.name}: ${rec.scanDetail || 'threat'}`, onClick: () => { showWindow(); browser.openInternal('downloads'); } });
      return;
    }
    if (!settings.get('notifyOnComplete')) return;
    const bad = rec.verify === 'mismatch';
    notify({
      title: bad ? 'Download finished, but the checksum does not match' : 'Download finished',
      body: rec.name,
      // Programs and archives open their folder; other files open directly.
      onClick: () => (['programs', 'archives'].includes(rec.category) || bad ? shell.showItemInFolder(rec.savePath) : shell.openPath(rec.savePath)),
    });
  });
  downloads.on('failed', (rec) => {
    afterDownloadHooks('failed', rec);
    if (rec.errorCode === 'NEEDS_FFMPEG') {
      notify({ title: 'This video needs FFmpeg', body: 'Install it in Settings → Add-ons, then retry the download.', onClick: () => { showWindow(); browser.openInternal('settings'); } });
      return;
    }
    if (!settings.get('notifyOnComplete')) return;
    notify({
      title: 'Download failed', body: `${rec.name}: ${rec.error || 'error'}`,
      onClick: () => { if (win) { win.focus(); browser.openInternal('downloads'); } },
    });
  });
}

// A page started a download (link to a file, Content-Disposition: attachment...). Web links go to
// NovaDM's own engine; anything it can't fetch again (blob:/data: links, form POST answers) stays
// with the browser, saved straight into the download folder and shown in the list.
function onPageDownload(event, item, info) {
  const http = /^https?:\/\//i.test(info.url);
  // A .torrent file: open the torrent in NovaDM (asking which files) instead of saving the .torrent.
  if (http && settings.get('openTorrentFiles') !== false && (info.mime === 'application/x-bittorrent' || /\.torrent$/i.test(info.name || ''))) {
    event.preventDefault();
    const ses = info.incognito ? browser.incognitoSession : browser.normalSession;
    net.fetchBuffer(info.url, { session: ses, headers: info.pageUrl ? { referer: info.pageUrl } : {}, maxBytes: 20 * 1024 * 1024, timeoutMs: 20000 })
      .then((r) => {
        const res = addFlow.requestTorrentFile(r.body, { origin: 'page', pageUrl: info.pageUrl, tabId: info.tabId, incognito: info.incognito });
        if (res && res.ok === false) notify({ title: 'Not a torrent file', body: res.error });
      })
      .catch((e) => notify({ title: 'Could not open the torrent', body: e.message }));
    return;
  }
  if (http && !info.viaPost) {
    event.preventDefault();
    addFlow.request({
      kind: 'http', url: info.url, sources: [info.url], name: info.name || '', size: info.size, mime: info.mime,
      headers: info.pageUrl && /^https?:/i.test(info.pageUrl) ? { referer: info.pageUrl } : {}, pageUrl: info.pageUrl,
      tabId: info.tabId, incognito: info.incognito, allowRename: !info.name,
    }, { origin: 'page' });
    return;
  }
  const name = util.sanitizeFilename(info.name || 'download');
  const dir = downloads.categoryDir(util.categoryOf(name, info.mime));
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  item.setSavePath(util.uniquePath(path.join(dir, name), downloads.reservedPaths()));
  downloads.addNative(item, info);
}

// Sign-in for a site from the per-site settings (password decrypted only here, when needed).
function siteCredentials(host) {
  const s = siteSettingsFor(settings.get('siteSettings'), 'https://' + host);
  if (!s || !s.user) return null;
  let pass = '';
  try { if (s.passEnc) pass = safeStorage.decryptString(Buffer.from(s.passEnc, 'base64')); } catch {}
  return { user: s.user, pass };
}

// Theme (system / dark / light) for NovaDM and the pages it shows, and the accent colour of its own UI.
const uiCssKeys = new Map();
function accentCss() {
  const c = /^#[0-9a-f]{6}$/i.test(settings.get('accent') || '') ? settings.get('accent') : '#5b7cfa';
  const dark = '#' + [1, 3, 5].map((i) => Math.round(parseInt(c.slice(i, i + 2), 16) * 0.82).toString(16).padStart(2, '0')).join('');
  return `:root{--accent:${c} !important;--accent2:${dark} !important;}`;
}
async function styleUi(wc) {
  if (!wc || wc.isDestroyed()) return;
  const old = uiCssKeys.get(wc.id);
  if (old) { try { await wc.removeInsertedCSS(old); } catch {} }
  try { uiCssKeys.set(wc.id, await wc.insertCSS(accentCss())); } catch {}
}
function applyAppearance() {
  nativeTheme.themeSource = ['dark', 'light'].includes(settings.get('theme')) ? settings.get('theme') : 'system';
  for (const v of [chromeView, overlayView]) if (v) styleUi(v.webContents);
  for (const t of browser.tabs.values()) if (/^novadm:\/\//.test(t.url || '')) styleUi(t.wc);
}

// After a download: the user's program and webhook (Settings → After a download).
function afterDownloadHooks(event, rec) {
  if (rec.kind === 'convert') return;
  if (event === 'finished' && settings.get('afterProgram')) {
    hooks.runProgram(settings.get('afterProgram'), settings.get('afterArgs'), rec).then((r) => { if (!r.ok) notify({ title: 'Could not start your program', body: r.error }); });
  }
  if (settings.get('webhookUrl')) hooks.sendWebhook(settings.get('webhookUrl'), event, rec).then((r) => { if (!r.ok) console.error('webhook', r.error || r.status); });
}

// Site extensions made for this page: their findings go to the media panel.
function runSiteExtensions(tab) {
  if (!siteExt || !/^https?:/i.test(tab.url || '')) return;
  const url = tab.url;
  const session = tab.incognito ? browser.incognitoSession : browser.normalSession;
  siteExt.resolvePage({ url, title: tab.title, session }).then((results) => {
    if (!browser.tabs.has(tab.id) || tab.url !== url) return;
    for (const r of results) {
      if (r.error) console.error(`site extension ${r.ext}: ${r.error}`);
      for (const it of r.items) media.addExternal(tab.id, it, r.ext);
    }
  }).catch(() => {});
}

// One sandboxed page per run: no Node, an empty in-memory cookie jar, no network (CSP), no
// navigation or pop-ups; it can only talk to the site-extension bridge.
const siteExtSandboxes = new Map();
function createSiteExtSandbox() {
  const view = new WebContentsView({
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'novadm-siteext',
      preload: path.join(__dirname, 'siteext-preload.js'), images: false, webgl: false, spellcheck: false, backgroundThrottling: false,
    },
  });
  const wc = view.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.session.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  const box = {
    webContents: wc, onResult: null,
    run(job) { wc.loadFile(path.join(UI_DIR, 'siteext-host.html')).then(() => wc.send('siteext:run', job)).catch((e) => box.onResult && box.onResult({ error: e.message })); },
    destroy() { siteExtSandboxes.delete(wc.id); try { wc.close(); } catch {} },
  };
  siteExtSandboxes.set(wc.id, box);
  return box;
}
ipcMain.on('siteext:done', (e, r) => { const box = siteExtSandboxes.get(e.sender.id); if (box && box.onResult) box.onResult(r); });
ipcMain.handle('siteext:fetch', (e, url, opts) => siteExt.fetchFor(e.sender.id, url, opts));

// Links and files NovaDM was started with. novadm:// links always show the New download dialog.
function handleLaunch(argv) {
  for (const item of parseLaunchArgs(argv.slice(1))) {
    if (item.torrentFile) {
      try { addFlow.requestTorrentFile(fs.readFileSync(item.torrentFile), { origin: 'link' }); } catch (e) { notify({ title: 'Could not open the torrent', body: e.message }); }
      continue;
    }
    const spec = specFromUrl(item.url, { pageUrl: item.referer || '' });
    if (item.name) spec.name = item.name;
    if (item.start) downloads.add(spec);
    else addFlow.request(spec, { origin: 'link' });
  }
}

let apiStatus = { running: false };
let toolDownloadRef = null;

// novadm:// links (and, if the user wants, magnet: links) from other apps open NovaDM. Never from
// test runs; in development the app folder is passed along.
function registerLinkHandlers() {
  if (process.env.NOVADM_USERDATA || process.platform !== 'win32') return;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  try {
    app.setAsDefaultProtocolClient('novadm', exe, args);
    if (settings.get('magnetHandler')) app.setAsDefaultProtocolClient('magnet', exe, args);
    else if (app.isDefaultProtocolClient('magnet', exe, args)) app.removeAsDefaultProtocolClient('magnet', exe, args);
  } catch (e) { console.error('link handlers', e.message); }
}

// Refresh link for a stream: when the page opened for it plays the video again, take the new playlist.
function refreshFromMedia(tabId) {
  const id = addFlow.armedFor(tabId);
  if (id == null) return;
  const rec = downloads.get(id);
  if (!rec || rec.kind !== 'hls') return;
  const item = media.list(tabId).items.find((i) => i.kind === 'hls' && i.encryption !== 'drm');
  if (!item) return;
  const full = media.get(tabId, item.id);
  const want = rec.meta && rec.meta.height;
  const variant = (full.variants || []).find((v) => v.resolution && v.resolution.height === want) || (full.variants || [])[0];
  addFlow.request({ kind: 'hls', playlistUrl: variant ? variant.url : full.url, headers: full.headers, tabId }, { origin: 'media' });
}

let pendingPermission = null;
let ipcHandlers = {};
const blockedPopups = new Map(); // tabId -> [{ url, reason, pageUrl }]

function sendPopupState() {
  const list = blockedPopups.get(browser.activeId) || [];
  sendUI('popups-blocked', { count: list.length, last: list[list.length - 1] || null });
}

function reviewBlockedPopup() {
  const list = blockedPopups.get(browser.activeId) || [];
  const last = list.pop();
  if (!last) return;
  sendPopupState();
  setPanel(true);
  sendUI('popup-ask', { tabId: browser.activeId, pageUrl: last.pageUrl, url: last.url, reviewed: true, reason: last.reason });
}

// Keyboard shortcuts (shortcuts.js), from a page or from NovaDM's own views.
function handleShortcut(tab, action) {
  if (!tab) return;
  const wc = tab.wc;
  const pick = (i) => { if (browser.order[i] != null) browser.selectTab(browser.order[i]); };
  switch (action) {
    case 'find': return browsing.openFind();
    case 'find-next': case 'find-prev': return browsing.findOpen ? sendFindStep(action === 'find-next') : browsing.openFind();
    case 'bookmark': return browsing.toggleActiveBookmark();
    case 'bookmark-all': return ipcHandlers['bookmarks.addAllTabs']();
    case 'bookmarks-bar': return ipcHandlers['bookmarks.setBar']({ show: settings.get('showBookmarksBar') === false });
    case 'bookmarks': return browser.openInternal('bookmarks');
    case 'history': return browser.openInternal('history');
    case 'downloads': return browser.openInternal('downloads');
    case 'clear-data': return browser.createTab({ url: 'novadm://history?clear=1' });
    case 'new-tab': return browser.createTab({ incognito: tab.incognito });
    case 'new-private': return browser.createTab({ incognito: true });
    case 'close-tab': return browser.closeTab(tab.id);
    case 'close-window': return win && win.close();
    case 'reopen-tab': return browser.reopenClosed();
    case 'focus-address': chromeView.webContents.focus(); return sendUI('focus-address', {});
    case 'reload': return browser.reload(tab.id);
    case 'hard-reload': return wc && wc.reloadIgnoringCache();
    case 'stop': return browser.stop(tab.id);
    case 'back': return browser.back(tab.id);
    case 'forward': return browser.forward(tab.id);
    case 'home': return browser.navigate(tab.id, settings.get('homepage') || 'novadm://newtab');
    case 'next-tab': case 'prev-tab': {
      const n = browser.order.length;
      return pick((browser.order.indexOf(tab.id) + (action === 'next-tab' ? 1 : n - 1)) % n);
    }
    case 'tab-last': return pick(browser.order.length - 1);
    case 'fullscreen': return win && win.setFullScreen(!win.isFullScreen());
    case 'print': return wc && wc.print();
    case 'save-page': return wc && /^https?:/i.test(wc.getURL()) && wc.downloadURL(wc.getURL()); // to NovaDM's downloader
    case 'open-file': return openFileInTab();
    case 'view-source': return /^https?:/i.test(tab.url || '') && browser.createTab({ url: 'view-source:' + tab.url, openerPartition: tab.id });
    case 'devtools': return wc && wc.toggleDevTools(); // shortcut: Ctrl+Shift+J/C open DevTools too, not straight to Console / inspect mode
    case 'menu': setPanel(true); return sendUI('open-panel', { name: 'menu' });
    case 'task-manager': return showTaskManager();
    case 'shortcut-list': return showShortcutList();
    default:
      if (/^tab-[1-8]$/.test(action)) return pick(Number(action.slice(4)) - 1);
      if (action.startsWith('zoom') && wc) return browser.zoom(tab, action);
  }
}

async function openFileInTab() {
  const r = await dialog.showOpenDialog(win, { title: 'Open a file', properties: ['openFile'], filters: [{ name: 'Web pages and files', extensions: ['html', 'htm', 'pdf', 'txt', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'webm', 'mp3'] }] });
  if (!r.canceled && r.filePaths[0]) browser.createTab({ url: pathToFileURL(r.filePaths[0]).href });
}

// Shift+Esc: memory of each tab, and unloading the background ones.
async function showTaskManager() {
  const mem = new Map(app.getAppMetrics().map((m) => [m.pid, m.memory.workingSetSize]));
  const lines = browser.order.map((id) => browser.tabs.get(id)).map((t) => {
    const kb = t.wc && !t.wc.isDestroyed() ? mem.get(t.wc.getOSProcessId()) || 0 : 0;
    return `${t.discarded ? 'Unloaded' : `${Math.round(kb / 1024)} MB`}  ·  ${(t.title || t.url || 'New tab').slice(0, 70)}`;
  });
  const total = Math.round([...mem.values()].reduce((a, b) => a + b, 0) / 1024);
  const r = await dialog.showMessageBox(win, { type: 'info', title: 'Task manager', message: `NovaDM uses ${total} MB`, detail: lines.join('\n'), buttons: ['Unload background tabs', 'Close'], defaultId: 1, cancelId: 1 });
  if (r.response === 0) for (const id of browser.order) if (id !== browser.activeId) browser.discard(id);
}

function showShortcutList() {
  dialog.showMessageBox(win, { type: 'info', title: 'Keyboard shortcuts', message: 'Keyboard shortcuts', detail: SHORTCUT_LIST.map(([h, t]) => `${h}\n${t}`).join('\n\n'), buttons: ['OK'] });
}

// F3 / Ctrl+G while the find bar is open: next or previous match of what it holds.
function sendFindStep(forward) {
  if (browsing.findView) browsing.findView.webContents.executeJavaScript(`document.getElementById('${forward ? 'next' : 'prev'}').click()`).catch(() => {});
}

function refreshChromeIndicators(tab) {
  const count = adblock.count(tab.wcId);
  sendUI('adblock-count', { count });
  sendMediaState();
  sendPopupState();
}

function sendMediaState() {
  const tabId = browser.activeId;
  if (tabId == null) return;
  const data = media.list(tabId);
  sendUI('media', { count: media.count(tabId), ...data, ytdlp: !!(ytdlp && ytdlp.available()) });
}

// Turn a detected media item into a download.
function downloadItem(tabId, itemId, variantUrl) {
  const item = media.get(tabId, itemId);
  if (!item) return { ok: false, error: 'not found' };
  if (item.encryption === 'drm') return { ok: false, error: 'This video is DRM-protected and cannot be downloaded.' };
  const tab = browser.tabs.get(tabId);
  const list = media.list(tabId);
  const view = list.items.find((i) => i.id === itemId);
  const chosen = (item.variants || []).find((v) => v.url === variantUrl) || item.variants[0];
  const name = (view && (chosen ? view.variants.find((v) => v.url === chosen.url) : view)?.name) || view?.name;
  const add = (spec) => addFlow.request({ ...spec, tabId, incognito: !!(tab && tab.incognito) }, { origin: 'media' });
  if (item.kind === 'dash') {
    const res = chosen && chosen.resolution;
    add({
      kind: 'dash', name, playlistUrl: item.url, headers: item.headers, pageUrl: item.pageUrl,
      size: (chosen && chosen.sizeEstimate) || item.sizeEstimate, category: 'video',
      meta: { duration: item.duration || 0, width: res ? res.width : 0, height: res ? res.height : 0, videoId: chosen ? chosen.repId : '' },
    });
  } else if (item.kind === 'hls' && chosen && chosen.audioSeparate) {
    // Picture and sound are separate playlists: the master is needed to find both.
    const res = chosen.resolution;
    add({
      kind: 'hls', separateAudio: true, name, playlistUrl: item.url, headers: item.headers, pageUrl: item.pageUrl,
      size: chosen.sizeEstimate || item.sizeEstimate, category: 'video', convertTs: true,
      meta: { duration: chosen.duration || item.duration || 0, width: res ? res.width : 0, height: res ? res.height : 0 },
    });
  } else if (item.kind === 'hls') {
    const res = chosen && chosen.resolution;
    add({
      kind: 'hls', name, playlistUrl: chosen ? chosen.url : item.url, mirrors: item.mirrors,
      headers: item.headers, pageUrl: item.pageUrl, size: (chosen && chosen.sizeEstimate) || item.sizeEstimate,
      convertTs: settings.get('convertTsToMp4') !== false, category: 'video',
      meta: { duration: (chosen && chosen.duration) || item.duration || 0, width: res ? res.width : 0, height: res ? res.height : 0 },
    });
  } else {
    add({
      kind: 'http', name, url: item.url, sources: [item.url], mirrors: item.mirrors,
      headers: item.headers, pageUrl: item.pageUrl, size: item.size,
      mime: item.mime, category: item.kind === 'audio' ? 'music' : item.kind === 'subtitle' ? 'documents' : item.kind === 'file' ? undefined : 'video',
    });
  }
  return { ok: true };
}

function downloadBestVideo(tabId) {
  const { items } = media.list(tabId);
  const vid = items.find((i) => i.playing && (i.kind === 'hls' || i.kind === 'video')) || items.find((i) => i.kind === 'hls' || i.kind === 'video');
  if (vid) { downloadItem(tabId, vid.id); setPanel(true); sendUI('open-panel', { name: 'media' }); sendMediaState(); }
}

if (process.platform === 'win32') app.setAppUserModelId('app.novadm.browser');

app.whenReady().then(async () => {
  if (!isFirstInstance) return;
  settings = new Settings();
  // Secure DNS first, before any page loads (strict mode is set synchronously inside).
  applySecureDns(settings).then((s) => { dnsStatus = s; }).catch(() => {});
  settings.on('change', (c) => {
    if ('secureDns' in c || 'secureDnsCustom' in c) applySecureDns(settings).then((s) => { dnsStatus = s; }).catch(() => {});
  });
  popup = new PopupGuard(settings);
  media = new MediaRegistry({
    getSetting: (k) => settings.get(k),
    fetchText: async (url, opts) => {
      const r = await net.fetchText(url, { session: browser.normalSession, headers: opts.headers, timeoutMs: 20000 });
      return { text: r.text, finalUrl: r.finalUrl };
    },
  });
  adblock = new AdBlocker(settings);
  browser = new Browser({ settings, media, adblock, popup });
  browsing = setupBrowsing({
    settings, browser, net, userDataDir: app.getPath('userData'), sendUI, setPanel,
    getWindow: () => win, relayout: () => layout(), restack: () => restack(),
  });
  adblock.shields = browsing.shields;
  hardening.install(settings);
  adblock.protection = (url) => hardening.protectionFor(settings, url);
  transport = new Transport({ session: browser.normalSession, settings });
  downloads = new DownloadManager(settings, browser.normalSession, { transport, privateSession: browser.incognitoSession });
  addFlow = new AddFlow({ downloads, settings, browser, sendUI, setPanel, getWindow: () => win, notify });
  // Helper tools on demand (FFmpeg, aria2): downloaded with NovaDM's own engine (speed limit and
  // proxy apply) and checked before use.
  const toolText = async (url) => (await net.fetchText(url, { session: browser.normalSession, timeoutMs: 20000 })).text;
  const toolDownload = (url, savePath, onProgress = () => {}) => new Promise((resolve, reject) => {
    const dl = new HttpDownload({ id: 'tool', savePath, sources: [url], session: browser.normalSession, transport, limiter: downloads.limiter, connections: 8, retries: 5 });
    dl.on('progress', (p) => onProgress({ received: p.received, size: p.size }));
    dl.on('done', resolve);
    dl.on('error', reject);
    dl.start();
  });
  toolDownloadRef = toolDownload;
  ffmpeg = new FFmpeg({ settings, userDataDir: app.getPath('userData'), fetchText: toolText, download: toolDownload });
  downloads.ffmpeg = ffmpeg;
  aria2 = new Aria2({ settings, userDataDir: app.getPath('userData'), fetchText: toolText, download: toolDownload });
  downloads.aria2 = aria2;
  downloads.askTorrentFiles = (rec, files) => addFlow.askTorrentFiles(rec, files);
  ytdlp = new YtDlp({ settings, userDataDir: app.getPath('userData'), fetchText: toolText, download: toolDownload });
  siteExt = new SiteExtensions({
    settings, userDataDir: app.getPath('userData'), createSandbox: createSiteExtSandbox,
    fetchText: async (url, { headers, session }) => {
      const r = await net.fetchText(url, { session: session || browser.normalSession, headers, timeoutMs: 20000, maxBytes: 8 * 1024 * 1024 });
      return { status: r.status, url: r.finalUrl, text: r.text };
    },
    confirm: async (man) => {
          const r = await dialog.showMessageBox(win, {
        type: 'question', buttons: ['Install', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Install site extension',
        message: `Install "${man.name}" ${man.version}?`,
        detail: `${man.description ? man.description + '\n\n' : ''}It can read pages on:\n${man.matches.join('\n')}\n\nOnly install extensions from people you trust.`,
      });
      return r.response === 0;
    },
  });
  settings.on('change', (c) => { if (Object.keys(c).some((k) => k.startsWith('torrent'))) aria2.applySettings(); });

  // Local API (browser extension, scripts) and links from other apps.
  api = new LocalApi({ settings, downloads, addFlow, version: app.getVersion(), onAdd: () => showWindow() });
  api.update().then((st) => { apiStatus = st; });
  settings.on('change', (c) => {
    if ('apiEnabled' in c || 'apiPort' in c) api.update().then((st) => { apiStatus = st; });
    if ('magnetHandler' in c) registerLinkHandlers();
  });
  registerLinkHandlers();

  // Proxy for pages and downloads (system settings unless the user chose otherwise).
  const proxySessions = () => [browser.normalSession, browser.incognitoSession, electronSession.defaultSession];
  applyProxy(settings, proxySessions());
  settings.on('change', (c) => {
    if (Object.keys(c).some((k) => k.startsWith('proxy'))) applyProxy(settings, proxySessions()).then(() => transport.close());
  });
  net.setProxyCredentials(() => proxyCredentials(settings));
  net.setSiteCredentials((host) => siteCredentials(host));
  transport.proxyCredentials = () => proxyCredentials(settings);
  // Pages through a proxy that wants a sign-in. Answered once per address and minute, so a wrong
  // password ends in an error page instead of an endless loop.
  const proxyLogins = new Map();
  app.on('login', (event, _wc, details, authInfo, callback) => {
    if (!authInfo.isProxy) {
      // A site that asks for a sign-in and has one in the per-site settings (once per address and minute).
      const creds = siteCredentials(authInfo.host);
      const key = 'site:' + details.url;
      const last = proxyLogins.get(key);
      if (!creds || (last && Date.now() - last < 60000)) return;
      proxyLogins.set(key, Date.now());
      event.preventDefault();
      callback(creds.user, creds.pass);
      return;
    }
    const key = details.url;
    const last = proxyLogins.get(key);
    if (last && Date.now() - last < 60000) return;
    const creds = proxyCredentials(settings);
    if (!creds) return;
    proxyLogins.set(key, Date.now());
    if (proxyLogins.size > 200) proxyLogins.delete(proxyLogins.keys().next().value);
    event.preventDefault();
    callback(creds.user, creds.pass);
  });

  // Copied download links (another app, a chat...) are offered as downloads.
  clipboardWatcher = new ClipboardWatcher(settings);
  clipboardWatcher.on('links', (links) => {
    addFlow.requestLinks(links, { origin: 'clipboard' });
    if (win && !win.isFocused()) {
      notify({
        title: links.length === 1 ? 'Download link copied' : `${links.length} download links copied`,
        body: links.length === 1 ? util.filenameFromUrl(links[0]) || links[0] : 'Click to choose which to download',
        onClick: () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } },
      });
    }
  });

  // Grabber thumbnails: novadm-thumb://img/?u=<image url>&r=<page url>. Fetched through the browsing
  // session with the page as Referer, so hotlink-protected images still preview. Only NovaDM's own UI
  // views (default session) can load this scheme.
  protocol.handle('novadm-thumb', async (req) => {
    let target = '';
    let ref = '';
    try { const u = new URL(req.url); target = u.searchParams.get('u') || ''; ref = u.searchParams.get('r') || ''; } catch {}
    if (!/^https?:\/\//i.test(target)) return new Response('', { status: 400 });
    try {
      return await browser.normalSession.fetch(target, { headers: ref ? { 'x-novadm-referer': ref } : {} });
    } catch {
      return new Response('', { status: 502 });
    }
  });

  createWindow();
  wireEvents();
  // Size of NovaDM's own screens (Settings → Appearance) and the bookmarks bar.
  for (const v of [chromeView, overlayView]) v.webContents.on('did-finish-load', () => v.webContents.setZoomFactor(browsing.scale()));
  for (const v of [chromeView, overlayView, browsing.findView]) {
    v.webContents.on('before-input-event', (e, input) => {
      const action = shortcutFor(input);
      if (!action || action === 'stop' || action.startsWith('zoom') && v !== chromeView) return;
      e.preventDefault();
      handleShortcut(browser.activeTab(), action);
    });
  }
  settings.on('change', (c) => {
    if ('uiScale' in c) browsing.applyScale([chromeView, overlayView, browsing.findView]);
    if ('showBookmarksBar' in c) { layout(); sendUI('bookmarks', browsing.bookmarkState()); }
  });
  // Appearance: theme now, accent once NovaDM's own views have loaded, and on every change.
  applyAppearance();
  for (const v of [chromeView, overlayView]) v.webContents.on('did-finish-load', () => styleUi(v.webContents));
  settings.on('change', (c) => { if ('theme' in c || 'accent' in c) applyAppearance(); });
  // Started with a link or file (command line, novadm://, magnet:, .torrent).
  setTimeout(() => handleLaunch(process.argv), 800);
  // "Resume unfinished downloads when NovaDM starts".
  if (settings.get('autoResume')) setTimeout(() => downloads.resumeInterrupted(), 1500);
  // Queues with schedules, tray / background, keep-awake and "when all downloads finish".
  scheduler = new Scheduler({ settings, downloads });
  downloads.scheduler = scheduler;
  scheduler.start();
  background = new Background({ settings, downloads, getWindow: () => win, showWindow, notify, sendUI, setPanel });
  background.start();
  // Extensions start after the window exists; tabs opened before that are registered now.
  extensions.init({ browser, getWindow: () => win })
    .then(() => {
      for (const id of browser.order) {
        const t = browser.tabs.get(id);
        if (t && !t.incognito) extensions.addTab(t.wc, win);
      }
      const active = browser.activeTab();
      if (active && !active.incognito) extensions.selectTab(active.wc);
    })
    .catch((e) => console.error('extensions init failed', e));

  ipcHandlers = registerIpc({
    getManagers: () => ({ settings, adblock, popup, media, downloads, browser, win, extensions, addFlow, scheduler, background, ffmpeg, aria2, api, ytdlp, siteExt, toolDownloadFn: () => toolDownloadRef, getApiStatus: () => apiStatus }),
    setPanel, sendUI, sendMediaState,
    downloadItem,
    reviewBlockedPopup,
    getPendingPermission: () => pendingPermission,
    clearPendingPermission: () => { pendingPermission = null; },
  });
  Object.assign(ipcHandlers, browsing.handlers);

  // Ad-block lists load in the background; attach to sessions once ready.
  adblock.init().then(() => {
    adblock.attach(browser.normalSession);
    adblock.attach(browser.incognitoSession);
    sendUI('adblock-ready', {});
  }).catch((e) => console.error('adblock init failed', e));

  // Stats for the new-tab page.
  let adsBlockedTotal = 0;
  let popupsBlockedTotal = 0;
  adblock.on('blocked', () => { adsBlockedTotal++; });
  browser.on('popup-blocked', () => { popupsBlockedTotal++; });
  ipcMain.handle('novadm:internal-stats', () => ({
    ads: adsBlockedTotal, popups: popupsBlockedTotal, downloads: downloads.list().filter((d) => d.state === 'done').length,
  }));
  // Settings for the novadm://settings page. Only NovaDM's own UI files may call this.
  const UI_FILE_PREFIX = pathToFileURL(UI_DIR).href + '/';
  ipcMain.handle('novadm:internal-settings', async (event, op, arg) => {
    const from = (event.senderFrame && event.senderFrame.url) || '';
    if (!from.toLowerCase().startsWith(UI_FILE_PREFIX.toLowerCase())) throw new Error('not allowed');
    if (op === 'set') settings.set(arg || {});
    if (op === 'sitePassword') {
      // { site, password }: stored encrypted on that site's entry.
      try {
        const enc = arg && arg.password ? encryptPassword(String(arg.password)) : '';
        settings.set({ siteSettings: (settings.get('siteSettings') || []).map((s) => (String(s.site).toLowerCase() === String(arg.site).toLowerCase() ? { ...s, passEnc: enc } : s)) });
      } catch (e) { return { ok: false, error: e.message }; }
    }
    if (op === 'chooseProgram') {
          const r = await dialog.showOpenDialog(win, { title: 'Choose a program', properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe'] }] });
      if (!r.canceled && r.filePaths[0]) settings.set({ afterProgram: r.filePaths[0] });
    }
    if (op === 'chooseFolder') {
          const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
      return { folder: r.canceled ? '' : r.filePaths[0] || '' };
    }
    if (op === 'proxyPassword') {
      try { settings.set({ proxyPassEnc: encryptPassword(String(arg || '')) }); } catch (e) { return { ok: false, error: e.message }; }
    }
    if (op === 'chooseDir') {
          const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.get('downloadDir') });
      if (!r.canceled && r.filePaths[0]) settings.set({ downloadDir: r.filePaths[0] });
    }
    return { ...settings.all(), dnsStatus, dnsProviders: PROVIDERS };
  });
  // Actions for internal pages (Downloads page). Same sender check plus an allow list.
  ipcMain.handle('novadm:internal-call', async (event, method, args) => {
    const from = (event.senderFrame && event.senderFrame.url) || '';
    if (!from.toLowerCase().startsWith(UI_FILE_PREFIX.toLowerCase())) throw new Error('not allowed');
    if (!/^(downloads|extensions|ffmpeg|torrents|integration|ytdlp|siteext|history|bookmarks|reader)\.[A-Za-z]+$/.test(method) || !ipcHandlers[method]) throw new Error('Unknown method ' + method);
    return ipcHandlers[method](args || {});
  });
  // Live updates for open Downloads pages.
  downloads.on('changed', () => {
    const data = { list: downloads.list(), summary: downloads.activeSummary() };
    for (const t of browser.internalTabs('downloads')) t.wc.send('novadm:internal-event', 'downloads', data);
  });

  app.on('activate', () => { if (!win) createWindow(); });

  // ---- debug / test hooks (env-gated) ----
  // NOVADM_PANEL=<name>: open a panel shortly after start.
  if (process.env.NOVADM_PANEL) {
    setTimeout(() => ipcHandlers['panel.open']({ name: process.env.NOVADM_PANEL }), Number(process.env.NOVADM_PANEL_DELAY) || 2500);
  }
  // NOVADM_SHOT=<ms>: capture the UI so the build can be verified without a visible desktop.
  if (process.env.NOVADM_SHOT) {
    setTimeout(async () => {
      try {
        const os = require('os');
        const c = await chromeView.webContents.capturePage();
        fs.writeFileSync(path.join(os.tmpdir(), 'novadm-chrome.png'), c.toPNG());
        const t = browser.activeTab();
        if (t) { const p = await t.wc.capturePage(); fs.writeFileSync(path.join(os.tmpdir(), 'novadm-tab.png'), p.toPNG()); }
        if (process.env.NOVADM_PANEL) { const o = await overlayView.webContents.capturePage(); fs.writeFileSync(path.join(os.tmpdir(), 'novadm-overlay.png'), o.toPNG()); }
        fs.writeFileSync(path.join(os.tmpdir(), 'novadm-shot-done'), 'ok');
      } catch (e) { console.error('shot failed', e); }
    }, Number(process.env.NOVADM_SHOT) || 4000);
  }
  // NOVADM_SELFTEST=<module path>: run a scripted test inside the real app.
  if (process.env.NOVADM_SELFTEST) {
    const t = require(path.resolve(process.env.NOVADM_SELFTEST));
    setTimeout(() => {
      Promise.resolve(t({ app, browser, media, downloads, settings, adblock, ipc: ipcHandlers, setPanel, overlayView, chromeView, addFlow, clipboardWatcher, scheduler, background, api, ytdlp, siteExt, handleLaunch, browsing, getWindow: () => win }))
        .catch((e) => console.error('selftest failed', e));
    }, Number(process.env.NOVADM_SELFTEST_DELAY) || 3000);
  }
});

app.on('window-all-closed', () => { settings && settings.flush(); app.quit(); });
// Running downloads are paused properly on quit (caches written, data synced, progress saved), so they
// resume from where they stopped. Quitting waits for that, at most a few seconds.
let quitReady = false;
app.on('before-quit', (e) => {
  settings && settings.flush();
  if (quitReady || !downloads) { downloads && downloads.persist(); return; }
  e.preventDefault();
  quitReady = true;
  // Downloads pause cleanly while "clear when NovaDM closes" runs (Settings → Privacy).
  Promise.allSettled([downloads.shutdown(4000), browsing ? browsing.onQuit() : null])
    .finally(() => { if (aria2) aria2.stop(); if (api) api.stop(); app.quit(); });
});

module.exports = { get win() { return win; } };
