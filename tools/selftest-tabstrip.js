'use strict';
// In-app self-test for 1.7.7: with more tabs than fit, the strip scrolls sideways (wheel), the active tab is always
// brought into view, and the ▾ button (shown only then) lists every tab, with a search box; a few tabs show no button.
// Before, the tabs that didn't fit were cut off behind the "+" button and could not be reached.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-tabstrip.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ app, browser, chromeView, overlayView, getWindow }) => {
  const result = {};
  try {
    const win = getWindow();
    if (win.isMaximized()) win.unmaximize();
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setContentSize(1000, 700); await sleep(800);
    const ui = (code) => chromeView.webContents.executeJavaScript(code);
    const state = () => ui(`(() => {
      const h = document.getElementById('tabs'); const a = h.querySelector('.tab.active'); const hr = h.getBoundingClientRect(); const ar = a && a.getBoundingClientRect();
      return { over: h.scrollWidth > h.clientWidth + 1, left: Math.round(h.scrollLeft), button: !document.getElementById('tablist').classList.contains('hidden'),
        activeVisible: !!ar && ar.left >= hr.left - 1 && ar.right <= hr.right + 1, tabs: h.querySelectorAll('.tab').length };
    })()`);
    const c = {};
    const resizeErrors = []; // Chromium's "ResizeObserver loop completed with undelivered notifications" (1.7.7 logged it while tabs opened)
    chromeView.webContents.on('console-message', (e) => { if (/ResizeObserver/.test(e.message)) resizeErrors.push(e.message.slice(0, 60)); });

    c.fewTabsNoButton = await state().then((s) => !s.over && !s.button);

    // A resize that makes the tabs stop fitting, and fit again: the ▾ button is switched on and off by the strip's own
    // size observer, the case where Chromium logs "ResizeObserver loop completed with undelivered notifications".
    win.setContentSize(1400, 700); await sleep(700);
    const more = [];
    for (let i = 0; i < 14; i++) more.push(browser.createTab({ url: 'novadm://newtab', win: 'normal', background: true }));
    await sleep(1500);
    c.fitsWhenWide = await state().then((s) => !s.over && !s.button);
    win.setContentSize(600, 700); await sleep(1000);
    c.overflowsWhenNarrow = await state().then((s) => s.over && s.button);
    win.setContentSize(1400, 700); await sleep(1000);
    c.fitsAgainWhenWide = await state().then((s) => !s.over && !s.button);
    for (const id of more) browser.closeTab(id);
    win.setContentSize(1000, 700); await sleep(800);

    const first = browser.order[0];
    const ids = [];
    for (let i = 0; i < 40; i++) ids.push(browser.createTab({ url: 'novadm://newtab', win: 'normal', background: true }));
    await sleep(2000);
    const many = await state();
    c.manyTabsOverflowAndButton = many.over && many.button && many.tabs === 41;

    browser.selectTab(ids[ids.length - 1]); await sleep(600);
    const last = await state();
    c.lastTabBroughtIntoView = last.activeVisible && last.left > 0;

    browser.selectTab(first); await sleep(600);
    const back = await state();
    c.firstTabBroughtBack = back.activeVisible && back.left <= 2;

    const wheel = await ui(`(() => { const h = document.getElementById('tabs'); const before = h.scrollLeft; const ev = new WheelEvent('wheel', { deltaY: 300, cancelable: true, bubbles: true }); h.dispatchEvent(ev); return { moved: Math.round(h.scrollLeft - before), prevented: ev.defaultPrevented }; })()`);
    c.wheelScrollsTheStrip = wheel.moved > 0 && wheel.prevented;

    // The ▾ button opens the list of all tabs; choosing one goes to it and the strip shows it.
    await ui("document.getElementById('tablist').click()"); await sleep(1000);
    const rows = await overlayView.webContents.executeJavaScript("document.querySelectorAll('.srow').length");
    c.listShowsEveryTab = rows === 41;
    const target = browser.order[33];
    await overlayView.webContents.executeJavaScript("document.querySelectorAll('.srow')[33].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))");
    await sleep(900);
    const chosen = await state();
    c.choosingATabGoesToIt = browser.activeId === target && chosen.activeVisible;

    // Back to a few tabs: no button.
    for (const id of ids) browser.closeTab(id);
    await sleep(1200);
    c.buttonGoneWithFewTabs = await state().then((s) => !s.over && !s.button);
    c.noResizeObserverErrors = resizeErrors.length === 0;
    result.resizeErrors = resizeErrors.length;

    result.checks = c;
    result.ok = Object.values(c).every(Boolean);
  } catch (e) { result.error = String((e && e.stack) || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
