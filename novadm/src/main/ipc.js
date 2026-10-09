'use strict';
const { ipcMain, shell, clipboard, dialog } = require('electron');
const { siteOf } = require('./util');
const grabber = require('./grabber');

const GRAB_CATEGORY = { image: 'images', video: 'video', audio: 'music', document: 'documents', archive: 'archives', program: 'programs' };

function registerIpc(ctx) {
  const { getManagers, setPanel, sendUI, sendMediaState, downloadItem, reviewBlockedPopup, getPendingPermission, clearPendingPermission } = ctx;

  const handlers = {
    // ---- window ----
    'window.minimize': () => getManagers().win.minimize(),
    'window.maximizeToggle': () => { const w = getManagers().win; w.isMaximized() ? w.unmaximize() : w.maximize(); return w.isMaximized(); },
    'window.close': () => getManagers().win.close(),
    'window.isMaximized': () => getManagers().win.isMaximized(),

    // ---- tabs / navigation ----
    'tabs.list': () => { const b = getManagers().browser; return { tabs: b.order.map((id) => b.serializeTab(b.tabs.get(id))).filter(Boolean), activeId: b.activeId }; },
    'tabs.new': (a = {}) => getManagers().browser.createTab({ url: a.url, incognito: !!a.incognito }),
    'tabs.select': (a) => getManagers().browser.selectTab(a.id),
    'tabs.close': (a) => getManagers().browser.closeTab(a.id),
    'nav.go': (a) => getManagers().browser.navigate(a.tabId, a.input),
    'nav.back': (a) => getManagers().browser.back(a && a.tabId),
    'nav.forward': (a) => getManagers().browser.forward(a && a.tabId),
    'nav.reload': (a) => getManagers().browser.reload(a && a.tabId),
    'nav.stop': (a) => getManagers().browser.stop(a && a.tabId),

    // ---- panels ----
    'panel.open': (a) => { setPanel(true); sendUI('open-panel', { name: a.name, anchor: a.anchor }); if (a.name === 'media') sendMediaState(); if (a.name === 'downloads') pushDownloads(); if (a.name === 'shields') pushShields(); },
    'panel.close': () => {
      // Closing a permission prompt without answering counts as "Block".
      const p = getPendingPermission();
      if (p) { try { p.cb(false); } catch {} clearPendingPermission(); }
      setPanel(false);
      sendUI('close-panel', {});
    },

    // ---- media ----
    'media.state': () => { const b = getManagers().browser; const m = getManagers().media; return b.activeId == null ? { count: 0, items: [] } : { count: m.count(b.activeId), ...m.list(b.activeId) }; },
    'media.download': (a) => { const b = getManagers().browser; return downloadItem(b.activeId, a.id, a.variantUrl); },
    'media.downloadAll': (a) => {
      const b = getManagers().browser; const m = getManagers().media; const out = [];
      for (const it of m.list(b.activeId).items) if (it.kind !== 'subtitle' && it.encryption !== 'drm') out.push(downloadItem(b.activeId, it.id));
      return { ok: true, count: out.filter((o) => o.ok).length };
    },
    'media.clear': () => { const b = getManagers().browser; getManagers().media.clear(b.activeId); sendMediaState(); },
    'media.remove': (a) => { const b = getManagers().browser; getManagers().media.remove(b.activeId, a.id); sendMediaState(); },

    // ---- downloads ----
    'downloads.list': () => ({ list: getManagers().downloads.list(), summary: getManagers().downloads.activeSummary() }),
    'downloads.pause': (a) => getManagers().downloads.pause(a.id),
    'downloads.resume': (a) => getManagers().downloads.resume(a.id),
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
      if (r) clipboard.writeText(a.which === 'page' ? (r.pageUrl || '') : (r.kind === 'hls' ? r.playlistUrl : (r.sources[0] || '')));
    },
    'downloads.openFolder': () => shell.openPath(getManagers().settings.get('downloadDir')),
    'downloads.openPageTab': () => getManagers().browser.openInternal('downloads'),
    'downloads.openFile': (a) => { const r = getManagers().downloads.get(a.id); if (r) shell.openPath(r.savePath); },
    'downloads.showInFolder': (a) => { const r = getManagers().downloads.get(a.id); if (r) shell.showItemInFolder(r.state === 'done' ? r.savePath : r.savePath + '.part'); },
    'downloads.addUrl': async (a) => {
      const url = (a.url || '').trim();
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Enter a http(s) link' };
      getManagers().downloads.add({ kind: /\.m3u8(\?|$)/i.test(url) ? 'hls' : 'http', url, playlistUrl: /\.m3u8(\?|$)/i.test(url) ? url : '', name: '' });
      return { ok: true };
    },

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
    'extensions.openStore': () => getManagers().browser.createTab({ url: require('./extensions').STORE_URL }),

    // ---- shields (adblock) ----
    'shields.state': () => shieldsState(),
    'shields.toggleSite': () => { const b = getManagers().browser; const t = b.activeTab(); if (t) { const on = getManagers().adblock.isWhitelisted(t.url); getManagers().adblock.setSiteEnabled(t.url, on); b.reload(t.id); } setTimeout(pushShields, 200); },
    'shields.setGlobal': (a) => { getManagers().settings.set({ adblock: !!a.enabled }); pushShields(); },

    // ---- pop-up guard responses ----
    'popup.respond': (a) => {
      const b = getManagers().browser;
      if (a.always && a.pageUrl) getManagers().popup.allowSite(a.pageUrl, a.allow);
      if (a.allow && /^https?:/.test(a.url || '')) b.createTab({ url: a.url });
    },
    'popup.setMode': (a) => getManagers().settings.set({ popupMode: a.mode }),
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
    'settings.set': (a) => { getManagers().settings.set(a.patch || {}); return getManagers().settings.all(); },
    'settings.chooseDownloadDir': async () => {
      const { win } = getManagers();
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
      if (!r.canceled && r.filePaths[0]) { getManagers().settings.set({ downloadDir: r.filePaths[0] }); }
      return getManagers().settings.all();
    },

    // ---- misc ----
    'clipboard.read': () => clipboard.readText(),
    'util.copy': (a) => clipboard.writeText(a.text || ''),
  };

  function shieldsState() {
    const { browser, adblock, settings } = getManagers();
    const t = browser.activeTab();
    return {
      global: !!settings.get('adblock'),
      siteEnabled: t ? !adblock.isWhitelisted(t.url) : true,
      site: t ? siteOf(t.url) : '',
      count: t ? adblock.count(t.wcId) : 0,
      ready: adblock.ready,
    };
  }
  function pushShields() { sendUI('shields', shieldsState()); }
  function pushDownloads() { sendUI('downloads', { list: getManagers().downloads.list(), summary: getManagers().downloads.activeSummary() }); }

  ipcMain.handle('novadm:call', async (_e, method, args) => {
    const fn = handlers[method];
    if (!fn) throw new Error('Unknown method ' + method);
    return fn(args || {});
  });
  return handlers;
}

module.exports = { registerIpc };
