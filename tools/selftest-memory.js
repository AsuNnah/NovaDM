'use strict';
// In-app self-test for 1.5.3: memory overload protection. With memory reported short (os.freemem is
// replaced for the test), the check unloads up to 3 background tabs, the longest unused first, and
// keeps the open tab, a tab marked to stay loaded, and pinned / grouped tabs come back on click.
// With the setting off, or memory fine, nothing is unloaded.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-memory.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };

module.exports = async ({ app, browser, browsing, settings }) => {
  const result = {};
  const realFree = os.freemem;
  try {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title>x`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const first = browser.activeId;
    const names = ['A', 'B', 'C', 'D', 'E', 'F'];
    const ids = names.map((n) => browser.createTab({ url: base + n }));
    browser.closeTab(first);
    await until(() => ids.every((id) => browser.tabs.get(id).title.length === 1 && !browser.tabs.get(id).loading));
    const t = (n) => browser.tabs.get(ids[names.indexOf(n)]);
    // Unused the longest: A, then B, C, D, E; F is open. C must stay loaded.
    names.forEach((n, i) => { t(n).hiddenAt = Date.now() - (100 - i) * 60000; });
    t('C').keepLoaded = true;
    browser.selectTab(t('F').id);
    await sleep(300);

    result.memoryFine = browsing.memoryCheck().length; // the real PC values (expected: not short)
    os.freemem = () => os.totalmem() * 0.03; // "3% free"
    settings.set({ memorySaver: false });
    result.settingOff = browsing.memoryCheck().length;
    settings.set({ memorySaver: true });
    const first3 = browsing.memoryCheck().map((id) => browser.tabs.get(id).title);
    const next = browsing.memoryCheck().map((id) => browser.tabs.get(id).title);
    result.unloadedFirst = first3;
    result.unloadedNext = next;
    result.stillLoaded = names.filter((n) => !t(n).discarded);
    browser.selectTab(t('A').id); // an unloaded tab comes back when opened
    result.cameBack = !!(await until(() => !t('A').discarded && t('A').wc && t('A').wc.getTitle() === 'A'));
    server.close();
    result.checks = {
      notShortNow: result.memoryFine === 0 || result.memoryFine === undefined,
      settingOff: result.settingOff === 0,
      oldestFirst: JSON.stringify(first3) === JSON.stringify(['A', 'B', 'D']),
      threeAtATime: first3.length === 3 && JSON.stringify(next) === JSON.stringify(['E']),
      keeps: JSON.stringify(result.stillLoaded) === JSON.stringify(['C', 'F']),
      cameBack: result.cameBack,
    };
    result.ok = Object.values(result.checks).every(Boolean);
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  } finally {
    os.freemem = realFree;
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
