'use strict';
// In-app self-test for the pop-up guard and the tab close button. Clicks are sent as real input
// events (trusted), like a user's mouse.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'novadm-selftest-popup.json');

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const port = server.address().port;
      const other = `http://localhost:${port}`; // a different site than 127.0.0.1
      if (req.url === '/page.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><title>Popup test</title><body style="font:16px sans-serif">
<p><a id="same" href="/target-same" target="_blank">same-site link</a></p>
<p><a id="cross" href="${other}/target-cross" target="_blank">cross-site link</a></p>
<p><button id="scripted" onclick="window.open('${other}/popup-script')">scripted pop-up</button></p>
<p><button id="fake" onclick="const a=document.createElement('a');a.href='${other}/fake-click';a.target='_blank';document.body.appendChild(a);a.click()">fake link click</button></p>
<p><button id="blank" onclick="window.open('about:blank')">blank window</button></p>
<p><button id="ad" onclick="window.open('https://ad.doubleclick.net/ddm/clk/123')">ad pop-up</button></p>
<p><a id="middle" href="${other}/middle-click">middle-click me</a></p>
</body>`);
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>target</title>ok');
    });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

async function clickEl(wc, selector, button = 'left') {
  const r = await wc.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
  wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button, clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button, clickCount: 1 });
}

module.exports = async ({ app, browser, adblock, ipc, chromeView }) => {
  const result = { cases: {} };
  try {
    const base = await startServer();
    // The ad-domain case needs the filter lists.
    const t0 = Date.now();
    while (!adblock.ready && Date.now() - t0 < 30000) await sleep(250);
    result.adblockReady = adblock.ready;

    const tab = browser.activeTab();
    const loaded = new Promise((r) => tab.wc.once('did-finish-load', r));
    browser.navigate(tab.id, base + '/page.html');
    await loaded;
    await sleep(500);

    const events = [];
    browser.on('popup-ask', (i) => events.push({ type: 'ask', url: i.url, fromClick: i.fromClick }));
    browser.on('popup-blocked', (_t, url, reason) => events.push({ type: 'blocked', url, reason }));
    const tabsBefore = () => new Set(browser.order);

    async function run(name, selector, button) {
      const before = tabsBefore();
      const n = events.length;
      browser.selectTab(tab.id);
      await sleep(150);
      await clickEl(tab.wc, selector, button);
      await sleep(700);
      const opened = browser.order.filter((id) => !before.has(id)).map((id) => browser.tabs.get(id).wc.getURL() || browser.tabs.get(id).url);
      result.cases[name] = { events: events.slice(n), openedTabs: opened };
      ipc['panel.close']();
    }

    await run('sameSiteLink', '#same');
    await run('crossSiteLink', '#cross');
    await run('scriptedPopup', '#scripted');
    await run('fakeLinkClick', '#fake');
    await run('blankWindow', '#blank');
    await run('adPopup', '#ad');
    await run('middleClick', '#middle', 'middle');

    // Tab close button: click the X of the last tab in the tab strip.
    const countBefore = browser.order.length;
    const lastId = browser.order[browser.order.length - 1];
    const pos = await chromeView.webContents.executeJavaScript(`(() => { const r = document.querySelector('.tab[data-id="${lastId}"] .cls').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    chromeView.webContents.sendInputEvent({ type: 'mouseMove', x: pos.x, y: pos.y });
    chromeView.webContents.sendInputEvent({ type: 'mouseDown', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    chromeView.webContents.sendInputEvent({ type: 'mouseUp', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
    await sleep(600);
    result.closeButton = { before: countBefore, after: browser.order.length, closedTabGone: !browser.tabs.has(lastId) };

    // The drag area exists and has the drag style.
    result.dragSpace = await chromeView.webContents.executeJavaScript(`(() => { const d = document.getElementById('drag-space'); const r = d.getBoundingClientRect(); return { width: Math.round(r.width), region: getComputedStyle(d).webkitAppRegion || getComputedStyle(d).getPropertyValue('-webkit-app-region') }; })()`);
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
