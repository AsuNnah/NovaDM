'use strict';
const fs = require('fs');
const path = require('path');
const { app, ipcMain, shell, clipboard, dialog } = require('electron');
const { pathToFileURL } = require('url');
const { siteOf, extractLinks, expandPattern } = require('./util');
const grabber = require('./grabber');
const { copyText } = require('./clipboard-watch');
const { specFromUrl } = require('./add-flow');
const { toggleSite } = require('./hardening');
const { parseCurl } = require('./curl');
const { exportData, importData } = require('./backup');
const { nextStart, normalizeQueues } = require('./scheduler');
const { STORE_URL } = require('./extensions');
const diagnostics = require('./diagnostics');
const { siteFor } = require('./site-search');

const GRAB_CATEGORY = { image: 'images', video: 'video', audio: 'music', document: 'documents', archive: 'archives', program: 'programs' };

let ytdlpChoices = null;

// Add-ons shown with a warning on the menu button while missing (until installed or "Don't remind me").
const ADDONS = [
  { id: 'ytdlp', name: 'yt-dlp', why: '“Find with yt-dlp” for videos NovaDM can’t detect by itself' },
  { id: 'ffmpeg', name: 'FFmpeg', why: 'Joining WebM / plain-MP4 picture and sound, saving sound only, repairing videos' },
  { id: 'aria2', name: 'aria2', why: 'Torrents and magnet links' },
];

