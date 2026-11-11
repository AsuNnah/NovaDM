'use strict';
// In-app self-test for 1.8.0 (SEC-108): NovaDM's own pages load from app://ui/ and still work (their calls, the
// private look), the toolbar and panel views too; a web page can't open, frame, redirect to or pop up an app:// page,
// and a typed app:// address doesn't open the page. Made-up pages on this PC only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-appscheme.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

module.exports = async ({ app, browser, ipc, chromeView, overlayView }) => {
  const result = { checks: {} };
  const c = result.checks;
  let server;
  try {
    server = http.createServer((req, res) => {
      res.writeHead(req.url === '/redirect' ? 302 : 200, req.url === '/redirect' ? { location: 'app://ui/settings.html' } : { 'content-type': 'text/html' });
      res.end(req.url === '/frame' ? '<title>framer</title><iframe id="f" src="app://ui/settings.html"></iframe>' : '<title>web</title>web');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tabOf = (id) => browser.tabs.get(id);
    const settled = (id) => until(() => { const t = tabOf(id); return t && t.wc && !t.loading ? t : null; });

    // 1. The UI views and every internal page come from app://ui/.
    c.toolbarOnApp = chromeView.webContents.getURL().startsWith('app://ui/chrome.html');
    c.panelOnApp = overlayView.webContents.getURL().startsWith('app://ui/panel.html');
    result.pages = {};
    for (const page of ['newtab', 'settings', 'downloads', 'bookmarks', 'history']) {
      const id = await ipc['tabs.new']({ url: `novadm://${page}` });
      const t = await settled(id); await sleep(300);
      const r = await t.wc.executeJavaScript(`({ url: location.href, bridge: typeof window.novadmInternal === 'object', body: document.body.innerText.length })`).catch((e) => ({ error: e.message }));
      result.pages[page] = { ...r, shown: t.url };
      c[`${page}Loads`] = /^app:\/\/ui\//.test(r.url || '') && r.bridge && r.body > 0 && t.url === `novadm://${page}`;
    }
    // Their calls work (the bridge trusts app://ui): the Downloads page lists downloads.
    const dl = [...browser.tabs.values()].find((t) => t.url === 'novadm://downloads');
    c.internalCallsWork = !!(await dl.wc.executeJavaScript(`window.novadmInternal.call('downloads.list').then((l) => Array.isArray(l) || (l && typeof l === 'object'))`).catch(() => false));

    // 2. A web page can't reach app://: navigation, redirect, frame, pop-up.
    const web = await ipc['tabs.new']({ url: base + '/' }); const w = await settled(web);
    await w.wc.executeJavaScript(`location.href = 'app://ui/settings.html'`).catch(() => {}); await sleep(700);
    c.webCantNavigate = !/^app:/.test(w.wc.getURL());
    await w.wc.loadURL(base + '/redirect').catch(() => {}); await sleep(700);
    c.webCantRedirect = !/^app:/.test(w.wc.getURL());
    await w.wc.loadURL(base + '/frame').catch(() => {}); await sleep(900);
    c.webCantFrame = w.wc.mainFrame.frames.every((f) => !/^app:/.test(f.url) || f.url === '');
    const before = browser.order.length;
    await w.wc.executeJavaScript(`window.open('app://ui/settings.html'); 1`).catch(() => {}); await sleep(700);
    c.webCantPopUp = browser.order.length === before;
    // 3. A typed app:// address never opens NovaDM's page (the address bar makes it a web address).
    const typed = await ipc['tabs.new']({ url: 'app://ui/settings.html' }); const tt = await settled(typed); await sleep(500);
    c.typedAppNotOpened = !/^app:\/\/ui\/settings/.test(tt.wc.getURL()) && tt.url !== 'novadm://settings';

    // 4. In a private window the page gets the private look.
    ipc['tabs.new']({ incognito: true, url: 'novadm://settings' });
    const p = await until(() => [...browser.tabs.values()].find((t) => t.incognito && t.url === 'novadm://settings' && t.wc && !t.loading));
    await sleep(400);
    c.privateLook = !!p && await p.wc.executeJavaScript(`document.documentElement.classList.contains('private') && location.search.includes('private=1')`).catch(() => false);

    result.ok = Object.values(c).every(Boolean);
  } catch (e) {
    result.fatal = String((e && e.stack) || e);
  }
  try { if (server) server.close(); } catch {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
