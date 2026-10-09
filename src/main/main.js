'use strict';
const path = require('path');
const { app, BaseWindow, WebContentsView, shell, ipcMain, protocol, session: electronSession } = require('electron');
const { Settings } = require('./settings');
const { AdBlocker } = require('./adblock');
const { PopupGuard } = require('./popup');
const { MediaRegistry } = require('./media/registry');
const { DownloadManager } = require('./download/manager');
const { Transport } = require('./transport');
const { AddFlow } = require('./add-flow');
const { ClipboardWatcher } = require('./clipboard-watch');
const { notify } = require('./notify');
const { applyProxy, proxyCredentials } = require('./proxy');
const { Scheduler } = require('./scheduler');
const { Background } = require('./background');
const { FFmpeg } = require('./ffmpeg');
const { Aria2 } = require('./torrent/aria2');
const { HttpDownload } = require('./download/http');
const util = require('./util');
const { Browser } = require('./browser');
const net = require('./net');
const { registerIpc } = require('./ipc');
const { applySecureDns } = require('./dns');
const { showContextMenu } = require('./contextmenu');
// Must load before the app is ready (registers the crx:// scheme for extension icons).
const { Extensions } = require('./extensions');

let dnsStatus = { mode: 'starting', servers: [] };

// Test runs use their own profile so they never touch the user's settings or downloads.
if (process.env.NOVADM_USERDATA) app.setPath('userData', process.env.NOVADM_USERDATA);
else migrateOldProfile();

// One NovaDM at a time (per profile): starting it again brings the running one forward.
const isFirstInstance = app.requestSingleInstanceLock();
if (!isFirstInstance) app.quit();
app.on('second-instance', () => showWindow());
// Started by Windows at sign-in: stay in the tray.
const startHidden = process.argv.includes('--hidden');

// The app was called "Swoop" before 0.2.0: move that profile (settings, downloads list,
// extensions, cookies) to NovaDM's folder once, if NovaDM has none yet.
function migrateOldProfile() {
  const fs = require('fs');
  try {
    const oldDir = path.join(app.getPath('appData'), 'Swoop');
    const newDir = app.getPath('userData');
    if (oldDir.toLowerCase() === newDir.toLowerCase() || !fs.existsSync(oldDir) || fs.existsSync(newDir)) return;
    try { fs.renameSync(oldDir, newDir); } catch { fs.cpSync(oldDir, newDir, { recursive: true }); }
  } catch (e) {
    console.error('profile migration failed', e);
  }
}

const CHROME_HEIGHT = 88;
const UI_DIR = path.join(__dirname, '..', 'ui');
const UI_PRELOAD = path.join(UI_DIR, 'preload-ui.js');

let win, chromeView, overlayView;
let settings, adblock, popup, media, downloads, browser, addFlow, clipboardWatcher, transport, scheduler, background, ffmpeg, aria2;
const extensions = new Extensions();
if (process.env.NOVADM_SELFTEST) global.__novadmExtensions = extensions; // test access only
let panelOpen = false;

function contentBounds() {
  const [w, h] = win.getContentSize();
  return { x: 0, y: CHROME_HEIGHT, width: w, height: Math.max(0, h - CHROME_HEIGHT) };
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  chromeView.setBounds({ x: 0, y: 0, width: w, height: CHROME_HEIGHT });
  const cb = contentBounds();
  overlayView.setBounds(cb);
  browser.setBounds(cb);
}