function registerIpc(ctx) {
  const { getManagers, setPanel, sendUI, sendMediaState, downloadItem, reviewBlockedPopup, getPendingPermission, clearPendingPermission } = ctx;

  const handlers = {
    // ---- window ----
    'window.minimize': () => getManagers().win.minimize(),
    'window.maximizeToggle': () => { const w = getManagers().win; w.isMaximized() ? w.unmaximize() : w.maximize(); return w.isMaximized(); },
    'window.close': () => getManagers().win.close(),

    // ---- tabs / navigation ----
    'tabs.list': () => { const b = getManagers().browser; return { tabs: b.order.map((id) => b.serializeTab(b.tabs.get(id))).filter(Boolean), activeId: b.activeId }; },
    'tabs.new': (a = {}) => getManagers().browser.createTab({ url: a.url, incognito: !!a.incognito }),
    'tabs.select': (a) => getManagers().browser.selectTab(a.id),
    'tabs.close': (a) => getManagers().browser.closeTab(a.id),
    'nav.go': (a) => getManagers().browser.navigate(a.tabId, a.input),
    'nav.back': (a) => getManagers().browser.back(a && a.tabId),
    'nav.forward': (a) => getManagers().browser.forward(a && a.tabId),
    'nav.reload': (a) => getManagers().browser.reload(a && a.tabId),

    // ---- panels ----
    'panel.open': (a) => { getManagers().addFlow.dismiss(); setPanel(true); sendUI('open-panel', { name: a.name, anchor: a.anchor }); if (a.name === 'media') sendMediaState(); if (a.name === 'downloads') pushDownloads(); if (a.name === 'shields') pushShields(); },
    'panel.close': () => {
      // Closing a permission prompt without answering counts as "Block".
      const p = getPendingPermission();
      if (p) { try { p.cb(false); } catch {} clearPendingPermission(); }
      getManagers().addFlow.dismiss();
      // Closing the "when all downloads finish" countdown cancels it.
      if (getManagers().background) getManagers().background.cancelCountdown();
      setPanel(false);
      sendUI('close-panel', {});
    },

    // ---- media ----
    'media.download': (a) => { const b = getManagers().browser; return downloadItem(b.activeId, a.id, a.variantUrl); },
    'media.downloadAll': (a) => {
      const b = getManagers().browser; const m = getManagers().media; const out = [];
      for (const it of m.list(b.activeId).items) if (it.kind !== 'subtitle' && it.encryption !== 'drm') out.push(downloadItem(b.activeId, it.id));
      return { ok: true, count: out.filter((o) => o.ok).length };
    },
    // yt-dlp add-on: what it finds on the page in the active tab; the choices stay here, the panel
    // only gets their labels and answers with a number.
    'media.ytdlpFind': async () => {
      const { browser, ytdlp } = getManagers();
      const tab = browser.activeTab();
      if (!tab || !/^https?:/i.test(tab.url || '')) return { ok: false, error: 'Open a web page first' };
      try {
        const ses = tab.incognito ? browser.incognitoSession : browser.normalSession;
        const cookies = await ses.cookies.get({ url: tab.url });
        const r = await ytdlp.find(tab.url, { cookies, referer: tab.url });
        ytdlpChoices = { tabId: tab.id, incognito: tab.incognito, list: r.choices };
        return { ok: true, title: r.title, duration: r.duration, choices: r.choices.map((c) => c.label) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    'media.ytdlpDownload': (a) => {
      const c = ytdlpChoices && ytdlpChoices.list[a.index];
      if (!c) return { ok: false };
      return getManagers().addFlow.request({ ...c.spec, tabId: ytdlpChoices.tabId, incognito: ytdlpChoices.incognito }, { origin: 'media' });
    },
    'ytdlp.status': () => getManagers().ytdlp.status(),
    'ytdlp.install': async () => {
      const { ytdlp, browser } = getManagers();
      const push = (p) => { for (const t of browser.internalTabs('settings')) t.wc.send('novadm:internal-event', 'ytdlp', p); };
      try { const st = await ytdlp.install(push); return { ok: true, status: st }; } catch (e) { push({ phase: 'error', error: e.message }); return { ok: false, error: e.message }; }
    },
    'ytdlp.uninstall': () => { getManagers().ytdlp.uninstall(); getManagers().settings.set({ ytdlpPath: '' }); return getManagers().ytdlp.status(); },
    'ytdlp.choose': async () => {
      const { win, settings, ytdlp } = getManagers();
      const r = await dialog.showOpenDialog(win, { title: 'Choose yt-dlp.exe', properties: ['openFile'], filters: [{ name: 'yt-dlp', extensions: ['exe'] }] });
      if (!r.canceled && r.filePaths[0]) settings.set({ ytdlpPath: r.filePaths[0] });
      return ytdlp.status();
    },
    'media.clear': () => { const b = getManagers().browser; getManagers().media.clear(b.activeId); sendMediaState(); },
    'media.remove': (a) => { const b = getManagers().browser; getManagers().media.remove(b.activeId, a.id); sendMediaState(); },

    // ---- downloads ----
    'downloads.list': () => ({ list: getManagers().downloads.list(), summary: getManagers().downloads.activeSummary() }),
    'downloads.pause': (a) => getManagers().downloads.pause(a.id),
    'downloads.resume': (a) => getManagers().downloads.resume(a.id),
    'downloads.stopRecording': (a) => getManagers().downloads.stopRecording(a.id),
    'downloads.convert': (a) => {
      try { const r = getManagers().downloads.convert(a.id, a.action); return { ok: true, id: r.id }; } catch (e) { return { ok: false, error: e.message, code: e.code }; }
    },

    // ---- site extensions ----
    'siteext.list': () => getManagers().siteExt.list(),
    'siteext.setEnabled': (a) => { getManagers().siteExt.setEnabled(a.id, !!a.enabled); return getManagers().siteExt.list(); },
    'siteext.remove': (a) => { getManagers().siteExt.remove(a.id); return getManagers().siteExt.list(); },
    'siteext.installFolder': async () => {
      const { win, siteExt } = getManagers();
      const r = await dialog.showOpenDialog(win, { title: 'Choose the extension folder', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      try { return await siteExt.installFromFolder(r.filePaths[0]); } catch (e) { return { ok: false, error: e.message }; }
    },
    'siteext.installGitHub': async (a) => {
      const { siteExt, toolDownloadFn } = getManagers();
      try { return await siteExt.installFromGitHub(a.url, toolDownloadFn()); } catch (e) { return { ok: false, error: e.message }; }
    },

    // ---- integration (local API, browser extension) ----
    'integration.status': () => {
      const { settings, getApiStatus } = getManagers();
      const st = getApiStatus();
      const extDir = app.isPackaged ? path.join(process.resourcesPath, 'browser-extension') : path.join(app.getAppPath(), 'browser-extension');
      return { enabled: !!settings.get('apiEnabled'), running: !!st.running, port: st.port || settings.get('apiPort'), error: st.error || '', key: settings.get('apiEnabled') ? settings.get('apiKey') : '', extensionFolder: extDir };
    },
    'integration.newKey': () => { getManagers().api.newKey(); return { ok: true }; },
    'integration.copyKey': () => { copyText(getManagers().settings.get('apiKey') || ''); return { ok: true }; },
    'integration.openExtensionFolder': () => {
      shell.openPath(app.isPackaged ? path.join(process.resourcesPath, 'browser-extension') : path.join(app.getAppPath(), 'browser-extension'));
    },

    // ---- torrents ----
    'downloads.openTorrent': async () => {
      const { win, addFlow } = getManagers();
      const r = await dialog.showOpenDialog(win, { title: 'Open a torrent file', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Torrent files', extensions: ['torrent'] }] });
      if (r.canceled) return { ok: false };
      for (const f of r.filePaths) addFlow.requestTorrentFile(fs.readFileSync(f), { origin: 'manual' });
      return { ok: true };
    },
    'downloads.stopSeeding': async (a) => { await getManagers().downloads.stopSeeding(a.id); return { ok: true }; },
    'torrents.status': () => getManagers().aria2.status(),
    'torrents.install': async () => {
      const { aria2, browser } = getManagers();
      const push = (p) => { for (const t of browser.internalTabs('settings')) t.wc.send('novadm:internal-event', 'aria2', p); };
      try { const st = await aria2.install(push); return { ok: true, status: st }; } catch (e) { push({ phase: 'error', error: e.message }); return { ok: false, error: e.message }; }
    },
    'torrents.uninstall': () => { getManagers().aria2.uninstall(); getManagers().settings.set({ aria2Path: '' }); return getManagers().aria2.status(); },
    'torrents.choose': async () => {
      const { win, settings, aria2 } = getManagers();
      const r = await dialog.showOpenDialog(win, { title: 'Choose aria2c.exe', properties: ['openFile'], filters: [{ name: 'aria2', extensions: ['exe'] }] });
      if (!r.canceled && r.filePaths[0]) settings.set({ aria2Path: r.filePaths[0] });
      return aria2.status();
    },

    // ---- FFmpeg (Settings → Add-ons) ----
    'ffmpeg.status': () => getManagers().ffmpeg.status(),
    'ffmpeg.install': async () => {
      const { ffmpeg, browser } = getManagers();
      const push = (p) => { for (const t of browser.internalTabs('settings')) t.wc.send('novadm:internal-event', 'ffmpeg', p); };
      try { const st = await ffmpeg.install(push); return { ok: true, status: st }; } catch (e) { push({ phase: 'error', error: e.message }); return { ok: false, error: e.message }; }
    },
    'ffmpeg.uninstall': () => { getManagers().ffmpeg.uninstall(); getManagers().settings.set({ ffmpegPath: '' }); return getManagers().ffmpeg.status(); },
    'ffmpeg.choose': async () => {
      const { win, settings, ffmpeg } = getManagers();
      const r = await dialog.showOpenDialog(win, { title: 'Choose ffmpeg.exe', properties: ['openFile'], filters: [{ name: 'FFmpeg', extensions: ['exe'] }] });
      if (!r.canceled && r.filePaths[0]) settings.set({ ffmpegPath: r.filePaths[0] });
      return ffmpeg.status();
    },
    'downloads.cancel': (a) => getManagers().downloads.cancel(a.id, a.deleteFile !== false),
    'downloads.remove': (a) => getManagers().downloads.remove(a.id),
    'downloads.clearCompleted': () => getManagers().downloads.clearCompleted(),
    'downloads.pauseAll': () => getManagers().downloads.pauseAll(),
    'downloads.resumeAll': () => getManagers().downloads.resumeAll(),
    'downloads.redownload': (a) => { const r = getManagers().downloads.redownload(a.id); return { ok: !!r }; },
    'downloads.properties': (a) => getManagers().downloads.properties(a.id),
    'downloads.checksum': async (a) => ({ algo: a.algo, hash: await getManagers().downloads.checksum(a.id, a.algo) }),
    'downloads.openPage': (a) => { const r = getManagers().downloads.get(a.id); if (r && /^https?:/i.test(r.pageUrl || '')) getManagers().browser.createTab({ url: r.pageUrl }); },
    'downloads.copyLink': (a) => {
      const r = getManagers().downloads.get(a.id);
      if (r) copyText(a.which === 'page' ? (r.pageUrl || '') : (r.kind === 'hls' || r.kind === 'dash' ? r.playlistUrl : (r.sources[0] || '')));
    },
    'downloads.openFolder': () => shell.openPath(getManagers().settings.get('downloadDir')),
    'downloads.openPageTab': () => getManagers().browser.openInternal('downloads'),
    'downloads.openFile': (a) => { const r = getManagers().downloads.get(a.id); if (r) shell.openPath(r.savePath); },
    'downloads.showInFolder': (a) => { const r = getManagers().downloads.get(a.id); if (r) shell.showItemInFolder(r.state === 'done' ? r.savePath : r.savePath + '.part'); },
    // One link, several (pasted list), a batch pattern like img[001-100].jpg, or a cURL command
    // ("Copy as cURL" in a browser's developer tools: the same request, headers and cookies).
    'downloads.addUrl': async (a) => {
      const text = String(a.url || '').trim();
      if (/^curl(\.exe)?\s/i.test(text)) {
        try {
          const c = parseCurl(text);
          const spec = specFromUrl(c.url, { pageUrl: c.headers.referer || '' });
          spec.headers = { ...c.headers };
          return getManagers().addFlow.request(spec, { origin: 'manual' });
        } catch (e) { return { ok: false, error: e.message }; }
      }
      const links = extractLinks(text, 1000).flatMap((u) => expandPattern(u, 5000));
      if (!links.length) return { ok: false, error: 'Enter a http(s) link' };
      return getManagers().addFlow.requestLinks(links, { origin: 'manual' });
    },
    'downloads.extract': async (a) => getManagers().downloads.extract(a.id),
    'downloads.export': async () => {
      const { win, settings, downloads } = getManagers();
      const r = await dialog.showSaveDialog(win, { title: 'Export downloads and settings', defaultPath: `NovaDM backup ${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'NovaDM backup', extensions: ['json'] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      const data = exportData({ settings, downloads, version: app.getVersion() });
      fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
      return { ok: true, downloads: data.downloads.length };
    },
    'downloads.import': async () => {
      const { win, settings, downloads } = getManagers();
      const r = await dialog.showOpenDialog(win, { title: 'Import downloads and settings', properties: ['openFile'], filters: [{ name: 'NovaDM backup', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      try {
        const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
        return { ok: true, ...importData(data, { settings, downloads }) };
      } catch (e) { return { ok: false, error: e.message }; }
    },
    'downloads.setSpeedLimit': (a) => { getManagers().downloads.setSpeedLimit(a.id, a.kbps); return { ok: true }; },
    'downloads.refreshFromPage': (a) => getManagers().addFlow.refreshFromPage(a.id),
    'downloads.refreshLink': async (a) => {
      try { await getManagers().downloads.refreshLink(a.id, String(a.url || '').trim()); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
    },

    // ---- queues and scheduling ----
    'downloads.queues': () => {
      const { downloads, settings } = getManagers();
      return {
        queues: downloads.queues().map((q) => {
          const next = q.schedule && q.schedule.enabled ? nextStart(q.schedule) : null;
          return { ...q, next: next ? next.getTime() : 0, active: downloads.queueActive(q.id) };
        }),
        afterAllDone: settings.get('afterAllDone') || 'nothing',
      };
    },
    'downloads.saveQueues': (a) => {
      const queues = normalizeQueues(a.queues);
      const { downloads, settings, scheduler } = getManagers();
      // Downloads in a deleted queue move to Main.
      const ids = new Set(queues.map((q) => q.id));
      for (const r of downloads.records.values()) if (!ids.has(r.queue || 'main')) downloads.setQueue(r.id, 'main');
      settings.set({ queues });
      if (scheduler) scheduler.tick();
      return { ok: true, queues };
    },
    'downloads.setQueue': (a) => { getManagers().downloads.setQueue(a.id, a.queue); return { ok: true }; },
    'downloads.startQueue': (a) => { getManagers().downloads.startQueue(a.queue); return { ok: true }; },
    'downloads.stopQueue': (a) => { getManagers().downloads.stopQueue(a.queue); return { ok: true }; },
    'downloads.setAfterAllDone': (a) => { getManagers().settings.set({ afterAllDone: ['nothing', 'exit', 'sleep', 'shutdown'].includes(a.action) ? a.action : 'nothing' }); return { ok: true }; },
    'afterdone.cancel': () => { const b = getManagers().background; if (b) b.cancelCountdown(); getManagers().settings.set({ afterAllDone: 'nothing' }); setPanel(false); sendUI('close-panel', {}); },
    'afterdone.now': () => { const b = getManagers().background; if (b) b.runAction(true); },

    // ---- new download dialog ----
    'add.respond': (a) => getManagers().addFlow.respond(a),
    'add.chooseFolder': async (a) => ({ folder: await getManagers().addFlow.chooseFolder(a.current) }),

    // ---- content grabber ----
    'grab.scan': async (a) => {
      const { browser, media } = getManagers();
      const tabs = a.allTabs ? browser.order.map((id) => browser.tabs.get(id)) : [browser.activeTab()];
      const items = [];
      const seen = new Set();
      let title = '';
      for (const tab of tabs.filter(Boolean)) {
        if (tab.incognito && a.allTabs && tab.id !== browser.activeId) continue;
        let res;
        try { res = await grabber.scanTab(tab, { autoScroll: !!a.autoScroll }); } catch { continue; }
        if (tab.id === browser.activeId) title = res.title;
        for (const it of res.items) if (!seen.has(it.url)) { seen.add(it.url); items.push(it); }
        // Direct video/audio files the sniffer saw on this tab (streams stay in the media panel).
        for (const m of media.list(tab.id).items) {
          if ((m.kind === 'video' || m.kind === 'audio') && !seen.has(m.url)) {
            seen.add(m.url);
            items.push({ url: m.url, kind: m.kind, name: m.name, alt: '', w: 0, h: 0, size: m.size, from: 'network', pageUrl: res.url, pageTitle: res.title, tabId: tab.id });
          }
        }
      }
      return { title, items };
    },
    'grab.download': (a) => {
      const { downloads } = getManagers();
      let n = 0;
      for (const it of a.items || []) {
        if (!/^https?:\/\//i.test(it.url || '')) continue;
        downloads.add({
          kind: 'http', url: it.url, sources: [it.url], name: '',
          headers: it.pageUrl ? { referer: it.pageUrl } : {}, pageUrl: it.pageUrl || '',
          category: GRAB_CATEGORY[it.kind] || 'other',
          subdir: a.subfolder ? (it.pageTitle || siteOf(it.pageUrl) || 'Page') : undefined,
        });
        n++;
      }
      return { ok: true, count: n };
    },

    // ---- Chrome extensions ----
    'extensions.list': () => ({ ready: getManagers().extensions.ready, list: getManagers().extensions.list() }),
    'extensions.remove': async (a) => { await getManagers().extensions.remove(a.id); return { ok: true }; },
    'extensions.openStore': () => getManagers().browser.createTab({ url: STORE_URL }),

    // ---- shields (adblock) ----
    'shields.state': () => shieldsState(),
    'shields.toggleSite': () => { const b = getManagers().browser; const t = b.activeTab(); if (t) { const on = getManagers().adblock.isWhitelisted(t.url); getManagers().adblock.setSiteEnabled(t.url, on); b.reload(t.id); } setTimeout(pushShields, 200); },
    'shields.toggleHardening': () => { const b = getManagers().browser; const t = b.activeTab(); if (t) { toggleSite(getManagers().settings, t.url); b.reload(t.id); } setTimeout(pushShields, 200); },
    'shields.setGlobal': (a) => { getManagers().settings.set({ adblock: !!a.enabled }); pushShields(); },

    // ---- pop-up guard responses ----
    'popup.respond': (a) => {
      const b = getManagers().browser;
      if (a.always && a.pageUrl) getManagers().popup.allowSite(a.pageUrl, a.allow);
      if (a.allow && /^https?:/.test(a.url || '')) b.createTab({ url: a.url });
    },
    'popup.review': () => reviewBlockedPopup(),

    // ---- permissions ----
    'permission.respond': (a) => {
      const p = getPendingPermission();
      if (!p) return;
      const grant = !!a.allow;
      if (a.remember) getManagers().browser.setPermission(p.info.origin, p.info.permission, grant ? 'granted' : 'denied');
      try { p.cb(grant); } catch {}
      clearPendingPermission();
    },

    // ---- settings ----
    'settings.get': () => getManagers().settings.all(),

    // ---- add-on reminders, "Report a problem", address bar site search ----
    'addons.state': () => addonState(),
    'addons.dismiss': (a) => {
      const { settings } = getManagers();
      if (ADDONS.some((x) => x.id === a.id)) settings.set({ addonRemindOff: [...new Set([...(settings.get('addonRemindOff') || []), a.id])] });
      pushAddons();
    },
    'diagnostics.report': () => diagnostics.report({ app, ...getManagers() }),
    'diagnostics.save': async () => {
      const m = getManagers();
      const text = await handlers['diagnostics.report']();
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      const r = await dialog.showSaveDialog(m.win, { title: 'Save problem report', defaultPath: path.join(app.getPath('downloads'), `NovaDM-report-${stamp}.txt`), filters: [{ name: 'Text', extensions: ['txt'] }] });
      if (r.canceled || !r.filePath) return { ok: false };
      fs.writeFileSync(r.filePath, text, 'utf8');
      shell.openPath(r.filePath); // opened so it can be read before it is shared
      return { ok: true, path: r.filePath };
    },
    'omni.site': (a) => siteFor(a.q),

    // ---- misc ----
  };

  function addonState() {
    const m = getManagers();
    const off = m.settings.get('addonRemindOff') || [];
    const has = { ytdlp: () => m.ytdlp.exe(), ffmpeg: () => m.ffmpeg.exe(), aria2: () => m.aria2.exe() || m.aria2.external };
    return { missing: ADDONS.filter((a) => !off.includes(a.id) && !has[a.id]()) };
  }
  function pushAddons() { sendUI('addons', addonState()); }
  // The warning on the menu button follows add-on changes made from Settings too.
  for (const k of Object.keys(handlers).filter((m) => /^(ffmpeg|ytdlp|torrents)\.(install|uninstall|choose)$/.test(m))) {
    const f = handlers[k];
    handlers[k] = async (a) => { try { return await f(a); } finally { pushAddons(); } };
  }

  function shieldsState() {
    const { browser, adblock, settings } = getManagers();
    const t = browser.activeTab();
    return {
      global: !!settings.get('adblock'),
      siteEnabled: t ? !adblock.isWhitelisted(t.url) : true,
      site: t ? siteOf(t.url) : '',
      count: t ? adblock.count(t.wcId) : 0,
      protection: t && /^https?:/i.test(t.url || '') ? { siteOn: !(settings.get('hardeningOff') || []).includes(siteOf(t.url)), level: settings.get('securityLevel'), fingerprinting: settings.get('fingerprinting') } : null,
      ready: adblock.ready,
    };
  }
  function pushShields() { sendUI('shields', shieldsState()); }
  function pushDownloads() { sendUI('downloads', { list: getManagers().downloads.list(), summary: getManagers().downloads.activeSummary() }); }

  // Only NovaDM's own toolbar and panels, never a web page (even if one of those views navigated).
  const UI_PREFIX = pathToFileURL(path.join(__dirname, '..', 'ui')).href.toLowerCase() + '/';
  ipcMain.handle('novadm:call', async (e, method, args) => {
    if (!((e.senderFrame && e.senderFrame.url) || '').toLowerCase().startsWith(UI_PREFIX)) throw new Error('not allowed');
    const fn = handlers[method];
    if (!fn) throw new Error('Unknown method ' + method);
    return fn(args || {});
  });
  return handlers;
}

module.exports = { registerIpc };
