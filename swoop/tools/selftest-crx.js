'use strict';
// Diagnose crx:// icon loading from the toolbar page.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'swoop-selftest-crx.json');

module.exports = async ({ app, chromeView }) => {
  const result = {};
  try {
    const ext = global.__swoopExtensions;
    const t0 = Date.now();
    while (!(ext && ext.ready) && Date.now() - t0 < 30000) await sleep(250);
    await sleep(1500);
    const dr = ext.list().find((e) => /dark reader/i.test(e.name));
    const url = `crx://extension-icon/${dr.id}/32/2?tabId=-1&partition=persist%3Abrowser`;
    result.url = url;
    result.img = await chromeView.webContents.executeJavaScript(`new Promise((res) => {
      const img = new Image();
      const t = setTimeout(() => res('timeout'), 5000);
      img.onload = () => { clearTimeout(t); res('load ' + img.naturalWidth + 'x' + img.naturalHeight); };
      img.onerror = (e) => { clearTimeout(t); res('error'); };
      img.src = ${JSON.stringify(url)};
    })`);
    result.fetch = await chromeView.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then(r => r.status + ' ' + r.headers.get('content-type')).catch(e => 'fetch error: ' + e.message)`);
    const { session } = require('electron');
    result.handled = await session.defaultSession.protocol.isProtocolHandled('crx');
    result.visibility = await chromeView.webContents.executeJavaScript(`document.visibilityState`);
    result.raf = await chromeView.webContents.executeJavaScript(`new Promise((r) => { const t = setTimeout(() => r('no frame in 2s'), 2000); requestAnimationFrame(() => { clearTimeout(t); r('frame ok'); }); })`);
    result.buttonBg = await chromeView.webContents.executeJavaScript(`(() => { const b = document.querySelector('browser-action-list').shadowRoot.querySelector('.action'); return b ? (b.style.backgroundImage || 'none') + ' title=' + b.title : 'no button'; })()`);
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
