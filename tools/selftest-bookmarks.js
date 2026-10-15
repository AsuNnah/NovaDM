'use strict';
// In-app self-test for 1.7.0: the bookmarks bar and manager page with the bookmark tree.
// Real drag events go through the bar's and the page's own handlers: reorder on the bar, drop onto a folder,
// drop onto "Other bookmarks", the » overflow; the manager lists both parts, makes a folder, moves by drag.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-bookmarks.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };

module.exports = async ({ app, browser, browsing, ipc, chromeView }) => {
  const result = {};
  try {
    const bm = browsing.bookmarks;
    const names = (p) => bm.children(p).map((n) => n.title).join(',');
    const f = bm.addFolder('Work');
    for (const t of ['A', 'B', 'C']) bm.add({ url: `https://${t.toLowerCase()}.example/`, title: t });
    bm.add({ url: 'https://in.example/', title: 'In', parent: f.id });
    bm.add({ url: 'https://o.example/', title: 'O', parent: 'other' });
    await sleep(600);
    const cv = chromeView.webContents;
    const ui = (code) => cv.executeJavaScript(code);
    const chips = () => ui("[...document.querySelectorAll('#bm-items .bm')].map((e) => e.textContent.trim()).join(',')");
    result.barBefore = await chips();
    const otherShown = await ui("!document.getElementById('bm-other').classList.contains('hidden')");

    // Fire a drag from one chip onto another, with the pointer at a fraction of the target's width.
    const drag = (from, to, frac) => ui(`(() => {
      const chips = [...document.querySelectorAll('#bm-items .bm')];
      const a = chips.find((e) => e.textContent.trim() === ${JSON.stringify(from)});
      const b = ${to === '#other' ? "document.getElementById('bm-other')" : `chips.find((e) => e.textContent.trim() === ${JSON.stringify(to)})`};
      const dt = new DataTransfer();
      a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const r = b.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width * ${frac}, clientY: r.top + 5 };
      b.dispatchEvent(new DragEvent('dragover', o));
      b.dispatchEvent(new DragEvent('drop', o));
      a.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);

    await drag('C', 'Work', 0.1); // C before Work
    await until(() => names('bar') === 'C,Work,A,B');
    const reorder = names('bar');
    await drag('A', 'Work', 0.5); // A into Work
    await until(() => names(f.id) === 'In,A');
    const intoFolder = names(f.id);
    await drag('B', '#other', 0.5); // B to Other bookmarks
    await until(() => names('other') === 'O,B');
    const toOther = names('other');
    await sleep(300);
    result.barAfter = await chips();

    // The manager page.
    const tab = browser.tabs.get(browser.openInternal('bookmarks'));
    const page = tab.wc;
    await until(() => !page.isLoading() && browser.tabs.get(tab.id).url.startsWith('novadm://bookmarks'));
    const rows = () => page.executeJavaScript("[...document.querySelectorAll('.row .ttl')].map((e) => e.textContent).join(',')");
    const mgr = await until(async () => { const r = await rows(); return r.includes('Work') ? r : null; });
    const headings = await page.executeJavaScript("[...document.querySelectorAll('h2')].map((e) => e.textContent).join('|')");
    await page.executeJavaScript("document.getElementById('newFolder').click()");
    await until(() => bm.nodes.some((n) => n.type === 'folder' && n.title === 'New folder'));
    // Drag "O" (in Other) onto the "New folder" row's middle: it goes inside.
    const nf = bm.nodes.find((n) => n.type === 'folder' && n.title === 'New folder');
    await page.executeJavaScript(`(async () => {
      const rows = [...document.querySelectorAll('.row')];
      const rowOf = (t) => rows.find((r) => { const x = r.querySelector('.ttl'); return x && x.textContent === t; });
      const a = rowOf('O');
      const b = rows.find((r) => r.querySelector('.form input') && r.querySelector('.form input').value === 'New folder') || rowOf('New folder');
      const dt = new DataTransfer();
      a.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      const r = b.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 20, clientY: r.top + r.height / 2 };
      b.dispatchEvent(new DragEvent('dragover', o));
      b.dispatchEvent(new DragEvent('drop', o));
    })()`);
    await until(() => names(nf.id) === 'O');
    const mgrDrag = names(nf.id);
    // A folder can't be moved into itself.
    const cannot = bm.move(f.id, f.id, 0) === false;
    // Import panel: lists browsers (names only), has the file choice.
    await page.executeJavaScript("document.getElementById('import').click()");
    const panel = await until(() => page.executeJavaScript("(() => { const b = document.getElementById('imp'); return !b.hidden && /From a file/.test(b.textContent) ? b.textContent.length : 0; })()"));

    // Many bookmarks: the rest go into », and the folder button still shows.
    for (let i = 0; i < 40; i++) bm.add({ url: `https://many${i}.example/`, title: 'Many bookmark ' + i });
    await sleep(700);
    const overflow = await ui("!document.getElementById('bm-more').classList.contains('hidden')");

    if (process.env.NOVADM_SHOT) {
      await page.executeJavaScript("document.getElementById('imp').hidden = true");
      await sleep(300);
      fs.writeFileSync(path.join(process.env.NOVADM_SHOT, 'bar.png'), (await cv.capturePage({ x: 0, y: 0, width: 900, height: 125 })).toPNG());
      fs.writeFileSync(path.join(process.env.NOVADM_SHOT, 'manager.png'), (await page.capturePage()).toPNG());
    }
    result.checks = {
      barStartedWithFolderAndUrls: result.barBefore === 'Work,A,B,C',
      otherButtonShown: otherShown,
      reorder: reorder === 'C,Work,A,B',
      intoFolder: intoFolder === 'In,A',
      toOther: toOther === 'O,B',
      managerShowsTree: !!mgr && headings === 'Bookmarks bar|Other bookmarks' && /Work/.test(mgr) && /Other|O/.test(mgr),
      managerDragIntoFolder: mgrDrag === 'O',
      noFolderIntoItself: cannot,
      importPanel: !!panel,
      overflowMenu: overflow,
    };
    result.ok = Object.values(result.checks).every(Boolean);
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
