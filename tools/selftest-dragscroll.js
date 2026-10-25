'use strict';
// In-app self-test for 1.7.7: dragging scrolls the page when the pointer is near its top or bottom edge (Bookmarks page),
// and scrolls the tab strip when the pointer is near either end of it, and stops when the drag ends. Drag events are
// sent to the page's own handlers (a real OS drag can't be driven from a script).
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-dragscroll.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ app, browser, browsing, chromeView, getWindow }) => {
  const result = {};
  try {
    const win = getWindow();
    if (win.isMaximized()) win.unmaximize();
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setContentSize(1000, 700); await sleep(800);
    const c = {};

    // ---- the Bookmarks page: 60 bookmarks, longer than the window ----
    const bm = browsing.bookmarks;
    for (let i = 0; i < 60; i++) bm.add({ url: `https://site${i}.example/`, title: `Site ${String(i).padStart(2, '0')}`, parent: 'bar' });
    const id = browser.createTab({ url: 'novadm://bookmarks', win: 'normal', background: false });
    browser.selectTab(id);
    await sleep(2500);
    const wc = browser.tabs.get(id).wc;
    const page = (code) => wc.executeJavaScript(code);
    c.pageIsLongerThanWindow = await page('document.documentElement.scrollHeight > window.innerHeight + 200');
    // Pretend a drag of the first row, then hold the pointer near an edge for a while (dragover every 50 ms).
    const hold = (clientY, ms) => page(`new Promise((res) => {
      const row = document.querySelectorAll('.row')[0]; const other = document.querySelectorAll('.row')[3];
      const dt = new DataTransfer();
      if (!window.__dragging) { row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt })); window.__dragging = true; }
      const t0 = performance.now();
      const fire = () => { other.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: 300, clientY: ${clientY} < 0 ? window.innerHeight + ${clientY} : ${clientY}, dataTransfer: dt })); if (performance.now() - t0 > ${ms}) { clearInterval(iv); res(Math.round(window.scrollY)); } };
      fire(); const iv = setInterval(fire, 50);
    })`);
    const y0 = await page('Math.round(window.scrollY)');
    const down = await hold(-6, 900);
    c.scrollsDownNearBottom = down > y0 + 150;
    const up1 = await hold(6, 250); // a little way up, then the pointer goes to the middle of the window: no more scrolling
    const mid = await hold(300, 500);
    await sleep(100);
    const still = await page('Math.round(window.scrollY)');
    c.noScrollInTheMiddle = up1 < down - 100 && up1 > 100 && Math.abs(mid - up1) < 5 && Math.abs(still - mid) < 5;
    const up = await hold(6, 1200);
    c.scrollsUpNearTop = up < mid - 100;
    result.pageScroll = { y0, down, up1, mid, still, up };
    // The drag ends: scrolling stops even if events stopped coming.
    await hold(-6, 300);
    await page("document.querySelectorAll('.row')[0].dispatchEvent(new DragEvent('dragend', { bubbles: true })); window.__dragging = false;");
    const after1 = await page('Math.round(window.scrollY)'); await sleep(400);
    const after2 = await page('Math.round(window.scrollY)');
    c.stopsWhenTheDragEnds = Math.abs(after2 - after1) < 3;
    browser.closeTab(id);

    // ---- the tab strip: 40 tabs, a tab dragged toward either end ----
    const ids = [];
    for (let i = 0; i < 40; i++) ids.push(browser.createTab({ url: 'novadm://newtab', win: 'normal', background: true }));
    await sleep(2000);
    const ui = (code) => chromeView.webContents.executeJavaScript(code);
    const strip = (end, ms) => ui(`new Promise((res) => {
      const host = document.getElementById('tabs'); const r = host.getBoundingClientRect(); const tab = document.querySelectorAll('.tab')[5];
      const dt = new DataTransfer();
      if (!window.__tabDrag) { tab.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt })); window.__tabDrag = true; }
      const x = ${end} === 0 ? r.left + 6 : r.right - 6; const t0 = performance.now();
      const fire = () => { tab.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: r.top + 15, dataTransfer: dt })); if (performance.now() - t0 > ${ms}) { clearInterval(iv); res(Math.round(host.scrollLeft)); } };
      fire(); const iv = setInterval(fire, 50);
    })`);
    const x0 = await ui("Math.round(document.getElementById('tabs').scrollLeft)");
    const right = await strip(1, 900);
    c.stripScrollsTowardTheRightEnd = right > x0 + 100;
    const left = await strip(0, 900);
    c.stripScrollsTowardTheLeftEnd = left < right - 100;
    await ui("document.querySelectorAll('.tab')[5].dispatchEvent(new DragEvent('dragend', { bubbles: true })); window.__tabDrag = false;");
    const s1 = await ui("Math.round(document.getElementById('tabs').scrollLeft)"); await sleep(400);
    const s2 = await ui("Math.round(document.getElementById('tabs').scrollLeft)");
    c.stripStopsWhenTheDragEnds = Math.abs(s2 - s1) < 3;
    for (const t of ids) browser.closeTab(t);

    result.checks = c;
    result.ok = Object.values(c).every(Boolean);
  } catch (e) { result.error = String((e && e.stack) || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
