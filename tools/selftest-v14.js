'use strict';
// In-app self-test for 1.4.0: address bar focus in new tabs, Tab to search, tab search (Ctrl+Shift+A),
// the add-on warning on the menu button, and the problem report (no personal data). Offline: the
// site search is caught before it leaves (proxy to a closed port).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-v14.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

module.exports = async ({ app, browser, settings, ipc, chromeView, overlayView, getWindow }) => {
  const result = {};
  const ui = (js) => chromeView.webContents.executeJavaScript(js);
  const typeIn = (wc, text) => { for (const ch of text) wc.sendInputEvent({ type: 'char', keyCode: ch }); };
  const key = (wc, keyCode, modifiers = []) => { for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode, modifiers }); };
  try {
    const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${decodeURIComponent(req.url.slice(1)).replace(/[^A-Za-z]/g, "")} page</title>x`); });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${site.address().port}/`;

    // 1. A new tab puts the cursor in the address bar.
    ipc['tabs.new']({});
    await sleep(1500);
    result.newTabFocus = { windowForeground: !!(getWindow() && getWindow().isFocused()), toolbarFocused: chromeView.webContents.isFocused(), activeElement: await ui('document.activeElement.id') };

    // 2. Tab to search: "youtube", Tab, "lofi cats", Enter.
    await browser.normalSession.setProxy({ proxyRules: 'http=127.0.0.1:9;https=127.0.0.1:9', proxyBypassRules: '<-loopback>' });
    const tab = browser.activeTab();
    const started = [];
    tab.wc.on('did-start-navigation', (d) => { if (d.isMainFrame) started.push(d.url); });
    typeIn(chromeView.webContents, 'youtube');
    result.tabHint = await until(() => ui("!document.getElementById('tab-hint').classList.contains('hidden') && document.getElementById('tab-hint').textContent"), 3000);
    key(chromeView.webContents, 'Tab');
    await sleep(200);
    result.chip = await ui("document.getElementById('site-chip').textContent");
    typeIn(chromeView.webContents, 'lofi cats');
    key(chromeView.webContents, 'Enter');
    await until(() => started.length, 4000);
    result.searched = started[0] || '';
    result.searchOk = result.searched === 'https://www.youtube.com/results?search_query=lofi%20cats';
    await browser.normalSession.setProxy({ mode: 'system' });

    // 3. Tab search: three pages, Ctrl+Shift+A, "beta", Enter.
    for (const n of ['Alpha', 'Beta', 'Gamma']) ipc['tabs.new']({ url: base + n });
    await until(() => browser.order.map((id) => browser.tabs.get(id)).filter((t) => /page$/.test(t.title)).length === 3);
    const before = browser.activeTab().title;
    key(browser.activeTab().wc, 'A', ['control', 'shift']);
    await until(() => overlayView.webContents.executeJavaScript("!!document.querySelector('#content input')"), 3000);
    typeIn(overlayView.webContents, 'beta');
    await sleep(200);
    result.tabSearch = { before, rows: await overlayView.webContents.executeJavaScript("document.querySelectorAll('#content .srow').length") };
    key(overlayView.webContents, 'Enter');
    await sleep(400);
    result.tabSearch.after = browser.activeTab().title;

    // 4. Add-on warning: nothing installed in a fresh profile, so the menu button warns.
    settings.set({ addonRemindOff: [] });
    ipc['addons.dismiss']({ id: 'none' }); // pushes the state
    await sleep(200);
    const badge = () => ui("!document.getElementById('menu-badge').classList.contains('hidden')");
    result.addons = { missing: ipc['addons.state']().missing.map((a) => a.id), badge: await badge() };
    ipc['panel.open']({ name: 'menu' });
    await sleep(300);
    result.addons.menuText = (await overlayView.webContents.executeJavaScript("document.getElementById('content').innerText")).split('\n').filter((l) => /not installed|Report a problem/.test(l));
    for (const id of ['ytdlp', 'ffmpeg', 'aria2']) ipc['addons.dismiss']({ id });
    await sleep(200);
    result.addons.badgeAfterDismiss = await badge();
    ipc['panel.close']();
    settings.set({ addonRemindOff: [] });

    // 5. Problem report: an error with personal data in it must come out clean.
    const home = os.homedir();
    console.error(`selftest: failed https://secret.example/inbox?token=abc123 saving ${path.join(home, 'Documents', 'taxes-2026.pdf')} for ${os.userInfo().username}@${os.hostname()}`);
    const text = await ipc['diagnostics.report']();
    // The fixed header links to the project's GitHub page; everything after it is the redacted body.
    const body = text.slice(text.indexOf('## Versions'));
    const leaks = [home, os.userInfo().username, os.hostname(), 'token=abc123', 'inbox', 'taxes-2026'].filter((s) => body.toLowerCase().includes(s.toLowerCase()));
    result.report = {
      leaks,
      hasSite: text.includes('https://secret.example/…'),
      sections: (text.match(/^## .*/gm) || []),
      bytes: text.length,
      errorLine: (text.split('\n').find((l) => l.includes('selftest: failed')) || ''),
    };
    // 6. The toolbar/panel channel answers NovaDM's own pages only: a web page in a view with the
    // same preload is refused.
    const { WebContentsView } = require('electron');
    const probe = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '..', 'src', 'ui', 'preload-ui.js'), contextIsolation: true, sandbox: false } });
    const ask = () => probe.webContents.executeJavaScript("window.novadm.call('addons.state').then(() => 'answered', (e) => 'refused: ' + e.message)");
    await probe.webContents.loadURL(base + 'Evil');
    const fromWeb = await ask();
    await probe.webContents.loadFile(path.join(__dirname, '..', 'src', 'ui', 'find.html'));
    result.uiChannel = { fromWebPage: fromWeb, fromNovaDmPage: await ask() };
    probe.webContents.close();

    // 7. Ctrl+Shift+J opens DevTools on the Console; Ctrl+Shift+C starts the element picker.
    const page = browser.activeTab().wc;
    key(page, 'J', ['control', 'shift']);
    await until(() => page.isDevToolsOpened() && page.devToolsWebContents, 6000);
    await sleep(2500);
    const dt = page.devToolsWebContents;
    result.devtools = {
      opened: page.isDevToolsOpened(),
      api: await dt.executeJavaScript("typeof DevToolsAPI.showPanel + ' ' + typeof DevToolsAPI.enterInspectElementMode").catch((e) => String(e)),
    };
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-devtools-console.png'), (await dt.capturePage()).toPNG());
    key(page, 'C', ['control', 'shift']);
    await sleep(1000);
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-devtools-inspect.png'), (await dt.capturePage()).toPNG());
    page.closeDevTools();
    site.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
