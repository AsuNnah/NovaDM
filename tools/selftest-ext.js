'use strict';
// In-app self-test: Chrome Web Store install, extension running in pages, toolbar button, UA.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'novadm-selftest-ext.json');
const DARK_READER = 'eimadpbcbfnmbkopoojfekhnkhdbieeh';

function server() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><title>Light page</title><body style="background:#fff;color:#000;font:20px sans-serif"><h1>Light page</h1><p>Some text.</p></body>');
    });
    s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${s.address().port}`));
  });
}

async function load(browser, tab, url) {
  const done = new Promise((r) => tab.wc.once('did-finish-load', r));
  browser.navigate(tab.id, url);
  await Promise.race([done, sleep(20000)]);
}

module.exports = async ({ app, browser, chromeView }) => {
  const result = {};
  try {
    const { installExtension } = require(require.resolve('electron-chrome-web-store', { paths: [path.join(__dirname, '..')] }));
    // Wait for the extension system.
    const ext = global.__novadmExtensions;
    const t0 = Date.now();
    while (!(ext && ext.ready) && Date.now() - t0 < 30000) await sleep(250);
    result.ready = !!(ext && ext.ready);

    const already = ext.list().some((e) => e.id === DARK_READER);
    if (!already) await installExtension(DARK_READER, { session: browser.normalSession, extensionsPath: path.join(app.getPath('userData'), 'Extensions') });
    result.installed = ext.list().map((e) => `${e.name} ${e.version}`);

    const base = await server();
    const tab = browser.activeTab();
    await load(browser, tab, base + '/');
    await sleep(3000);
    result.page = await tab.wc.executeJavaScript(`({
      darkReaderActive: !!document.querySelector('style.darkreader, [data-darkreader-mode], [data-darkreader-scheme]') || document.documentElement.hasAttribute('data-darkreader-mode'),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      ua: navigator.userAgent,
    })`);

    // Toolbar button.
    result.toolbar = await chromeView.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('browser-action-list');
      const root = list && list.shadowRoot;
      return { element: !!list, buttons: root ? root.querySelectorAll('browser-action, button').length : -1 };
    })()`);
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-ext-chrome.png'), (await chromeView.webContents.capturePage()).toPNG());

    // The Chrome Web Store page recognises NovaDM (shows Add/Remove for the extension).
    await load(browser, tab, 'https://chromewebstore.google.com/detail/' + DARK_READER);
    await sleep(5000);
    result.store = await tab.wc.executeJavaScript(`(() => {
      const t = document.body.innerText;
      return { addOrRemove: /Add to (Chrome|NovaDM)|Remove from (Chrome|NovaDM)/i.test(t), switchToChrome: /switch to chrome/i.test(t), title: document.title };
    })()`);
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-ext-store.png'), (await tab.wc.capturePage()).toPNG());
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
