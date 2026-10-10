'use strict';
// UI performance: panel open time, frame times while switching tabs and opening panels, and the
// memory / idle CPU of the toolbar and panel views. Run before and after UI changes and compare.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-uiperf.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// Frame intervals in a view while `during` runs: p95 and frames over 33 ms (a visible stutter at 60 Hz).
async function frames(wc, during) {
  await wc.executeJavaScript(`window.__f = []; (() => { let last = performance.now(); const tick = (t) => { window.__f.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(tick); }; window.__stop = false; requestAnimationFrame(tick); })(); 1`);
  await during();
  const f = await wc.executeJavaScript('window.__stop = true; window.__f.slice(2)');
  const s = [...f].sort((a, b) => a - b);
  return { frames: f.length, p95: +(s[Math.floor(s.length * 0.95)] || 0).toFixed(1), over33: f.filter((x) => x > 33).length };
}

module.exports = async ({ app, browser, ipc, chromeView, overlayView }) => {
  const result = {};
  try {
    const site = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1).replace(/[^A-Za-z0-9]/g, '')}</title><p>page</p>`); });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    for (let i = 0; i < 8; i++) ipc['tabs.new']({ url: `http://127.0.0.1:${site.address().port}/Tab${i}` });
    await sleep(3000);

    // 1. Panel open: from the request to the menu drawn on screen (two animation frames later).
    const opens = [];
    for (let i = 0; i < 10; i++) {
      await overlayView.webContents.executeJavaScript(`window.__seen = 0; new MutationObserver((m, o) => { o.disconnect(); requestAnimationFrame(() => requestAnimationFrame(() => { window.__seen = Date.now(); })); }).observe(document.getElementById('content'), { childList: true }); 1`);
      const t0 = Date.now();
      ipc['panel.open']({ name: 'menu' });
      let seen = 0;
      for (let k = 0; k < 100 && !seen; k++) { await sleep(10); seen = await overlayView.webContents.executeJavaScript('window.__seen'); }
      opens.push(seen - t0);
      ipc['panel.close']();
      await sleep(250);
    }
    result.panelOpenMs = { median: median(opens), max: Math.max(...opens) };

    // 2. Frames in the toolbar while switching tabs every 100 ms (20 switches).
    result.tabSwitchFrames = await frames(chromeView.webContents, async () => {
      for (let i = 0; i < 20; i++) { browser.selectTab(browser.order[i % browser.order.length]); await sleep(100); }
    });

    // 3. Frames in the panel view while it is on screen: opening the menu and the 400 ms after (6 times).
    // (A hidden view draws no frames, so the time between opens is not counted.)
    const runs = [];
    for (let i = 0; i < 6; i++) {
      ipc['panel.open']({ name: 'menu' });
      runs.push(await frames(overlayView.webContents, () => sleep(400)));
      ipc['panel.close']();
      await sleep(200);
    }
    result.panelFrames = { frames: runs.reduce((s, r) => s + r.frames, 0), p95: Math.max(...runs.map((r) => r.p95)), over33: runs.reduce((s, r) => s + r.over33, 0) };

    // 4. Memory and idle CPU of the UI views (toolbar + panels).
    await sleep(1500);
    const pids = new Set([chromeView.webContents.getOSProcessId(), overlayView.webContents.getOSProcessId()]);
    app.getAppMetrics(); // starts the CPU sampling window
    await sleep(3000);
    const ui = app.getAppMetrics().filter((m) => pids.has(m.pid));
    result.uiMemoryMB = +(ui.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024).toFixed(1);
    result.uiIdleCpuPercent = +ui.reduce((s, m) => s + m.cpu.percentCPUUsage, 0).toFixed(2);
    result.uiProcesses = ui.length;
    site.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
