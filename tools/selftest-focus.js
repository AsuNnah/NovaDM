'use strict';
// In-app self-test for 1.7.1: after things that change what is on screen, some view of the window has the
// keyboard (the toolbar, the open panel, the find bar, or the page you are on), so shortcuts keep working.
// Before 1.7.1 several of these left no view focused (or a hidden tab), and shortcuts were lost until a click.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { BaseWindow } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-focus.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ app, browser, browsing, ipc, setPanel, chromeView, overlayView, getWindow }) => {
  const result = { scenarios: {} };
  try {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title><input id=i>page ${req.url}`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const first = browser.activeId;
    const ids = ['A', 'B', 'C', 'D'].map((n) => browser.createTab({ url: base + n, win: 'normal' }));
    browser.closeTab(first);
    await sleep(1500);
    const win = getWindow();
    win.show(); win.focus();
    await sleep(500);

    // Who has the keyboard now: 'tab:<title>', 'toolbar', 'panel', 'find', or 'none'.
    const who = () => {
      const t = browser.activeTab();
      const cands = [['toolbar', chromeView.webContents], ['panel', overlayView.webContents], ['find', browsing.findView && browsing.findView.webContents], ['tab', t && t.wc]];
      const on = cands.filter(([, wc]) => wc && !wc.isDestroyed() && wc.isFocused()).map(([n]) => n);
      return on.length ? on.join('+') : 'none';
    };
    const ok = () => who() !== 'none';
    const settle = () => sleep(900); // time for the fix to act, if it is going to
    const scenario = async (name, fn) => { await fn(); await settle(); result.scenarios[name] = who(); };

    // In the page, then switch / close / open tabs the way shortcuts and clicks do.
    const inPage = async (id) => { browser.selectTab(id); browser.tabs.get(id).wc.focus(); await sleep(200); };
    await scenario('Ctrl+Tab from a focused page', async () => { await inPage(ids[0]); browser.selectTab(ids[1]); });
    await scenario('Ctrl+Tab again', async () => { browser.selectTab(ids[2]); });
    await scenario('Ctrl+W closes the focused page', async () => { await inPage(ids[2]); browser.closeTab(ids[2]); });
    await scenario('Ctrl+T new tab (blank) from a page', async () => { await inPage(ids[0]); browser.createTab({ url: 'novadm://newtab' }); });
    await scenario('Ctrl+click link opens a background tab', async () => { await inPage(ids[0]); browser.createTab({ url: base + 'E', background: true, openerPartition: ids[0] }); });
    await scenario('Alt+Tab away and back', async () => { await inPage(ids[0]); win.blur(); await sleep(300); win.focus(); });
    await scenario('side panel opened and closed', async () => { await inPage(ids[0]); setPanel(true); await sleep(300); setPanel(false); });
    await scenario('find opened and closed', async () => { await inPage(ids[0]); await ipc['find.open'](); await sleep(300); await ipc['find.close'](); });
    await scenario('tab unloaded and back', async () => { await inPage(ids[0]); browser.discard(ids[1]); browser.selectTab(ids[1]); });
    // A new window: its own toolbar or page has the keyboard (looked up from the window that has the focus).
    await inPage(ids[0]);
    browser.newWindow();
    await sleep(2500);
    const fw = BaseWindow.getFocusedWindow();
    const inNew = fw && fw.contentView.children.filter((v) => v.webContents && !v.webContents.isDestroyed() && v.webContents.isFocused()).length;
    result.scenarios['Ctrl+N new window'] = fw && fw !== win ? (inNew ? 'has focus' : 'none') : 'none (the new window is not the focused one)';

    result.bad = Object.entries(result.scenarios).filter(([, v]) => v === 'none').map(([k]) => k);
    result.ok = result.bad.length === 0;
    void ok;
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
