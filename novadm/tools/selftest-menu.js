'use strict';
// In-app self-test: right-click menu contents, "Download link with NovaDM", and extension popup.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow, webContents } = require('electron');
const { buildContextMenuTemplate } = require('../src/main/contextmenu');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'novadm-selftest-menu.json');

module.exports = async ({ app, browser, downloads, settings, chromeView }) => {
  const result = {};
  try {
    const ext = global.__novadmExtensions;
    const t0 = Date.now();
    while (!(ext && ext.ready) && Date.now() - t0 < 30000) await sleep(250);
    const tab = browser.activeTab();
    tab.url = 'https://example.org/page';
    const ctx = (params) => ({ tab, params: { x: 1, y: 1, editFlags: {}, ...params }, browser, downloads, settings, extensions: ext });
    const labels = (t) => t.filter((i) => i.type !== 'separator').map((i) => i.label);
    result.link = labels(buildContextMenuTemplate(ctx({ linkURL: 'https://example.org/file.zip' })));
    result.image = labels(buildContextMenuTemplate(ctx({ mediaType: 'image', srcURL: 'https://example.org/a.png' })));
    result.video = labels(buildContextMenuTemplate(ctx({ mediaType: 'video', srcURL: 'https://example.org/v.mp4' })));
    result.editable = labels(buildContextMenuTemplate(ctx({ isEditable: true, editFlags: { canPaste: true } })));
    result.selection = labels(buildContextMenuTemplate(ctx({ selectionText: 'novadm browser' })));
    result.page = labels(buildContextMenuTemplate(ctx({})));

    // "Download link with NovaDM" adds a download with the page as Referer.
    const before = downloads.list().length;
    const item = buildContextMenuTemplate(ctx({ linkURL: 'https://example.org/file.zip' })).find((i) => i.label === 'Download link with NovaDM');
    item.click();
    await sleep(300);
    const added = downloads.list()[0];
    result.downloadLink = { added: downloads.list().length === before + 1, name: added && added.name, page: added && added.pageUrl };
    if (added) await downloads.cancel(added.id, true);

    // Clicking the extension button opens its popup window.
    const winsBefore = BrowserWindow.getAllWindows().length;
    const pos = await chromeView.webContents.executeJavaScript(`(() => { const b = document.querySelector('browser-action-list').shadowRoot.querySelector('.action'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), title: b.title }; })()`);
    result.actionButton = pos && pos.title;
    if (pos) {
      chromeView.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
      chromeView.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      chromeView.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      await sleep(3000);
      const popups = BrowserWindow.getAllWindows().slice(winsBefore);
      result.popup = popups.map((w) => ({ url: w.webContents.getURL().slice(0, 80), w: w.getBounds().width, h: w.getBounds().height, visible: w.isVisible() }));
      if (popups[0]) fs.writeFileSync(path.join(os.tmpdir(), 'novadm-ext-popup.png'), (await popups[0].webContents.capturePage()).toPNG());
    }
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
