'use strict';
// In-app self-test for 1.7.9: a private window takes nothing from normal browsing. Its address bar suggests bookmarks
// but no history; its new-tab counters, downloads popup and download badge count its own tabs only; Ctrl+Shift+T there
// brings back no normal tab; a site allowed in a normal tab asks again in a private one (a block still applies), and
// "remember" in a private tab is kept out of the settings and forgotten when the private window closes.
// Made-up sites on this PC only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { BaseWindow } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-privateiso.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

module.exports = async ({ app, browser, ipc, browsing, downloads, adblock, settings }) => {
  const result = { checks: {} };
  const c = result.checks;
  let server;
  const privWin = () => BaseWindow.getAllWindows().find((w) => /Private/.test(w.getTitle()));
  const normWin = () => BaseWindow.getAllWindows().find((w) => !/Private/.test(w.getTitle()));
  const viewOf = (w, file) => w && w.contentView.children.map((v) => v.webContents).find((wc) => new RegExp(`[\\\\/]ui[\\\\/]${file}\\.html`).test(wc.getURL()));
  const key = (wc, keyCode, modifiers = []) => { for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode, modifiers }); };
  const stats = (tab) => tab.wc.executeJavaScript('window.novadmInternal.stats()');
  const ntp = (id) => until(() => { const t = browser.tabs.get(id); return t && t.wc && !t.wc.isLoading() && /newtab/.test(t.wc.getURL()) ? t : null; });
  const loaded = (id) => until(() => { const t = browser.tabs.get(id); return t && t.wc && !t.loading && t.title && !/^(New tab|Loading)/i.test(t.title) ? t : null; });
  try {
    const slow = Buffer.alloc(4 * 1024 * 1024, 7);
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/slow')) { // trickles, so it is still running while the badges are read
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': slow.length });
        let off = 0;
        const tick = () => { if (res.destroyed || off >= slow.length) return res.end(); res.write(slow.subarray(off, off + 8192)); off += 8192; setTimeout(tick, 250); };
        return tick();
      }
      if (req.url.startsWith('/file')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 2048 }); return res.end(Buffer.alloc(2048, 1)); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>Page ${req.url}</title>x`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const origin = new URL(base).origin;
    const otherOrigin = `http://localhost:${port}`; // a second "site", never seen by the normal window

    // Normal browsing: a visit, a bookmark, a closed tab, a finished and a running download, an ad and a pop-up
    // blocked, one site allowed notifications and blocked from location.
    browsing.history.add(`${base}/zebra-visited`, 'Zebra visited page');
    browsing.bookmarks.add({ url: `${base}/zebra-saved`, title: 'Zebra saved page', parent: 'bar' });
    const gone = browser.createTab({ url: `${base}/closed-normal`, win: 'normal', background: false });
    browser.selectTab(gone); await loaded(gone);
    browser.closeTab(gone);
    const normal = browser.createTab({ url: `${base}/normal`, win: 'normal', background: false });
    browser.selectTab(normal);
    const ntab = await loaded(normal);
    const closedBefore = browser.closed.length;
    downloads.add({ kind: 'http', url: `${base}/file-normal.bin`, name: 'normal-done.bin', pageUrl: base + '/' });
    await until(() => downloads.list().some((d) => d.name === 'normal-done.bin' && d.state === 'done'), 15000);
    downloads.add({ kind: 'http', url: `${base}/slow-normal.bin`, name: 'normal-running.bin', pageUrl: base + '/' });
    adblock.bump(ntab.wc);
    browser.emit('popup-blocked', ntab.id, `${base}/ad`, 'popup');
    browser.setPermission(origin, 'notifications', 'granted');
    browser.setPermission(origin, 'geolocation', 'denied');

    // A private window.
    ipc['tabs.new']({ incognito: true });
    await until(() => privWin() && browser.groups.private.activeId != null, 6000);
    const pnew = await ntp(browser.groups.private.activeId);
    await sleep(800);

    // 1. Address bar: bookmarks, never history.
    const sugg = (kind) => browser.inGroup(kind, () => ipc['omni.suggest']({ q: 'zebra' })).items || [];
    const ns = sugg('normal'); const ps = sugg('private');
    result.suggestions = { normal: ns.map((i) => i.kind), private: ps.map((i) => i.kind) };
    c.normalSuggestsHistory = ns.some((i) => i.kind === 'history');
    c.privateSuggestsNoHistory = !ps.some((i) => i.kind === 'history');
    c.privateStillSuggestsBookmarks = ps.some((i) => i.kind === 'bookmark');

    // 2. New-tab counters: the private page starts at nothing; the normal page keeps its totals.
    const nnew = browser.createTab({ win: 'normal', background: true });
    const nnt = await ntp(nnew);
    await sleep(500);
    const s1 = { private: await stats(pnew), normal: await stats(nnt) };
    c.privateCountersStartEmpty = s1.private.ads === 0 && s1.private.popups === 0 && s1.private.downloads === 0;
    c.normalCountersKeepTotals = s1.normal.ads >= 1 && s1.normal.popups >= 1 && s1.normal.downloads >= 1;
    // Something blocked and downloaded in the private window counts there (and in the totals).
    const p2 = browser.createTab({ url: `${base}/private`, incognito: true, background: false });
    const ptab = await loaded(p2);
    adblock.bump(ptab.wc);
    browser.emit('popup-blocked', ptab.id, `${base}/ad2`, 'popup');
    downloads.add({ kind: 'http', url: `${base}/file-private.bin`, name: 'private-done.bin', pageUrl: base + '/', incognito: true });
    await until(() => downloads.list().some((d) => d.name === 'private-done.bin' && d.state === 'done'), 15000);
    const s2 = { private: await stats(pnew), normal: await stats(nnt) };
    result.stats = { before: s1, after: s2 };
    c.privateCountsItsOwn = s2.private.ads === 1 && s2.private.popups === 1 && s2.private.downloads === 1;
    c.normalTotalsGrow = s2.normal.ads === s1.normal.ads + 1 && s2.normal.popups === s1.normal.popups + 1;

    // 3. Downloads popup and badge in the private window: its own downloads only.
    const pPanel = viewOf(privWin(), 'panel');
    await until(() => pPanel.executeJavaScript(`(dlData.list || []).some((d) => d.name === 'private-done.bin')`), 5000);
    const shown = await pPanel.executeJavaScript(`renderDownloads(); [...content.querySelectorAll('.row .nm')].map((e) => e.textContent)`);
    result.privatePopup = shown;
    c.privatePopupListsOwnOnly = shown.includes('private-done.bin') && !shown.some((n) => /^normal-/.test(n));
    await until(() => downloads.list().some((d) => d.name === 'normal-running.bin' && d.state === 'downloading'), 8000);
    await sleep(1200); // a progress push reaches both toolbars
    const badge = (w) => viewOf(w, 'chrome').executeJavaScript(`(() => { const b = document.getElementById('dl-badge'); return b.classList.contains('hidden') ? 0 : Number(b.textContent); })()`);
    result.badges = { normal: await badge(normWin()), private: await badge(privWin()) };
    c.privateBadgeIgnoresNormal = result.badges.private === 0 && result.badges.normal >= 1;

    // 4. Ctrl+Shift+T in the private window brings back no normal tab; in a normal window it still does.
    const normalTabs = browser.groups.normal.order.length;
    key(ptab.wc, 'T', ['control', 'shift']);
    await sleep(1200);
    c.ctrlShiftTInPrivateReopensNothing = browser.groups.normal.order.length === normalTabs && browser.closed.length === closedBefore;
    c.reopenFromPrivateIsNull = browser.reopenClosed(true) === null && browser.closed.length === closedBefore;
    c.reopenFromNormalStillWorks = browser.inGroup('normal', () => browser.reopenClosed(false)) != null && browser.groups.normal.order.length === normalTabs + 1;

    // 5. Permissions. The normal "allow" is not used in a private tab (it asks); the normal block still applies.
    c.privateIgnoresNormalAllow = browser.checkPermission(origin, 'notifications', true) === false && browser.checkPermission(origin, 'notifications', false) === true;
    c.privateKeepsNormalBlock = browser.getStoredPermission(origin, 'geolocation', true) === 'denied';
    let asked = null;
    browser.on('permission-ask', (info) => { asked = info; });
    const ask = async (tab) => { asked = null; tab.wc.executeJavaScript('Notification.requestPermission().then((p) => { window.__perm = p; }); 1', true); return until(() => asked, 5000); };
    const a1 = await ask(ptab);
    c.privateAsksDespiteNormalAllow = !!a1 && a1.incognito === true && a1.origin === origin;
    await ipc['permission.respond']({ allow: false, remember: false });
    // "Allow" + remember in a private tab, on a site the normal window never saw: kept for the private window only.
    const p3 = browser.createTab({ url: `${otherOrigin}/ask`, incognito: true, background: false });
    const ptab3 = await loaded(p3);
    const a2 = await ask(ptab3);
    await ipc['permission.respond']({ allow: true, remember: true });
    await until(() => ptab3.wc.executeJavaScript('window.__perm'), 3000);
    c.privateRememberWorksThere = !!a2 && browser.checkPermission(otherOrigin, 'notifications', true) === true;
    c.privateRememberNotSaved = !(settings.get('sitePermissions') || {})[otherOrigin] && browser.checkPermission(otherOrigin, 'notifications', false) === false;

    // Closing the private window forgets its answers and its counters.
    privWin().close();
    await until(() => !privWin(), 5000);
    await sleep(500);
    c.privateRememberForgottenOnClose = browser.checkPermission(otherOrigin, 'notifications', true) === false && !Object.keys(browser.privatePermissions).length;
    ipc['tabs.new']({ incognito: true });
    await until(() => privWin() && browser.groups.private.activeId != null, 6000);
    const again = await ntp(browser.groups.private.activeId);
    await sleep(500);
    const s3 = await stats(again);
    result.stats.reopened = s3;
    c.newPrivateWindowCountersReset = s3.ads === 0 && s3.popups === 0;

    for (const d of downloads.list()) { try { await downloads.cancel(d.id, true); } catch {} }
    const perms = { ...(settings.get('sitePermissions') || {}) }; delete perms[origin]; settings.set({ sitePermissions: perms });
    result.ok = Object.values(c).every(Boolean);
  } catch (e) {
    result.fatal = String((e && e.stack) || e);
  }
  try { if (server) server.close(); } catch {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
