'use strict';
// Diagnose the extension buttons in the toolbar.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'novadm-selftest-toolbar.json');

module.exports = async ({ app, chromeView }) => {
  const result = { console: [] };
  chromeView.webContents.on('console-message', (e) => result.console.push(`${e.level}: ${String(e.message).slice(0, 220)}`));
  try {
    const ext = global.__novadmExtensions;
    const t0 = Date.now();
    while (!(ext && ext.ready) && Date.now() - t0 < 30000) await sleep(250);
    await sleep(3000);
    result.dom = await chromeView.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('browser-action-list');
      if (!list) return { list: false };
      const r = list.getBoundingClientRect();
      const root = list.shadowRoot;
      const actions = root ? [...root.querySelectorAll('*')].map(n => {
        const b = n.getBoundingClientRect();
        return { tag: n.tagName.toLowerCase(), cls: n.className || '', w: Math.round(b.width), h: Math.round(b.height), bg: getComputedStyle(n).backgroundImage.slice(0, 120) };
      }) : [];
      return { list: true, defined: !!customElements.get('browser-action-list'), w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(list).display, html: root ? root.innerHTML.slice(0, 600) : 'no shadow', actions };
    })()`);
    result.extensions = ext.list().map((e) => e.name);
    await sleep(2000);
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-ext-chrome.png'), (await chromeView.webContents.capturePage()).toPNG());
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