function restack() {
  // Keep z-order: page tab (bottom) < overlay < chrome (top). Nothing to do once the window is gone
  // (tabs are still being closed while NovaDM quits).
  if (!win || win.isDestroyed()) return;
  const root = win.contentView;
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

  browser.setParentView(win.contentView);
  browser.onRestack = restack;

  layout();
  win.on('resize', layout);
  win.on('maximize', () => sendUI('window-state', { maximized: true }));
  win.on('unmaximize', () => sendUI('window-state', { maximized: false }));
  win.on('close', (e) => {
    // Downloads running: keep going in the tray instead of quitting (Settings → Background).
    if (background && background.keepRunningOnClose()) { e.preventDefault(); background.hideToTray(); return; }
    browser.shuttingDown = true;
  });
  win.on('closed', () => { browser.shuttingDown = true; win = null; });

  // Open links that must leave the app (none by default) in the OS browser.
  chromeView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // NOVADM_OPEN (debug) opens a given address at startup instead of the new tab page.
  browser.createTab({ url: process.env.NOVADM_OPEN || 'novadm://newtab' });
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
    if (rec.errorCode === 'NEEDS_FFMPEG') {
      notify({ title: 'This video needs FFmpeg', body: 'Install it in Settings → Video tools, then retry the download.', onClick: () => { showWindow(); browser.openInternal('settings'); } });
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
  try { require('fs').mkdirSync(dir, { recursive: true }); } catch {}
  item.setSavePath(util.uniquePath(require('path').join(dir, name), downloads.reservedPaths()));
  downloads.addNative(item, info);
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
  sendUI('media', { count: media.count(tabId), ...data });
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
      mime: item.mime, category: item.kind === 'audio' ? 'music' : item.kind === 'subtitle' ? 'documents' : 'video',
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
  transport = new Transport({ session: browser.normalSession, settings });
  downloads = new DownloadManager(settings, browser.normalSession, { transport, privateSession: browser.incognitoSession });
  addFlow = new AddFlow({ downloads, settings, browser, sendUI, setPanel, getWindow: () => win, notify });
  // Helper tools on demand (FFmpeg, aria2): downloaded with NovaDM's own engine (speed limit and
  // proxy apply) and checked before use.
  const toolText = async (url) => (await net.fetchText(url, { session: browser.normalSession, timeoutMs: 20000 })).text;
  const toolDownload = (url, savePath, onProgress) => new Promise((resolve, reject) => {
    const dl = new HttpDownload({ id: 'tool', savePath, sources: [url], session: browser.normalSession, transport, limiter: downloads.limiter, connections: 8, retries: 5 });
    dl.on('progress', (p) => onProgress({ received: p.received, size: p.size }));
    dl.on('done', resolve);
    dl.on('error', reject);
    dl.start();
  });
  ffmpeg = new FFmpeg({ settings, userDataDir: app.getPath('userData'), fetchText: toolText, download: toolDownload });
  downloads.ffmpeg = ffmpeg;
  aria2 = new Aria2({ settings, userDataDir: app.getPath('userData'), fetchText: toolText, download: toolDownload });
  downloads.aria2 = aria2;
  downloads.askTorrentFiles = (rec, files) => addFlow.askTorrentFiles(rec, files);
  settings.on('change', (c) => { if (Object.keys(c).some((k) => k.startsWith('torrent'))) aria2.applySettings(); });

  // Proxy for pages and downloads (system settings unless the user chose otherwise).
  const proxySessions = () => [browser.normalSession, browser.incognitoSession, electronSession.defaultSession];
  applyProxy(settings, proxySessions());
  settings.on('change', (c) => {
    if (Object.keys(c).some((k) => k.startsWith('proxy'))) applyProxy(settings, proxySessions()).then(() => transport.close());
  });
  net.setProxyCredentials(() => proxyCredentials(settings));
  transport.proxyCredentials = () => proxyCredentials(settings);
  // Pages through a proxy that wants a sign-in. Answered once per address and minute, so a wrong
  // password ends in an error page instead of an endless loop.
  const proxyLogins = new Map();
  app.on('login', (event, _wc, details, authInfo, callback) => {
    if (!authInfo.isProxy) return;
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

  const ipcHandlers = registerIpc({
    getManagers: () => ({ settings, adblock, popup, media, downloads, browser, win, extensions, addFlow, scheduler, background, ffmpeg, aria2 }),
    setPanel, sendUI, sendMediaState,
    downloadItem,
    reviewBlockedPopup,
    getPendingPermission: () => pendingPermission,
    clearPendingPermission: () => { pendingPermission = null; },
  });

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
  const UI_FILE_PREFIX = require('url').pathToFileURL(UI_DIR).href + '/';
  ipcMain.handle('novadm:internal-settings', async (event, op, arg) => {
    const from = (event.senderFrame && event.senderFrame.url) || '';
    if (!from.toLowerCase().startsWith(UI_FILE_PREFIX.toLowerCase())) throw new Error('not allowed');
    if (op === 'set') settings.set(arg || {});
    if (op === 'proxyPassword') {
      try { settings.set({ proxyPassEnc: require('./proxy').encryptPassword(String(arg || '')) }); } catch (e) { return { ok: false, error: e.message }; }
    }
    if (op === 'chooseDir') {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.get('downloadDir') });
      if (!r.canceled && r.filePaths[0]) settings.set({ downloadDir: r.filePaths[0] });
    }
    const { PROVIDERS } = require('./dns');
    return { ...settings.all(), dnsStatus, dnsProviders: PROVIDERS };
  });
  // Actions for internal pages (Downloads page). Same sender check plus an allow list.
  ipcMain.handle('novadm:internal-call', async (event, method, args) => {
    const from = (event.senderFrame && event.senderFrame.url) || '';
    if (!from.toLowerCase().startsWith(UI_FILE_PREFIX.toLowerCase())) throw new Error('not allowed');
    if (!/^(downloads|extensions|ffmpeg|torrents)\.[A-Za-z]+$/.test(method) || !ipcHandlers[method]) throw new Error('Unknown method ' + method);
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
        const os = require('os'); const fs = require('fs');
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
      Promise.resolve(t({ app, browser, media, downloads, settings, adblock, ipc: ipcHandlers, setPanel, overlayView, chromeView, addFlow, clipboardWatcher, scheduler, background, getWindow: () => win }))
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
  downloads.shutdown(4000).finally(() => { if (aria2) aria2.stop(); app.quit(); });
});

module.exports = { get win() { return win; } };
