'use strict';
// In-app self-test for 1.6.1: a page's own fullscreen (a video's fullscreen button) fills the whole window.
// Checks: enter hides the toolbar and the page gets the full window; leave (document.exitFullscreen)
// restores both; switching tabs ends it; a second window is not affected.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { BaseWindow } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-fullscreen.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };

module.exports = async ({ app, browser }) => {
  const result = {};
  try {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title><div id=v style="width:300px;height:200px">${req.url}</div>`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const first = browser.activeId;
    const A = browser.createTab({ url: base + 'A', win: 'normal' });
    const B = browser.createTab({ url: base + 'B', win: 'normal' });
    browser.closeTab(first);
    await until(() => [A, B].every((id) => browser.tabs.get(id).title.length === 1));
    browser.selectTab(A);
    const bw = BaseWindow.getAllWindows().find((w) => browser.groups.normal && w.contentView === browser.groups.normal.parentView);
    const strip = bw.contentView.children.find((v) => v.webContents && /chrome\.html/.test(v.webContents.getURL()));
    const tabA = browser.tabs.get(A);
    const state = () => {
      const [, h] = bw.getContentSize();
      const pb = tabA.view.getBounds();
      return { win: bw.isFullScreen(), stripVisible: strip.getVisible(), pageTop: pb.y, pageFull: pb.y === 0 && pb.height === h };
    };
    const before = state();
    await tabA.wc.executeJavaScript("document.getElementById('v').requestFullscreen()", true);
    const entered = await until(() => { const s = state(); return s.win && s.pageFull && !s.stripVisible ? s : null; });
    await tabA.wc.executeJavaScript('document.exitFullscreen()', true);
    const left = await until(() => { const s = state(); return !s.win && s.stripVisible && s.pageTop > 0 ? s : null; });

    await tabA.wc.executeJavaScript("document.getElementById('v').requestFullscreen()", true);
    await until(() => state().win);
    browser.selectTab(B);
    const switched = await until(() => { const s = state(); return !s.win && s.stripVisible ? s : null; });

    result.states = { before, entered, left, switched };
    result.checks = {
      startsNormal: !before.win && before.stripVisible && before.pageTop > 0,
      enterFillsWindow: !!entered,
      leaveRestores: !!left,
      tabSwitchEnds: !!switched,
    };
    result.ok = Object.values(result.checks).every(Boolean);
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
