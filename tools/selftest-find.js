'use strict';
// In-app self-test for 1.6.1: the find bar's page process starts on first use (saves memory), find still
// works, and the ad blocker (untouched, but checked) still blocks a known ad address.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { webContents } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-find.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };

module.exports = async ({ app, browser, adblock, browsing }) => {
  const result = {};
  try {
    const findPages = () => webContents.getAllWebContents().filter((w) => /find\.html/.test(w.getURL()));
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>F</title>needle in a haystack, needle again'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const first = browser.activeId;
    const A = browser.createTab({ url: `http://127.0.0.1:${server.address().port}/`, win: 'normal' });
    browser.closeTab(first);
    await until(() => browser.tabs.get(A).title === 'F');
    const beforeUse = findPages().length;
    browsing.openFind('needle');
    const created = await until(() => findPages().length === 1 && browsing.findView && browsing.findView.getVisible());
    const gotText = await until(async () => {
      const w = findPages()[0];
      if (!w || w.isLoading()) return false;
      return w.executeJavaScript("document.querySelector('input') && document.querySelector('input').value").catch(() => false);
    });
    browsing.closeFind();
    const hidden = !browsing.findView.getVisible();
    browsing.openFind('again');
    const reopened = findPages().length === 1 && browsing.findView.getVisible();
    browsing.closeFind();

    const { Request } = require(require.resolve('@ghostery/adblocker-electron', { paths: [path.join(__dirname, '..')] }));
    const ad = adblock.engine.match(Request.fromRawDetails({ url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', type: 'script', sourceUrl: 'https://example.com/' }));
    const clean = adblock.engine.match(Request.fromRawDetails({ url: 'https://example.com/app.js', type: 'script', sourceUrl: 'https://example.com/' }));
    result.checks = {
      noFindProcessAtStart: beforeUse === 0,
      createdOnCtrlF: !!created,
      textArrived: gotText === 'needle',
      closeHides: hidden,
      reopenReusesView: reopened,
      adblockReady: !!adblock.ready,
      adblockBlocksAd: !!ad.match,
      adblockLetsCleanThrough: !clean.match,
    };
    result.ok = Object.values(result.checks).every(Boolean);
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
