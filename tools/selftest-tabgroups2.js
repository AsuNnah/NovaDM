'use strict';
// In-app self-test for 1.5.0, part 2: dragging a whole group by its chip (the strip's own drag
// handlers), and the group shortcuts as real key presses (Ctrl+Shift+K / U / L, Ctrl+Shift+PgDn,
// Ctrl+Tab skipping a folded group).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-tabgroups2.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };

module.exports = async ({ app, browser, chromeView }) => {
  const result = {};
  const chrome = chromeView.webContents;
  const t = (id) => browser.tabs.get(id);
  const order = () => browser.groups.normal.order.map((id) => t(id).title + (t(id).groupId ? '*' : '')).join(' ');
  try {
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1)}</title><body>${req.url}</body>`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const first = browser.activeId;
    const [A, B, C, D, E] = ['A', 'B', 'C', 'D', 'E'].map((n) => browser.createTab({ url: base + n }));
    browser.closeTab(first);
    await until(() => [A, B, C, D, E].every((id) => t(id).title.length === 1));
    // Keys go to the page, as when the user types (NovaDM catches them before the page does).
    const press = async (keyCode, modifiers = ['control', 'shift']) => {
      const wc = t(browser.activeId).wc;
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await sleep(250);
    };

    // Ctrl+Shift+K: the active tab (B) in a new group, named in the strip; Esc keeps it unnamed.
    browser.selectTab(B);
    await sleep(200);
    await press('K');
    const g = t(B).groupId;
    const groupOf = () => browser.groups.normal.tabGroups.get(g) || {};
    result.keyNewGroup = !!g;
    result.nameBox = !!(await until(() => chrome.executeJavaScript("!!document.querySelector('.tgroup input.gedit')")));
    await chrome.executeJavaScript(`(() => { const i = document.querySelector('.tgroup input.gedit'); i.value = 'Read'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await until(() => groupOf().title === 'Read');
    result.groupName = groupOf().title;
    browser.addToGroup(C, g);
    result.afterK = order();

    // Ctrl+Shift+PgDn on C (the group's last tab): it leaves the group; again: it moves right.
    browser.selectTab(C);
    await sleep(200);
    await press('PageDown');
    result.afterPgDn1 = order();
    await press('PageDown');
    result.afterPgDn2 = order();

    // Drag the group's chip to the end of the strip (the strip's own drag handlers).
    await chrome.executeJavaScript(`(() => {
      const chip = document.querySelector('.tgroup[data-gid="${g}"]');
      const host = document.getElementById('tabs');
      const dt = new DataTransfer();
      chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      host.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      host.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    await sleep(300);
    result.afterGroupDragEnd = order();
    // …and onto A (before it): the whole group goes first.
    await chrome.executeJavaScript(`(() => {
      const chip = document.querySelector('.tgroup[data-gid="${g}"]');
      const a = document.querySelector('.tab[data-id="${A}"]'); const r = a.getBoundingClientRect();
      const dt = new DataTransfer();
      chip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      a.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 2, clientY: r.top + 5 }));
      a.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 2, clientY: r.top + 5 }));
      chip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    await sleep(300);
    result.afterGroupDragFirst = order();

    // Ctrl+Shift+L folds B's group (moving off it); Ctrl+Tab then skips the folded tabs.
    browser.selectTab(B);
    await sleep(200);
    await press('L');
    result.folded = !!groupOf().collapsed && t(browser.activeId).groupId !== g;
    const visited = [];
    for (let i = 0; i < 4; i++) { await press('Tab', ['control']); visited.push(t(browser.activeId).title); }
    result.ctrlTab = visited.join('');
    result.ctrlTabSkipsFolded = !visited.includes('B');

    // Ctrl+Shift+U on a grouped tab takes it out.
    browser.selectTab(B); // unfolds the group
    await sleep(200);
    await press('U');
    result.afterU = order();

    result.checks = {
      keyNewGroup: result.keyNewGroup && result.nameBox && result.groupName === 'Read',
      pgDnLeaves: result.afterPgDn1 === 'A B* C D E',
      pgDnMoves: result.afterPgDn2 === 'A B* D C E',
      groupDragEnd: result.afterGroupDragEnd === 'A D C E B*',
      groupDragFirst: result.afterGroupDragFirst === 'B* A D C E',
      fold: result.folded,
      ctrlTabSkipsFolded: result.ctrlTabSkipsFolded,
      keyRemove: result.afterU === 'B A D C E',
    };
    result.ok = Object.values(result.checks).every(Boolean);
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
