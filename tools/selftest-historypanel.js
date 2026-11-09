'use strict';
// In-app self-test for 1.7.14: the History panel. Opens it by the toolbar button and by Ctrl+Shift+H, searches,
// removes one visit, reopens a chosen closed tab (not the last one), shows nothing in a private window, and the
// toolbar view runs sandboxed with its extension-buttons element still working. Made-up pages on this PC only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { BaseWindow } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-historypanel.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

module.exports = async ({ app, browser, ipc, browsing, chromeView }) => {
  const result = { checks: {} };
  const c = result.checks;
  let server;
  const privWin = () => BaseWindow.getAllWindows().find((w) => /Private/.test(w.getTitle()));
  const viewOf = (w, file) => w && w.contentView.children.map((v) => v.webContents).find((wc) => new RegExp(`[\\\\/]ui[\\\\/]${file}\\.html`).test(wc.getURL()));
  const normWin = () => BaseWindow.getAllWindows().find((w) => !/Private/.test(w.getTitle()));
  const key = (wc, keyCode, modifiers = []) => { for (const type of ['keyDown', 'keyUp']) wc.sendInputEvent({ type, keyCode, modifiers }); };
  const loaded = (id) => until(() => { const t = browser.tabs.get(id); return t && t.wc && !t.loading && t.title && !/^(New tab|Loading)/i.test(t.title) ? t : null; });
  try {
    server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>Page ${req.url}</title>x`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // The toolbar view: sandboxed, and its extension-buttons element is defined and connected.
    c.toolbarSandboxed = chromeView.webContents.getLastWebPreferences().sandbox === true;
    result.toolbar = await chromeView.webContents.executeJavaScript(`({ defined: !!customElements.get('browser-action-list'), api: typeof window.browserAction, button: !!document.getElementById('history-btn') })`);
    c.extensionButtonsStillWork = result.toolbar.defined && result.toolbar.api === 'object';

    // History: two visits; two closed tabs.
    browsing.history.add(`${base}/alpha`, 'Alpha page');
    browsing.history.add(`${base}/bravo`, 'Bravo page');
    const t1 = browser.createTab({ url: `${base}/closed-one`, background: false }); await loaded(t1); browser.closeTab(t1);
    const t2 = browser.createTab({ url: `${base}/closed-two`, background: false }); await loaded(t2); browser.closeTab(t2);
    const page = browser.activeTab();

    const panel = viewOf(normWin(), 'panel');
    const state = () => panel.executeJavaScript(`({ current, rows: [...content.querySelectorAll('.hrow .stt')].map((e) => e.textContent), days: [...content.querySelectorAll('.hday')].map((e) => e.textContent), empty: (content.querySelector('.empty') || {}).textContent || '' })`);

    // 1. The toolbar button opens it, with the visits under "Today"; a click again closes it.
    await chromeView.webContents.executeJavaScript(`document.getElementById('history-btn').click()`);
    const s1 = await until(async () => { const s = await state(); return s.current === 'history' && s.rows.length ? s : null; });
    result.button = s1;
    c.buttonOpensPanel = !!s1 && s1.rows.includes('Bravo page') && s1.rows.includes('Alpha page') && s1.days[0] === 'Today';
    c.newestFirst = !!s1 && s1.rows.indexOf('Bravo page') < s1.rows.indexOf('Alpha page');
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-historypanel.png'), (await panel.capturePage()).toPNG());

    // 2. Search filters.
    await panel.executeJavaScript(`(() => { const b = content.querySelector('input'); b.value = 'bravo'; b.dispatchEvent(new Event('input')); })()`);
    const s2 = await until(async () => { const s = await state(); return s.rows.length === 1 ? s : null; }, 3000);
    c.searchFilters = !!s2 && s2.rows[0] === 'Bravo page';

    // 3. The × removes that one visit.
    await panel.executeJavaScript(`content.querySelector('.hrow .hx').click()`);
    await until(() => !browsing.history.visits.some((v) => v.title === 'Bravo page'), 3000);
    c.removeOneVisit = !browsing.history.visits.some((v) => v.title === 'Bravo page') && browsing.history.visits.some((v) => v.title === 'Alpha page');

    // 4. Recently closed: newest first; clicking the older entry reopens that one, not the last.
    await panel.executeJavaScript(`(() => { const b = content.querySelector('input'); b.value = ''; b.dispatchEvent(new Event('input')); content.querySelectorAll('.seg button')[1].click(); })()`);
    const s4 = await until(async () => { const s = await state(); return s.rows.some((r) => /closed-one/.test(r)) ? s : null; }, 3000);
    result.closed = s4;
    c.closedNewestFirst = !!s4 && s4.rows.findIndex((r) => /closed-two/.test(r)) < s4.rows.findIndex((r) => /closed-one/.test(r));
    await panel.executeJavaScript(`[...content.querySelectorAll('.hrow')].find((r) => /closed-one/.test(r.textContent)).click()`);
    const back = await until(() => browser.order.map((id) => browser.tabs.get(id)).find((t) => t && /closed-one/.test(t.url || '')), 5000);
    c.reopensChosenEntry = !!back && browser.closed.some((e) => /closed-two/.test(e.url || ''));

    // 5. Ctrl+Shift+H opens it, and again closes it; Esc closes it.
    await sleep(300);
    key(page.wc, 'H', ['control', 'shift']);
    const k1 = await until(async () => (await state()).current === 'history', 3000);
    key(panel, 'H', ['control', 'shift']);
    const k2 = await until(async () => (await state()).current === null, 3000);
    c.ctrlShiftHToggles = !!k1 && !!k2;
    key(page.wc, 'H', ['control', 'shift']);
    await until(async () => (await state()).current === 'history', 3000);
    key(panel, 'Escape');
    c.escCloses = !!(await until(async () => (await state()).current === null, 3000));

    // 6. A private window: neither visits nor closed tabs, a plain message instead.
    ipc['tabs.new']({ incognito: true });
    await until(() => privWin() && browser.groups.private.activeId != null, 6000);
    await sleep(800);
    const pPanel = viewOf(privWin(), 'panel');
    await viewOf(privWin(), 'chrome').executeJavaScript(`document.getElementById('history-btn').click()`);
    const ps = await until(async () => { const s = await pPanel.executeJavaScript(`({ current, rows: content.querySelectorAll('.hrow').length, empty: (content.querySelector('.empty') || {}).textContent || '' })`); return s.current === 'history' && s.empty ? s : null; }, 4000);
    result.private = ps;
    c.privateShowsNothing = !!ps && ps.rows === 0 && /private/i.test(ps.empty);
    c.privateHandlerEmpty = browser.inGroup('private', () => { const r = ipc['history.panel']({}); return r.private === true && !r.items.length && !r.closed.length; });

    result.ok = Object.values(c).every(Boolean);
  } catch (e) {
    result.fatal = String((e && e.stack) || e);
  }
  try { if (server) server.close(); } catch {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
