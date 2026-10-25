'use strict';
// In-app self-test for 1.7.7: Settings, Downloads, Bookmarks and History are open once per window. Asking for one
// again (menu, shortcut, notification, ?section=…) goes to the open tab; real web pages and the new-tab page still
// open a new tab every time; closing the tab makes the next request open it again.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-internaltabs.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ app, browser, ipc }) => {
  const result = {};
  let server;
  try {
    server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>page ${req.url}</title>hello`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ask = async (url) => { const id = await ipc['tabs.new']({ url }); await sleep(350); return id; };
    const count = () => browser.order.length;
    const urlOf = (id) => browser.tabs.get(id).wc.getURL();
    const c = {};

    const web = await ask(base + '/a');
    const n0 = count();
    const first = await ask('novadm://settings');
    c.firstOpens = count() === n0 + 1 && browser.activeId === first;

    browser.selectTab(web); await sleep(200);
    const again = await ask('novadm://settings');
    c.againGoesToOpenTab = again === first && count() === n0 + 1 && browser.activeId === first;

    browser.selectTab(web); await sleep(200);
    const section = await ask('novadm://settings?section=about'); await sleep(900);
    c.sectionGoesThere = section === first && count() === n0 + 1 && browser.activeId === first && /section=about/.test(urlOf(first));

    browser.selectTab(web); await sleep(200);
    const plain = await ask('novadm://settings'); await sleep(300);
    c.plainRequestKeepsSection = plain === first && /section=about/.test(urlOf(first));

    // The other pages, the keyboard / notification path (openInternal) and the "clear browsing data" path (openPage with ?clear=1).
    let n = count();
    const others = {};
    for (const page of ['downloads', 'bookmarks', 'history']) {
      const a = await ask(`novadm://${page}`);
      browser.selectTab(web); await sleep(150);
      const b = await ask(`novadm://${page}`);
      browser.selectTab(web); await sleep(150);
      const viaShortcut = browser.openInternal(page); await sleep(250);
      others[page] = a === b && b === viaShortcut && count() === n + 1 && browser.activeId === a;
      n = count();
    }
    c.otherPagesOncePerWindow = Object.values(others).every(Boolean);
    c.otherPages = others;
    const hist = browser.order.find((id) => browser.tabs.get(id).url === 'novadm://history');
    browser.selectTab(web); await sleep(150);
    const clear = browser.openPage('novadm://history?clear=1'); await sleep(900);
    c.clearDataUsesOpenHistory = clear === hist && count() === n && /clear=1/.test(urlOf(hist));

    // Real web pages and the new-tab page: a new tab every time.
    n = count();
    const w1 = await ask(base + '/b'); const w2 = await ask(base + '/b');
    const t1 = await ipc['tabs.new']({}); await sleep(250); const t2 = await ipc['tabs.new']({}); await sleep(250);
    c.webPagesAreNewTabs = new Set([w1, w2]).size === 2 && count() === n + 2 + 2 && new Set([t1, t2]).size === 2;

    // Close the settings tab: the next request opens it again.
    browser.closeTab(first); await sleep(300);
    n = count();
    const reopened = await ask('novadm://settings');
    c.reopensAfterClose = count() === n + 1 && browser.activeId === reopened && reopened !== first;

    result.checks = c;
    result.ok = Object.entries(c).filter(([k]) => k !== 'otherPages').every(([, v]) => v === true);
  } catch (e) { result.error = String((e && e.stack) || e); }
  try { if (server) server.close(); } catch {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
