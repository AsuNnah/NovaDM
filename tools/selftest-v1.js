'use strict';
// In-app self-test for 1.0 (everyday browsing), against local servers only. Two runs on the same
// profile: NOVADM_V1_PHASE=1 browses, bookmarks, finds, and quits; phase 2 starts NovaDM again and
// checks the restored tabs and "clear history when NovaDM closes".
//  history (and none from private tabs), address-bar suggestions, bookmark star + bar, find in page,
//  History page, UI size, third-party cookies blocked (HTTPS test server), restore tabs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const PHASE = process.env.NOVADM_V1_PHASE || '1';
const OUT = path.join(os.tmpdir(), `novadm-selftest-v1-${PHASE}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
const loaded = (tab) => until(() => tab.wc && !tab.wc.isLoading() && tab.wc.getURL() && tab);

module.exports = async ({ app, browser, settings, ipc, chromeView, browsing, getWindow }) => {
  const result = {};
  try {
    if (PHASE === '2') {
      // Restored: the same tabs in the same order, only the active one loaded.
      const tabs = browser.order.map((id) => browser.tabs.get(id));
      result.restored = tabs.map((t) => ({ url: t.url, loaded: !t.discarded }));
      result.activeIndex = browser.order.indexOf(browser.activeId);
      result.historyAfterClear = browsing.history.visits.length;
      result.bookmarksKept = browsing.bookmarks.items.length;
      // Clicking a restored tab loads it.
      const other = tabs.find((t) => t.discarded);
      if (other) { browser.selectTab(other.id); await loaded(other); result.loadsOnSelect = !other.discarded && !!other.wc && !!other.wc.getURL(); } // (the test server is gone now: an error page)
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
      app.exit(0);
      return;
    }

    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/a') return res.end('<title>Alpha page</title><p>needle one</p><p>needle two</p><p>and a needle three</p>');
      if (req.url === '/b') return res.end('<title>Beta page</title><p>second page</p>');
      if (req.url === '/private') return res.end('<title>Secret page</title><p>private</p>');
      res.end('<title>x</title>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // 1. History: visits with titles; private tabs leave nothing.
    const t1 = browser.tabs.get(browser.activeId);
    browser.navigate(t1.id, base + '/a');
    await loaded(t1); await sleep(300);
    const t2 = browser.tabs.get(browser.createTab({ url: base + '/b' }));
    await loaded(t2); await sleep(300);
    const tp = browser.tabs.get(browser.createTab({ url: base + '/private', incognito: true }));
    await loaded(tp); await sleep(300);
    browser.closeTab(tp.id);
    const hist = (await ipc['history.search']({ q: '' })).items;
    result.history = { titles: hist.map((h) => h.title), privateRecorded: hist.some((h) => /private/.test(h.url)) };
    result.historySearch = (await ipc['history.search']({ q: 'beta' })).items.map((h) => h.title);

    // 2. Address-bar suggestions.
    const sug = await ipc['omni.suggest']({ q: '127.0.0.1', left: 100, width: 500 });
    result.suggestions = sug.items.map((i) => i.url.replace(base, ''));
    await ipc['omni.hide']();

    // 3. Bookmark star → bookmarks bar under the toolbar.
    browser.selectTab(t1.id);
    const before = browsing.chromeHeight();
    await ipc['bookmarks.toggleActive']();
    await sleep(500);
    const bar = await chromeView.webContents.executeJavaScript("({ shown: !document.getElementById('bmbar').classList.contains('hidden'), chips: document.querySelectorAll('#bm-items .bm').length, star: document.getElementById('star-btn').classList.contains('on') })");
    result.bookmark = { heightBefore: before, heightAfter: browsing.chromeHeight(), bar, viewHeight: chromeView.getBounds().height };

    // 4. Find in page.
    await ipc['find.open']();
    await sleep(300);
    const fv = browsing.findView.webContents;
    await fv.executeJavaScript("document.getElementById('q').value='needle'; document.getElementById('q').dispatchEvent(new Event('input'))");
    const count = await until(async () => { const c = await fv.executeJavaScript("document.getElementById('count').textContent"); return /of 3/.test(c) && c; }, 5000);
    await fv.executeJavaScript("document.getElementById('next').click()");
    await sleep(300);
    result.find = { shown: browsing.findOpen, count, afterNext: await fv.executeJavaScript("document.getElementById('count').textContent") };
    await ipc['find.close']();

    // 5. History page lists the visits.
    browser.openInternal('history');
    const ht = browser.activeTab();
    await loaded(ht); await sleep(800);
    result.historyPage = await ht.wc.executeJavaScript("document.querySelectorAll('.row').length");

    // 6. Size of NovaDM's screens.
    settings.set({ uiScale: '125' });
    await sleep(400);
    result.uiScale = { zoom: chromeView.webContents.getZoomFactor(), chromeHeight: chromeView.getBounds().height };
    settings.set({ uiScale: '100' });

    // 7. Third-party cookies: an HTTPS page embeds another site that tries to set and read a cookie.
    // NOVADM_TLS_DIR: a folder with a throwaway key.pem + cert.pem for localhost (not kept in the repo).
    const tlsDir = process.env.NOVADM_TLS_DIR || '';
    const key = path.join(tlsDir, 'key.pem');
    if (!tlsDir || !fs.existsSync(key)) result.thirdPartyCookies = 'skipped: set NOVADM_TLS_DIR';
    else {
      const seen = [];
      const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(path.join(tlsDir, 'cert.pem')) }, (req, res) => {
        res.setHeader('content-type', 'text/html');
        if (req.url === '/top') return res.end(`<iframe src="https://localhost:${srv.address().port}/frame"></iframe>`);
        if (req.url === '/frame') { seen.push('header:' + (req.headers.cookie || '')); res.setHeader('set-cookie', 'tp=1; SameSite=None; Secure'); return res.end('<script>document.cookie="tpjs=1; SameSite=None; Secure";setTimeout(function(){fetch("/r?c="+encodeURIComponent(document.cookie))},150)</script>'); }
        if (req.url.startsWith('/r')) { seen.push('js:' + decodeURIComponent(req.url.split('c=')[1] || '')); return res.end(); }
        res.end();
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      browser.normalSession.setCertificateVerifyProc((_r, cb) => cb(0)); // test certificate
      const tt = browser.tabs.get(browser.createTab({ url: `https://127.0.0.1:${srv.address().port}/top` }));
      await loaded(tt); await sleep(900);
      tt.wc.reload(); await loaded(tt); await sleep(900);
      const jar = await browser.normalSession.cookies.get({ domain: 'localhost' });
      result.thirdPartyCookies = { setting: settings.get('blockThirdPartyCookies'), seen, stored: jar.map((c) => c.name) };
      browser.closeTab(tt.id);
      browser.normalSession.setCertificateVerifyProc(null);
      srv.close();
    }

    // For phase 2: two web tabs open (Beta active), clear history on exit.
    browser.closeTab(ht.id);
    browser.selectTab(t2.id);
    settings.set({ clearHistoryOnExit: true });
    await sleep(1800); // session file is saved after 1.5 s
    result.sessionFile = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'session.json'), 'utf8'));
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.quit(); // a normal quit: runs "clear when NovaDM closes" and saves the tabs
};
