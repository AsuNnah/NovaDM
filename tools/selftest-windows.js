'use strict';
// In-app self-test for 1.6.0 (2 phases, same profile): several normal windows.
// Phase 1: Ctrl+N window; tab dragged out of the strip (the strip's own drag handlers) to a new window
// with its page still loaded; a tab dropped on another window's strip; a tab group torn off; a window
// closed and brought back with Ctrl+Shift+T; the last tab of a second window closes it; private tabs
// can't move to a normal window. Then a normal quit with two windows at known places.
// Phase 2: both windows come back with their tabs and places.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { BaseWindow } = require('electron');

const PHASE = process.env.NOVADM_V1_PHASE || '1';
const OUT = path.join(os.tmpdir(), `novadm-selftest-windows-${PHASE}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };

module.exports = async ({ app, browser, ipc }) => {
  const result = {};
  const normalWins = () => browser.normalWindows();
  const titles = (k) => (browser.groups[k] ? browser.groups[k].order.map((id) => browser.tabs.get(id).title).join('') : '');
  const bwOf = (k) => BaseWindow.getAllWindows().find((w) => browser.groups[k] && w.contentView === browser.groups[k].parentView);
  const stripOf = (k) => { const w = bwOf(k); return w && w.contentView.children.find((v) => v.webContents && /chrome\.html/.test(v.webContents.getURL())).webContents; };
  try {
    if (PHASE === '2') {
      await sleep(2000);
      // By address: the open tab loads at start and fails (the test server is gone), so its title is the host.
      result.windows = normalWins().map((k) => ({ key: k, tabs: browser.groups[k].order.map((id) => browser.tabs.get(id).url.split('/').pop()).join(''), bounds: bwOf(k) && bwOf(k).getNormalBounds() }));
      const two = result.windows.length === 2;
      const second = result.windows.find((w) => w.tabs === 'XY');
      result.checks = {
        twoWindows: two,
        tabsBack: !!second && result.windows.some((w) => w.tabs === 'PQ'),
        placeBack: !!second && Math.abs(second.bounds.x - 300) < 20 && Math.abs(second.bounds.width - 900) < 20,
      };
      result.ok = Object.values(result.checks).every(Boolean);
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
      app.exit(0);
      return;
    }

    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title>${req.url}`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const first = browser.activeId;
    const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((n) => browser.createTab({ url: base + n, win: 'normal' }));
    browser.closeTab(first);
    await until(() => [A, B, C, D].every((id) => browser.tabs.get(id).title.length === 1));

    // Ctrl+N: a second normal window with a new tab; the first keeps its tabs.
    const w2 = ipc['window.new']();
    await sleep(800);
    result.newWindow = { windows: normalWins().length, inNew: browser.groups[w2].order.length, firstKept: titles('normal') };

    // Drag B out of the strip, past the window's edge: a new window, page still loaded (no reload).
    await browser.tabs.get(B).wc.executeJavaScript('window.__mark = 42');
    await stripOf('normal').executeJavaScript(`(() => {
      const el = document.querySelector('.tab[data-id="${B}"]'); const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dt.dropEffect = 'none';
      el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt, clientX: innerWidth + 200, clientY: 300, screenX: 900, screenY: 400 }));
    })()`);
    await until(() => normalWins().length === 3);
    const w3 = browser.kindOf(browser.tabs.get(B));
    result.dragOut = { windows: normalWins().length, bWindow: w3, kept: await browser.tabs.get(B).wc.executeJavaScript('window.__mark'), firstNow: titles('normal') };

    // C dropped on the second window's strip (a drag from another window carries the tab id).
    await stripOf(w2).executeJavaScript(`(() => {
      const dt = new DataTransfer(); dt.setData('application/x-novadm-tab', '${C}');
      document.getElementById('tabs').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    await until(() => browser.kindOf(browser.tabs.get(C)) === w2);
    result.dropIn = { cWindow: browser.kindOf(browser.tabs.get(C)), secondNow: browser.groups[w2].order.map((id) => browser.tabs.get(id).title) };

    // Tear off a group: A and D grouped "Read" in the first window, dragged out by the chip.
    const E = browser.createTab({ url: base + 'E', win: 'normal' });
    await until(() => browser.tabs.get(E).title === 'E');
    const g = browser.addToGroup(A);
    browser.addToGroup(D, g);
    browser.updateGroup(g, { title: 'Read', color: 'green' });
    await sleep(300);
    await stripOf('normal').executeJavaScript(`(() => {
      const el = document.querySelector('.tgroup[data-gid="${g}"]'); const dt = new DataTransfer();
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dt.dropEffect = 'none';
      el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt, clientX: 50, clientY: innerHeight + 300, screenX: 400, screenY: 700 }));
    })()`);
    await until(() => browser.kindOf(browser.tabs.get(A)) !== 'normal');
    const w4 = browser.kindOf(browser.tabs.get(A));
    const ng = browser.groups[w4].tabGroups.get(browser.tabs.get(A).groupId);
    result.tearOff = { window: w4, tabs: titles(w4), group: ng && { title: ng.title, color: ng.color }, firstNow: titles('normal') };

    // Close the window with B; Ctrl+Shift+T brings it back with its tab.
    bwOf(w3).close();
    await until(() => !browser.groups[w3]);
    result.closed = { windows: normalWins().length };
    browser.reopenClosed();
    await until(() => normalWins().length === result.closed.windows + 1);
    const back = normalWins().find((k) => titles(k) === 'B');
    result.reopened = { found: !!back };

    // The last tab of a second window closes that window.
    const before = normalWins().length;
    for (const id of [...browser.groups[back].order]) browser.closeTab(id);
    await until(() => normalWins().length === before - 1);
    result.lastTabClosesWindow = normalWins().length === before - 1;

    // Private tabs stay private.
    const P = browser.createTab({ url: base + 'private', incognito: true });
    await sleep(500);
    result.privateRefused = browser.moveTabToWindow(P, 'normal') === false && browser.tabs.get(P).win === 'private';
    browser.closeTab(P);
    await sleep(500);

    // For phase 2: close every window but the first two, give them known tabs and places.
    for (const k of normalWins().filter((k) => k !== 'normal' && k !== w2)) bwOf(k).close();
    await sleep(600);
    const keepFirst = browser.groups.normal.order.map((id) => browser.tabs.get(id));
    const P1 = browser.createTab({ url: base + 'P', win: 'normal' });
    const Q1 = browser.createTab({ url: base + 'Q', win: 'normal' });
    for (const t of keepFirst) browser.closeTab(t.id);
    for (const id of [...browser.groups[w2].order]) if (browser.groups[w2].order.length > 1) browser.closeTab(id);
    const X = browser.createTab({ url: base + 'X', win: w2 });
    const Y = browser.createTab({ url: base + 'Y', win: w2 });
    browser.closeTab(browser.groups[w2].order.find((id) => id !== X && id !== Y));
    await until(() => [P1, Q1, X, Y].every((id) => browser.tabs.get(id).title.length === 1));
    bwOf(w2).setBounds({ x: 300, y: 120, width: 900, height: 640 });
    await sleep(2200); // saved 1.5 s after the last change

    result.checks = {
      newWindow: result.newWindow.windows === 2 && result.newWindow.inNew === 1 && result.newWindow.firstKept === 'ABCD',
      dragOut: result.dragOut.windows === 3 && result.dragOut.kept === 42 && result.dragOut.firstNow === 'ACD',
      dropIn: result.dropIn.cWindow === w2 && result.dropIn.secondNow.includes('C'),
      tearOff: result.tearOff.tabs === 'AD' && result.tearOff.group && result.tearOff.group.title === 'Read' && result.tearOff.group.color === 'green' && result.tearOff.firstNow === 'E',
      reopen: result.reopened.found,
      lastTabClosesWindow: result.lastTabClosesWindow,
      privateRefused: result.privateRefused,
    };
    result.ok = Object.values(result.checks).every(Boolean);
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.quit();
};
