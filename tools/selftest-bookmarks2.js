'use strict';
// In-app self-test for 1.7.3: the popup after the star (name, folder, Done, Remove, choose another folder,
// folder remembered) and the check boxes on the Bookmarks page (tick, Shift range, select all / none /
// invert, move, delete, open).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-bookmarks2.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };

module.exports = async ({ app, browser, browsing, ipc, overlayView, setPanel }) => {
  const result = {};
  try {
    const bm = browsing.bookmarks;
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>Page ${req.url.slice(1)}</title>${req.url}`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const go = async (name) => { const t = browser.activeTab(); browser.navigate(t.id, base + name); await until(() => browser.activeTab().title === 'Page ' + name); };
    const ov = (code) => overlayView.webContents.executeJavaScript(code);
    const wipe = () => ov("document.getElementById('content').innerHTML = ''"); // the closed popup's leftovers
    const popupUp = () => until(() => ov("!!document.querySelector('.bmpop select') && !!document.querySelector('.bmpop input')"));
    const title = () => ov("(document.querySelector('.hdr .t') || {}).textContent");
    const setSelect = (v) => ov(`(() => { const s = document.querySelector('.bmsel'); s.value = ${JSON.stringify(String(v))}; s.dispatchEvent(new Event('change')); })()`);
    const click = (sel) => ov(`document.querySelector(${JSON.stringify(sel)}).click()`);
    const panelClosed = () => until(() => !overlayView.getVisible());

    await go('one');
    await wipe();
    const work = bm.addFolder('Work');
    const other = bm.addFolder('Later', 'other');

    // 1. The star bookmarks the page on the bar and opens the popup under it.
    await ipc['bookmarks.toggleActive']();
    const up1 = await popupUp();
    const b1 = bm.find(base + 'one');
    const t1 = await title();
    const c = { popupOpens: !!up1 && overlayView.getVisible(), addedOnBar: !!b1 && b1.parent === 'bar', titleAdded: t1 === 'Bookmark added' };

    const shot = async (wc, name) => { if (process.env.NOVADM_SHOT) fs.writeFileSync(path.join(process.env.NOVADM_SHOT, name), (await wc.capturePage()).toPNG()); };
    await sleep(400);
    await shot(overlayView.webContents, 'popup.png');
    // 2. Choose a folder from the list, rename, Done.
    await setSelect('__choose');
    await until(() => ov("!document.querySelector('.bmtree').hidden"));
    await ov("[...document.querySelectorAll('.bmrow')].find((r) => r.textContent === 'Work').click()");
    await ov("document.querySelector('.bmnew .pri').click()");
    await until(() => bm.find(base + 'one').parent === work.id);
    c.folderChanged = bm.find(base + 'one').parent === work.id;
    await ov("(() => { const i = document.querySelector('.bmpop input'); i.value = 'My page'; })()");
    await click('.acts .pri');
    await panelClosed();
    c.doneRenames = (await until(() => bm.find(base + 'one').title === 'My page')) && !overlayView.getVisible();
    c.folderRemembered = bm.lastParent() === work.id;

    // 3. Next page: goes to the remembered folder; the star on a bookmarked page edits instead of removing.
    await go('two');
    await wipe();
    await ipc['bookmarks.toggleActive']();
    await popupUp();
    c.nextGoesToLastFolder = bm.find(base + 'two').parent === work.id;
    await click('.acts .pri');
    await panelClosed();
    await wipe();
    await ipc['bookmarks.toggleActive']();
    c.secondStarEdits = !!(await until(async () => (await title()) === 'Edit bookmark')) && bm.has(base + 'two');
    await popupUp();

    // 4. Choose another folder: the tree, a new folder inside Other, Choose.
    await setSelect('__choose');
    await until(() => ov("!document.querySelector('.bmtree').hidden"));
    await ov("[...document.querySelectorAll('.bmrow')].find((r) => r.textContent === 'Later').click()");
    await ov("(() => { const i = document.querySelector('.bmnew input'); i.value = 'Inner'; })()");
    await ov("document.querySelector('.bmnew .btn:not(.pri)').click()");
    await until(() => bm.nodes.some((n) => n.type === 'folder' && n.title === 'Inner'));
    await until(() => ov("[...document.querySelectorAll('.bmrow.sel')].some((r) => r.textContent === 'Inner')")); // the new folder is picked
    await ov("document.querySelector('.bmnew .pri').click()");
    const inner = bm.nodes.find((n) => n.title === 'Inner');
    await until(() => bm.find(base + 'two').parent === (inner && inner.id));
    c.chooseAnotherFolder = !!inner && inner.parent === other.id && bm.find(base + 'two').parent === inner.id;
    c.recentListed = bm.recentFolders().map((f) => f.title).includes('Inner');

    // 5. Remove from the popup.
    await click('.acts .btn:not(.pri)');
    await panelClosed();
    c.removeWorks = (await until(() => !bm.has(base + 'two'))) === true;
    setPanel(false);

    // 6. The Bookmarks page: check boxes.
    for (const n of [...bm.nodes]) bm.remove(n.id);
    const F = bm.addFolder('F');
    const mk = (t, p) => bm.add({ url: `https://${t.toLowerCase()}.example/`, title: t, parent: p });
    mk('A'); mk('B'); mk('C'); mk('D'); mk('In1', F.id); mk('In2', F.id);
    const D2 = bm.addFolder('Dest', 'other');
    const tab = browser.tabs.get(browser.openInternal('bookmarks'));
    const page = tab.wc;
    await until(() => !page.isLoading() && browser.tabs.get(tab.id).url.startsWith('novadm://bookmarks'));
    await page.executeJavaScript('window.confirm = () => true; 1');
    const evalp = (code) => page.executeJavaScript(code);
    const rowsLabel = () => evalp("[...document.querySelectorAll('.row')].map((r) => (r.querySelector('.ttl') || {}).textContent).join(',')");
    await until(async () => (await rowsLabel()).includes('In2'));
    const count = () => evalp("document.getElementById('selcount').textContent");
    const boxClick = (label, shift) => evalp(`(() => { const r = [...document.querySelectorAll('.row')].find((x) => x.querySelector('.ttl').textContent === ${JSON.stringify(label)}); r.querySelector('.cb').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: ${!!shift} })); })()`);
    const ticked = () => evalp("[...document.querySelectorAll('.row.picked .ttl')].map((e) => e.textContent).join(',')");

    await boxClick('B'); await sleep(100); await boxClick('D'); await sleep(200);
    await shot(page, 'manager2.png');
    await evalp("document.getElementById('selNone').click()"); await sleep(100);
    c.startsEmpty = (await count()) === 'Nothing selected' && (await evalp("document.getElementById('bulkDelete').disabled"));
    await boxClick('A');
    await sleep(150);
    await boxClick('C', true); // Shift: A..C
    await sleep(150);
    c.shiftRange = (await ticked()) === 'A,B,C';
    await evalp("document.getElementById('selInvert').click()");
    await sleep(150);
    const inv = await ticked();
    c.invert = !inv.includes('A') && inv.includes('D') && inv.includes('F') && inv.includes('In1') && inv.includes('Dest');
    await evalp("document.getElementById('selNone').click()");
    await sleep(150);
    c.selectNone = (await count()) === 'Nothing selected';
    await evalp("document.getElementById('selAll').click()");
    await sleep(150);
    c.selectAll = (await count()) === `${bm.nodes.length} selected`;
    await evalp("document.getElementById('selNone').click()");
    await sleep(100);
    await boxClick('F'); // a folder's box takes what is inside
    await sleep(150);
    c.folderTicksInside = (await ticked()) === 'F,In1,In2';
    await evalp("document.getElementById('moveTo').value = '" + D2.id + "'; document.getElementById('bulkMove').click()");
    await until(() => bm.node(F.id).parent === D2.id);
    c.bulkMove = bm.node(F.id).parent === D2.id && bm.find('https://in1.example/').parent === F.id;
    await sleep(300);
    await boxClick('A'); await sleep(100); await boxClick('B'); await sleep(100);
    const before = bm.items.length;
    await evalp("document.getElementById('bulkDelete').click()");
    await until(() => bm.items.length === before - 2);
    c.bulkDelete = bm.items.length === before - 2 && !bm.has('https://a.example/') && bm.has('https://c.example/');
    await sleep(300);
    // Search narrows "select all" to the results.
    await evalp("(() => { const q = document.getElementById('q'); q.value = 'in'; q.dispatchEvent(new Event('input')); })()");
    await sleep(200);
    await evalp("document.getElementById('selAll').click()");
    await sleep(150);
    c.searchScope = (await count()) === '2 selected';
    const tabs = browser.order.length;
    await evalp("document.getElementById('bulkOpen').click()");
    await until(() => browser.order.length === tabs + 2);
    c.bulkOpen = browser.order.length === tabs + 2;

    result.checks = c;
    result.ok = Object.values(c).every(Boolean);
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
