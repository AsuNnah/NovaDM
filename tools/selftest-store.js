'use strict';
// Diagnose how the Chrome Web Store sees NovaDM.
const fs = require('fs');
const os = require('os');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'novadm-selftest-store.json');

module.exports = async ({ app, browser }) => {
  const result = {};
  try {
    const ext = global.__novadmExtensions;
    const t0 = Date.now();
    while (!(ext && ext.ready) && Date.now() - t0 < 30000) await sleep(250);
    const tab = browser.activeTab();
    const logs = [];
    tab.wc.on('console-message', (e) => { const m = e.message || ''; if (/webstore|Chrome Web Store|electron|Injecting/i.test(m)) logs.push(m.slice(0, 200)); });
    const done = new Promise((r) => tab.wc.once('did-finish-load', r));
    browser.navigate(tab.id, 'https://chromewebstore.google.com/detail/eimadpbcbfnmbkopoojfekhnkhdbieeh');
    await Promise.race([done, sleep(20000)]);
    await sleep(5000);
    result.page = await tab.wc.executeJavaScript(`(async () => ({
      chromeType: typeof chrome,
      webstorePrivate: typeof (window.chrome && chrome.webstorePrivate),
      runtime: typeof (window.chrome && chrome.runtime),
      ua: navigator.userAgent,
      brands: navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand + ' ' + b.version) : null,
      buttons: [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean).slice(0, 12),
      switchText: /switch to chrome/i.test(document.body.innerText),
    }))()`);
    result.consoleLogs = logs.slice(0, 6);

    // Click "Add to NovaDM" on another extension (JSON Formatter) like a user would.
    const JSONF = 'bcjindcccaagfpapjjmafapmmgkkhgoa';
    const before = ext.list().map((e) => e.id);
    const done2 = new Promise((r) => tab.wc.once('did-finish-load', r));
    browser.navigate(tab.id, 'https://chromewebstore.google.com/detail/' + JSONF);
    await Promise.race([done2, sleep(20000)]);
    await sleep(5000);
    const pos = await tab.wc.executeJavaScript(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^Add to /i.test(x.innerText.trim()));
      if (!b) return null;
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      return { text: b.innerText.trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    result.addButton = pos && pos.text;
    if (pos) {
      await sleep(400);
      tab.wc.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
      tab.wc.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      tab.wc.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
      const t1 = Date.now();
      while (Date.now() - t1 < 30000 && !ext.list().some((e) => e.id === JSONF)) await sleep(500);
    }
    result.installedByClick = ext.list().some((e) => e.id === JSONF) && !before.includes(JSONF);
    result.extensions = ext.list().map((e) => e.name);
    await sleep(1500);
    result.buttonAfter = await tab.wc.executeJavaScript(`[...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(t => /from |to /i.test(t)).slice(0, 3)`);
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
