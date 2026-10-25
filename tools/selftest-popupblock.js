'use strict';
// In-app self-test for 1.7.7: "always block pop-ups on this site". A page that opens another site on its own first asks;
// "Block" with "Remember my choice" (and the Guard button) makes every later one blocked without asking; undoing it asks
// again; "Open" with "Remember my choice" always opens. Made-up sites on this PC only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-popupblock.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ app, browser, ipc, setPanel }) => {
  const result = {};
  let server;
  try {
    server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>P ${req.url}</title>page ${req.url}`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const pageUrl = `http://127.0.0.1:${port}/page`; // one "site"
    const target = `http://localhost:${port}/ad`; // another "site"
    const id = browser.createTab({ url: pageUrl, win: 'normal', background: false }); browser.selectTab(id); await sleep(1500);
    const wc = browser.tabs.get(id).wc;
    const events = [];
    browser.on('popup-ask', () => events.push('ask'));
    browser.on('popup-blocked', () => events.push('blocked'));
    const popup = browser.popup;
    // The page opens another site on its own.
    const tryOpen = async () => { events.length = 0; const n = browser.order.length; await wc.executeJavaScript(`window.open(${JSON.stringify(target)}); 1`, true); await sleep(600); setPanel(false); return { events: events.slice(), newTabs: browser.order.length - n }; };
    const c = {};

    const first = await tryOpen();
    c.asksFirst = first.events.join() === 'ask' && first.newTabs === 0;

    // "Block", remember: this site is on the block list; the next ones are blocked without asking.
    await ipc['popup.respond']({ url: target, pageUrl, allow: false, always: true });
    c.rememberedBlockIsSaved = popup.siteBlocked(pageUrl) && !popup.siteAllowed(pageUrl);
    const blocked = await tryOpen();
    c.thenBlockedWithoutAsking = blocked.events.join() === 'blocked' && blocked.newTabs === 0;
    const again = await tryOpen();
    c.andAgain = again.events.join() === 'blocked' && again.newTabs === 0;

    // The Guard button undoes it, and sets it again.
    await ipc['shields.togglePopupBlock'](); await sleep(300);
    c.guardButtonUndoes = !popup.siteBlocked(pageUrl);
    const asks = await tryOpen();
    c.asksAgainAfterUndo = asks.events.join() === 'ask' && asks.newTabs === 0;
    await ipc['shields.togglePopupBlock'](); await sleep(300);
    c.guardButtonBlocksAgain = popup.siteBlocked(pageUrl);
    const blockedAgain = await tryOpen();
    c.blockedAfterToggleOn = blockedAgain.events.join() === 'blocked';

    // "Open", remember: always opens, and the block is gone.
    await ipc['popup.respond']({ url: target, pageUrl, allow: true, always: true }); await sleep(600);
    c.openAlwaysReplacesBlock = popup.siteAllowed(pageUrl) && !popup.siteBlocked(pageUrl);
    const opened = await tryOpen();
    c.thenOpens = opened.events.length === 0 && opened.newTabs === 1;

    result.checks = c;
    result.ok = Object.values(c).every(Boolean);
  } catch (e) { result.error = String((e && e.stack) || e); }
  try { if (server) server.close(); } catch {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
