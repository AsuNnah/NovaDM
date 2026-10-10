'use strict';
// In-app self-test for private windows: Ctrl+Shift+N opens a separate purple window with its own
// tabs; the normal window is untouched; closing the last private tab closes the window and deletes
// the private cookies; the tabs saved for next start are the normal ones only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { BaseWindow } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-private.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
const SHOTS = process.env.NOVADM_SHOT_DIR || '';

module.exports = async ({ app, browser, ipc, browsing }) => {
  const result = {};
  const privWin = () => BaseWindow.getAllWindows().find((w) => /Private/.test(w.getTitle()));
  const toolbarOf = (w) => w.contentView.children.map((v) => v.webContents).find((wc) => /[\\/]ui[\\/]chrome\.html/.test(wc.getURL()));
  const key = (wc, keyCode, modifiers = []) => { for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode, modifiers }); };
  try {
    const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'who=private-test; Path=/; Max-Age=600' }); res.end('<title>Cookie page</title>x'); });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    const normalBefore = browser.groups.normal.order.length;

    // 1. Ctrl+Shift+N in a normal tab: a separate private window.
    key(browser.groups.normal.activeId != null ? browser.tabs.get(browser.groups.normal.activeId).wc : null, 'N', ['control', 'shift']);
    await until(() => privWin(), 5000);
    const pw = privWin();
    await sleep(1500);
    result.opened = { windows: BaseWindow.getAllWindows().length, title: pw && pw.getTitle(), privateTabs: browser.groups.private.order.length, normalTabsUnchanged: browser.groups.normal.order.length === normalBefore };

    // 2. Its look: purple class, Private badge, private new tab page.
    const chromeWc = toolbarOf(pw);
    result.look = await chromeWc.executeJavaScript(`({ privateClass: document.documentElement.classList.contains('private'), badge: getComputedStyle(document.getElementById('priv-pill')).display, bg: getComputedStyle(document.body).backgroundColor, tabsShown: document.querySelectorAll('.tab').length })`);
    const ptab = browser.tabs.get(browser.groups.private.activeId);
    result.newTabPage = await ptab.wc.executeJavaScript(`({ greet: document.getElementById('greet').textContent, note: getComputedStyle(document.querySelector('.privnote')).display, stats: getComputedStyle(document.querySelector('.stats')).display })`);
    if (SHOTS) {
      fs.writeFileSync(path.join(SHOTS, 'private-toolbar.png'), (await chromeWc.capturePage()).toPNG());
      fs.writeFileSync(path.join(SHOTS, 'private-newtab.png'), (await ptab.wc.capturePage()).toPNG());
    }

    // 3. Ctrl+T in the private window: another private tab there; a page's cookie stays private.
    key(ptab.wc, 'T', ['control']);
    await until(() => browser.groups.private.order.length === 2, 3000);
    const ptab2 = browser.tabs.get(browser.groups.private.activeId);
    browser.navigate(ptab2.id, `http://127.0.0.1:${site.address().port}/`);
    await until(() => /Cookie page/.test(ptab2.wc.getTitle()));
    result.tabs = { privateTabs: browser.groups.private.order.length, normalTabs: browser.groups.normal.order.length, incognito: ptab2.incognito };
    result.cookies = {
      privateHasIt: (await browser.incognitoSession.cookies.get({ name: 'who' })).length,
      normalHasIt: (await browser.normalSession.cookies.get({ name: 'who' })).length,
    };

    // 4. Closing both private tabs closes the window and deletes the private cookies.
    for (const id of [...browser.groups.private.order]) browser.closeTab(id);
    await until(() => !privWin(), 4000);
    await sleep(800);
    result.closed = {
      windows: BaseWindow.getAllWindows().length,
      privateCookiesLeft: (await browser.incognitoSession.cookies.get({})).length,
      normalTabs: browser.groups.normal.order.length,
      restoreList: browsing.tabSession.load().tabs.length,
    };

    // 5. A private window again, closed with its window button this time.
    ipc['tabs.new']({ incognito: true });
    await until(() => privWin(), 4000);
    await sleep(500);
    privWin().close();
    await until(() => !privWin(), 4000);
    result.closedByWindow = { windows: BaseWindow.getAllWindows().length, privateTabs: browser.groups.private.order.length, normalStillWorks: !!browser.activeTab() };

    // 6. Each window has its own find bar.
    ipc['tabs.new']({ incognito: true });
    await until(() => privWin(), 4000);
    await sleep(800);
    const findViews = (w) => w.contentView.children.filter((v) => /[\\/]ui[\\/]find\.html/.test(v.webContents.getURL())).length;
    const mainWin = BaseWindow.getAllWindows().find((w) => !/Private/.test(w.getTitle()));
    result.findBars = { main: findViews(mainWin), private: findViews(privWin()) };

    // 7. Closing the main window keeps the private window (as in Chrome); the saved tabs stay.
    const saved = browsing.tabSession.load().tabs.length;
    mainWin.close();
    await until(() => BaseWindow.getAllWindows().length === 1, 4000);
    await sleep(500);
    result.mainClosed = { windows: BaseWindow.getAllWindows().length, privateStillOpen: !!privWin(), privateTabs: browser.groups.private.order.length, normalTabs: browser.groups.normal.order.length, savedTabsKept: browsing.tabSession.load().tabs.length === saved };
    // The Downloads page from the private window brings a normal window back.
    ipc['downloads.openPageTab']();
    await until(() => BaseWindow.getAllWindows().length === 2, 4000);
    await sleep(800);
    const back = BaseWindow.getAllWindows().find((w) => !/Private/.test(w.getTitle()));
    result.normalBack = { windows: BaseWindow.getAllWindows().length, normalTabs: browser.groups.normal.order.length, page: browser.groups.normal.activeId != null && browser.tabs.get(browser.groups.normal.activeId).url, findBar: back ? findViews(back) : 0 };
    site.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
