'use strict';
// In-app measurement (not a pass/fail test): memory by process type with a few tabs open, after settling.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-ram.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ app, browser }) => {
  const result = {};
  try {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title><h1>${req.url}</h1><p>${'text '.repeat(500)}</p>`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const snap = async (label) => {
      await sleep(6000);
      const by = {};
      let total = 0;
      for (const m of app.getAppMetrics()) {
        const mb = m.memory.workingSetSize / 1024; // KB -> MB
        const k = m.type === 'Tab' ? 'renderer' : m.type;
        by[k] = Math.round(((by[k] || 0) + mb) * 10) / 10;
        by[k + '_n'] = (by[k + '_n'] || 0) + 1;
        total += mb;
      }
      result[label] = { totalMB: Math.round(total), ...by };
    };
    const { webContents } = require('electron');
    const who = () => {
      const names = {};
      for (const w of webContents.getAllWebContents()) { try { names[w.getOSProcessId()] = (names[w.getOSProcessId()] || '') + ' ' + w.getURL().replace(/^.*[\/]/, '').slice(0, 24); } catch {} }
      return app.getAppMetrics().map((m) => `${m.type} ${Math.round(m.memory.workingSetSize / 1024)}MB private ${Math.round((m.memory.privateBytes || 0) / 1024)}MB${names[m.pid] || ''}`);
    };
    await snap('start');
    result.startProcs = who();
    if (process.env.RAM_SNAPSHOT) { global.gc && global.gc(); require('v8').writeHeapSnapshot(process.env.RAM_SNAPSHOT); }
    result.mainMem = Object.fromEntries(Object.entries(process.memoryUsage()).map(([k, v]) => [k, Math.round(v / 1048576)]));
    const first = browser.activeId;
    for (const n of 'ABC') browser.createTab({ url: base + n, win: 'normal' });
    browser.closeTab(first);
    await snap('threeTabs');
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
