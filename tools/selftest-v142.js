'use strict';
// In-app self-test for 1.4.2: Ctrl+click and middle-click open the link in a new tab behind the
// current one (like Chrome), for links to the same site and to other sites; Ctrl+Shift+click opens
// it in front. Real mouse input through the DevTools protocol.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-v142.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

module.exports = async ({ app, browser }) => {
  const result = {};
  try {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      if (req.url === '/') {
        const port = server.address().port;
        return res.end(`<title>Start</title><a id="same" href="/same" style="display:block;font-size:30px">same site</a>
          <a id="other" href="http://localhost:${port}/other" style="display:block;font-size:30px">other site</a>
          <a id="blank" href="/blank" target="_blank" style="display:block;font-size:30px">target blank</a>`);
      }
      res.end(`<title>${req.url.slice(1)}</title>x`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const start = `http://127.0.0.1:${server.address().port}/`;
    const tab = browser.tabs.get(browser.activeId);
    browser.navigate(tab.id, start);
    await until(() => tab.wc.getTitle() === 'Start');
    await sleep(300);
    const dbg = tab.wc.debugger;
    dbg.attach('1.3');
    const at = async (id) => tab.wc.executeJavaScript(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: Math.round(r.left + 10), y: Math.round(r.top + 10) }; })()`);
    const click = async (id, button, modifiers) => {
      const p = await at(id);
      for (const type of ['mousePressed', 'mouseReleased']) await dbg.sendCommand('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button, clickCount: 1, modifiers, buttons: button === 'middle' ? 4 : 1 });
    };
    const cases = [
      ['ctrl+click, same site', 'same', 'left', 2, 'back'],
      ['ctrl+click, other site', 'other', 'left', 2, 'back'],
      ['middle-click, same site', 'same', 'middle', 0, 'back'],
      ['middle-click, other site', 'other', 'middle', 0, 'back'],
      ['ctrl+click, target=_blank', 'blank', 'left', 2, 'back'],
      ['ctrl+shift+click, same site', 'same', 'left', 2 | 8, 'front'],
    ];
    result.cases = [];
    for (const [name, id, button, modifiers, want] of cases) {
      browser.selectTab(tab.id);
      await sleep(200);
      const before = browser.order.length;
      await click(id, button, modifiers);
      const opened = await until(() => browser.order.length > before, 3000);
      await sleep(400);
      const newId = browser.order.find((x) => !result.cases.some((c) => c.tabId === x) && x !== tab.id && browser.tabs.get(x).url && !browser.tabs.get(x).url.startsWith('novadm'));
      const front = browser.activeId === tab.id ? 'back' : 'front';
      result.cases.push({ name, opened: !!opened, stayed: browser.activeId === tab.id, ok: !!opened && front === want, tabId: browser.order[browser.order.length - 1], originalUrl: tab.wc.getURL() === start });
      void newId;
    }
    dbg.detach();
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
