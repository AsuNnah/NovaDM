'use strict';
// In-app self-test for 1.7.7: a bookmark on the bookmarks bar opens when it is CLICKED (press and release), not when the
// button goes down, so pressing on it to drag it to another place no longer opens the page (or a folder's menu) first.
// Real mouse events go to the toolbar (sendInputEvent); the drag itself is covered by selftest-bookmarks.js.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-barclick.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ app, browser, browsing, ipc, chromeView }) => {
  const result = {};
  try {
    const bm = browsing.bookmarks;
    bm.add({ url: 'https://one.example/', title: 'One', parent: 'bar' });
    bm.add({ url: 'https://two.example/', title: 'Two', parent: 'bar' });
    const folder = bm.addFolder('Folder', 'bar');
    bm.add({ url: 'https://in.example/', title: 'In', parent: folder.id });
    await sleep(3500); // the icon lookups of the made-up sites finish (each answer redraws the bar)
    const wc = chromeView.webContents;
    const ui = (code) => wc.executeJavaScript(code);

    const counts = { open: 0, how: [], menu: 0 };
    const realOpen = ipc['bookmarks.open'];
    ipc['bookmarks.open'] = (a) => { counts.open++; counts.how.push(a.how); return undefined; }; // no real navigation
    ipc['bookmarks.listMenu'] = () => { counts.menu++; }; // no native menu in a test
    const centre = (i) => ui(`(() => { const r = document.querySelectorAll('#bm-items .bm')[${i}].getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    const press = (p, button = 'left') => wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button, clickCount: 1 });
    const release = (p, button = 'left') => wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button, clickCount: 1 });
    const c = {};

    const one = await centre(0);
    wc.sendInputEvent({ type: 'mouseMove', x: one.x, y: one.y }); await sleep(150);
    press(one); await sleep(500);
    c.pressAloneOpensNothing = counts.open === 0;
    release(one); await sleep(500);
    c.releaseOpensIt = counts.open === 1 && counts.how[0] === 'here';

    // Ctrl+click: a new tab.
    wc.sendInputEvent({ type: 'mouseDown', x: one.x, y: one.y, button: 'left', clickCount: 1, modifiers: ['control'] }); await sleep(150);
    wc.sendInputEvent({ type: 'mouseUp', x: one.x, y: one.y, button: 'left', clickCount: 1, modifiers: ['control'] }); await sleep(500);
    c.ctrlClickOpensATab = counts.open === 2 && counts.how[1] === 'tab';

    // Middle button: a new tab, on release.
    const two = await centre(1);
    press(two, 'middle'); await sleep(300);
    c.middlePressAloneOpensNothing = counts.open === 2;
    release(two, 'middle'); await sleep(500);
    c.middleReleaseOpensATab = counts.open === 3 && counts.how[2] === 'tab';

    // A folder: its menu comes on the click, not the press.
    const f = await centre(2);
    press(f); await sleep(400);
    c.folderPressAloneShowsNoMenu = counts.menu === 0;
    release(f); await sleep(500);
    c.folderClickShowsTheMenu = counts.menu === 1;

    // Pressing and moving away to drag: the drag starts, and nothing opens.
    const before = { open: counts.open, menu: counts.menu };
    await ui("window.__dragStarts = 0; document.addEventListener('dragstart', () => { window.__dragStarts++; }, true);");
    press(one); await sleep(150);
    for (let i = 1; i <= 8; i++) { wc.sendInputEvent({ type: 'mouseMove', x: one.x + i * 12, y: one.y, modifiers: ['leftButtonDown'] }); await sleep(40); }
    await sleep(500);
    c.dragStartsWithoutOpening = (await ui('window.__dragStarts')) >= 1 && counts.open === before.open && counts.menu === before.menu;
    release({ x: one.x + 100, y: one.y }); await sleep(500);
    c.releaseAfterDragOpensNothing = counts.open === before.open && counts.menu === before.menu;

    ipc['bookmarks.open'] = realOpen;
    result.checks = c;
    result.counts = counts;
    result.ok = Object.values(c).every(Boolean);
  } catch (e) { result.error = String((e && e.stack) || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
