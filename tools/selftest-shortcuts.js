'use strict';
// In-app self-test for 1.7.1: every keyboard shortcut, as key presses sent to the view that has the keyboard
// (the page, or the toolbar), the way typing reaches it; plus repeated Ctrl+Tab / Ctrl+W / Ctrl+T in a row.
// Left out because they open a system dialog: Ctrl+P, Ctrl+S, Ctrl+O, Ctrl+/, Shift+Esc (their keys are
// checked against shortcuts.js in the unit tests). Esc (stop) only acts while a page loads.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { BaseWindow } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-shortcuts.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(40); } return null; };

// 'Ctrl+Shift+T' -> Electron key event
function parse(chord) {
  const parts = chord.split('+');
  const key = parts.pop() || '+'; // "Ctrl++" ends in an empty part
  const mods = parts.filter(Boolean).map((p) => ({ ctrl: 'control', shift: 'shift', alt: 'alt' }[p.toLowerCase()]));
  return { keyCode: key.length === 1 ? key.toLowerCase() : key, modifiers: mods };
}

module.exports = async ({ app, browser, browsing, setPanel, chromeView, overlayView, settings, getWindow }) => {
  const result = { cases: {}, failed: [] };
  try {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title>page ${req.url} needle`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const win = getWindow();
    win.show(); win.focus();
    const tab = () => browser.activeTab();
    const snap = () => ({ n: browser.order.length, order: browser.order.slice(), active: browser.activeId, url: tab().url, win: browser.normalWindows().length });
    const wcOf = { page: () => tab().wc, toolbar: () => chromeView.webContents };
    const press = async (chord, focus) => {
      const wc = wcOf[focus]();
      wc.focus();
      await sleep(120);
      const e = parse(chord);
      wc.sendInputEvent({ type: 'keyDown', ...e });
      wc.sendInputEvent({ type: 'keyUp', ...e });
      await sleep(350);
    };
    let loads = 0;
    const countLoads = (t) => { if (t.wc && !t.__counted) { t.__counted = true; t.wc.on('did-start-loading', () => loads++); } };

    // 9 pages, A..I, the tab at index `start` open.
    let pool = null;
    const fresh = async (start = 1) => {
      setPanel(false);
      if (win.isFullScreen()) win.setFullScreen(false);
      for (const t of browser.tabs.values()) if (t.wc && !t.wc.isDestroyed() && t.wc.isDevToolsOpened()) t.wc.closeDevTools();
      // Rebuild the 9 pages only when a case changed the tabs.
      let ids = pool;
      const intact = ids && browser.order.length === 9 && ids.every((id, i) => browser.order[i] === id && browser.tabs.get(id).url === base + 'ABCDEFGHI'[i]);
      if (!intact) {
        const old = browser.order.slice();
        ids = [...'ABCDEFGHI'].map((c) => browser.createTab({ url: base + c, win: 'normal', background: true }));
        for (const id of old) browser.closeTab(id);
        for (const id of ids) countLoads(browser.tabs.get(id));
        await until(() => ids.every((id) => browser.tabs.get(id).title.length === 1 && !browser.tabs.get(id).loading));
        pool = ids;
      }
      for (const id of ids) { const t = browser.tabs.get(id); if (t.groupId != null) browser.removeFromGroup(id); }
      if (browsing.findOpen) browsing.closeFind();
      browser.selectTab(ids[start]);
      browser.tabs.get(ids[start]).wc.setZoomFactor(1);
      await sleep(150);
      return ids;
    };
    const idx = (s) => s.order.indexOf(s.active);

    // [chord, setup-start-index, extra setup, check(before, after, ids)]
    const T = (c, start, setup, check) => ({ c, start, setup, check });
    const cases = [
      T('Ctrl+Tab', 4, null, (a, b) => idx(b) === 5), T('Ctrl+Shift+Tab', 4, null, (a, b) => idx(b) === 3),
      T('Ctrl+PageDown', 4, null, (a, b) => idx(b) === 5), T('Ctrl+PageUp', 4, null, (a, b) => idx(b) === 3),
      T('Ctrl+Shift+PageDown', 4, null, (a, b) => idx(b) === 5 && b.order[5] === a.order[4]), T('Ctrl+Shift+PageUp', 4, null, (a, b) => idx(b) === 3 && b.order[3] === a.order[4]),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => T(`Ctrl+${n}`, n === 1 ? 4 : 0, null, (a, b) => idx(b) === n - 1)),
      T('Ctrl+9', 0, null, (a, b) => idx(b) === 8),
      T('Ctrl+T', 1, null, (a, b) => b.n === a.n + 1 && /newtab/.test(b.url)),
      T('Ctrl+W', 1, null, (a, b) => b.n === a.n - 1), T('Ctrl+F4', 1, null, (a, b) => b.n === a.n - 1),
      T('Ctrl+Shift+T', 1, async (ids) => { browser.closeTab(ids[7]); await sleep(200); }, (a, b) => b.n === a.n + 1),
      T('Ctrl+Shift+Delete', 1, null, (a, b) => b.n === a.n + 1 && b.url === 'novadm://history'),
      T('Ctrl+L', 1, null, () => chromeView.webContents.isFocused()), T('Ctrl+K', 1, null, () => chromeView.webContents.isFocused()),
      T('Ctrl+E', 1, null, () => chromeView.webContents.isFocused()), T('Alt+D', 1, null, () => chromeView.webContents.isFocused()), T('F6', 1, null, () => chromeView.webContents.isFocused()),
      T('Ctrl+J', 1, null, (a, b) => b.url === 'novadm://downloads'), T('Ctrl+H', 1, null, (a, b) => b.url === 'novadm://history'), T('Ctrl+Shift+O', 1, null, (a, b) => b.url === 'novadm://bookmarks'),
      T('Ctrl+U', 1, null, (a, b) => b.n === a.n + 1 && b.active !== a.active),
      T('Ctrl+R', 1, null, () => loads > 0), T('F5', 1, null, () => loads > 0), T('Shift+F5', 1, null, () => loads > 0), T('Ctrl+Shift+R', 1, null, () => loads > 0),
      T('Ctrl+F', 1, null, () => browsing.findOpen), T('Ctrl+G', 1, null, () => browsing.findOpen), T('F3', 1, null, () => browsing.findOpen),
      T('Shift+F3', 1, null, () => browsing.findOpen), T('Ctrl+Shift+G', 1, null, () => browsing.findOpen),
      T('Ctrl+D', 1, null, () => browsing.bookmarks.has(tab().url)),
      T('Ctrl+Shift+D', 1, null, () => browsing.bookmarks.nodes.filter((n) => n.type === 'url').length >= 9),
      T('Ctrl+Shift+B', 1, null, () => settings.get('showBookmarksBar') === false),
      T('Ctrl+Shift+A', 1, null, () => overlayView.getVisible()), T('Alt+F', 1, null, () => overlayView.getVisible()), T('F10', 1, null, () => overlayView.getVisible()),
      T('F12', 1, null, () => tab().wc.isDevToolsOpened()), T('Ctrl+Shift+I', 1, null, () => tab().wc.isDevToolsOpened()),
      T('Ctrl+Shift+J', 1, null, () => tab().wc.isDevToolsOpened()), T('Ctrl+Shift+C', 1, null, () => tab().wc.isDevToolsOpened()),
      T('Alt+Left', 1, async () => { browser.navigate(browser.activeId, base + 'X'); await sleep(700); browser.navigate(browser.activeId, base + 'Y'); await sleep(700); }, (a, b) => b.url.endsWith('/X')),
      T('Alt+Right', 1, async () => { browser.navigate(browser.activeId, base + 'X'); await sleep(700); browser.navigate(browser.activeId, base + 'Y'); await sleep(700); tab().wc.navigationHistory.goBack(); await sleep(700); }, (a, b) => b.url.endsWith('/Y')),
      T('Alt+Home', 1, null, (a, b) => /newtab/.test(b.url)),
      T('F11', 1, null, () => win.isFullScreen()),
      T('Ctrl+=', 1, null, () => tab().wc.getZoomFactor() > 1), T('Ctrl++', 1, null, () => tab().wc.getZoomFactor() > 1),
      T('Ctrl+-', 1, null, () => tab().wc.getZoomFactor() < 1),
      T('Ctrl+0', 1, async () => { tab().wc.setZoomFactor(1.5); }, () => tab().wc.getZoomFactor() === 1),
      T('Ctrl+Shift+K', 1, null, () => tab().groupId != null),
      T('Ctrl+Shift+U', 1, async () => { browser.addToGroup(browser.activeId); }, () => tab().groupId == null),
      T('Ctrl+Shift+L', 1, async () => { browser.addToGroup(browser.activeId); }, () => true), // folding a group: no crash, tab stays
    ];

    for (const focus of ['page', 'toolbar']) {
      for (const c of cases.filter((x) => !process.env.NOVADM_ONLY || process.env.NOVADM_ONLY.split(',').includes(x.c))) {
        const name = `${c.c} (${focus} has the keyboard)`;
        try {
          loads = 0;
          const ids = await fresh(c.start);
          if (c.setup) await c.setup(ids);
          if (['Ctrl+R', 'F5', 'Shift+F5', 'Ctrl+Shift+R'].includes(c.c)) loads = 0;
          const a = snap();
          if (c.c === 'Ctrl+Shift+D' || c.c === 'Ctrl+D') for (const n of [...browsing.bookmarks.nodes]) browsing.bookmarks.remove(n.id);
          await press(c.c, focus);
          const ok = !!(await until(() => c.check(a, snap(), ids), 2500));
          result.cases[name] = ok ? 'ok' : `FAILED (now: ${snap().url}, zoom ${tab().wc.getZoomFactor()})`;
          if (!ok) result.failed.push(name);
          if (c.c === 'Ctrl+Shift+B') settings.set({ showBookmarksBar: true });
        } catch (e) { result.cases[name] = 'ERROR ' + e.message; result.failed.push(name); }
      }
    }

    // The bug of 1.7.0 and before: shortcuts in a row. Each press goes to the view that has the keyboard now.
    const keyboardOwner = () => [chromeView.webContents, overlayView.getVisible() ? overlayView.webContents : null, tab().wc].find((wc) => wc && !wc.isDestroyed() && wc.isFocused());
    const row = async (chord, times, moved) => {
      await fresh(0);
      browser.tabs.get(browser.activeId).wc.focus();
      let worked = 0;
      for (let i = 0; i < times; i++) {
        const before = snap();
        const wc = keyboardOwner();
        if (wc) { const e = parse(chord); wc.sendInputEvent({ type: 'keyDown', ...e }); wc.sendInputEvent({ type: 'keyUp', ...e }); }
        await sleep(160);
        if (wc && moved(before, snap())) worked++;
      }
      result.cases[`${chord} x${times} in a row`] = worked === times ? 'ok' : `FAILED (${worked}/${times})`;
      if (worked !== times) result.failed.push(`${chord} x${times} in a row`);
    };
    await row('Ctrl+Tab', 12, (a, b) => b.active !== a.active);
    await row('Ctrl+Shift+Tab', 12, (a, b) => b.active !== a.active);
    await row('Ctrl+T', 6, (a, b) => b.n === a.n + 1);
    await row('Ctrl+W', 6, (a, b) => b.n === a.n - 1);

    // Windows, last: a new window, a private window, closing a window.
    await fresh(1);
    const w0 = browser.normalWindows().length;
    await press('Ctrl+N', 'page');
    result.cases['Ctrl+N'] = (await until(() => browser.normalWindows().length === w0 + 1)) ? 'ok' : 'FAILED';
    const extra = browser.normalWindows().find((k) => k !== 'normal');
    if (extra && browser.groups[extra]) { await sleep(500); const nw = BaseWindow.getFocusedWindow(); if (nw && nw !== win) nw.close(); await sleep(800); }
    await press('Ctrl+Shift+N', 'page');
    result.cases['Ctrl+Shift+N'] = (await until(() => browser.groups.private && browser.groups.private.order.length)) ? 'ok' : 'FAILED';
    const pw = BaseWindow.getFocusedWindow();
    if (pw && pw !== win) { pw.close(); await sleep(800); }
    for (const k of ['Ctrl+N', 'Ctrl+Shift+N']) if (result.cases[k] !== 'ok') result.failed.push(k);
    result.total = Object.keys(result.cases).length;
    result.ok = result.failed.length === 0;
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
