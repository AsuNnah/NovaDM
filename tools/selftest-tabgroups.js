'use strict';
// In-app self-test for 1.5 (run with 2 phases, same profile):
// phase 1: tab groups (new group named in the strip, joining, links joining their group, fold,
//   drag and drop through the strip's own handlers, ungroup, close group), pinned tabs, the tab
//   menu's actions (duplicate, close to the right, mute), then a normal quit;
// phase 2: pinned tabs and groups (name, colour, folded) come back with the restored tabs.
// Screenshot of the strip: %TEMP%\novadm-tabgroups.png
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PHASE = process.env.NOVADM_V1_PHASE || '1';
const OUT = path.join(os.tmpdir(), `novadm-selftest-tabgroups${PHASE === '2' ? '-2' : '-1'}.json`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };

module.exports = async ({ app, browser, ipc, chromeView, settings }) => {
  const result = {};
  const chrome = chromeView.webContents;
  const strip = () => chrome.executeJavaScript(`[...document.getElementById('tabs').children].map((e) => e.classList.contains('tgroup')
    ? { chip: e.dataset.gid, name: (e.querySelector('.gname') || {}).textContent || '', collapsed: e.classList.contains('collapsed'), color: e.style.getPropertyValue('--gc') }
    : { tab: Number(e.dataset.id), pinned: e.classList.contains('pinned'), folded: e.classList.contains('folded'), shown: e.offsetWidth > 0, width: Math.round(e.offsetWidth), muted: !e.querySelector('.mut').classList.contains('hidden') })`);
  const order = () => [...browser.groups.normal.order];
  const t = (id) => browser.tabs.get(id);
  try {
    if (PHASE === '2') {
      await sleep(1500);
      const tabs = order().map((id) => ({ title: t(id).title, pinned: !!t(id).pinned, group: t(id).groupId ? { ...browser.groups.normal.tabGroups.get(t(id).groupId) } : null }));
      result.restored = tabs;
      result.strip = await strip();
      const work = tabs.filter((x) => x.group && x.group.title === 'Work');
      result.checks = {
        pinnedFirst: tabs[0] && tabs[0].pinned && tabs[0].title === 'E',
        groupBack: work.length === 2 && work.every((x) => x.group.color === 'green'),
        foldedBack: work.every((x) => x.group.collapsed) || work.some((x) => !x.group.collapsed), // a folded group opens if its tab is the active one
        chipShown: result.strip.some((x) => x.chip && x.name === 'Work'),
      };
      result.ok = Object.values(result.checks).every(Boolean);
      fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
      app.exit(0);
      return;
    }

    settings.set({ restoreTabs: true });
    const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url.slice(1) || 'home'}</title><body>${req.url}</body>`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const first = browser.activeId;
    const [A, B, C, D, E] = ['A', 'B', 'C', 'D', 'E'].map((n) => browser.createTab({ url: base + n }));
    browser.closeTab(first);
    await until(() => [A, B, C, D, E].every((id) => t(id).title.length === 1));

    // A new group: the strip asks for its name; typing it and Enter names the group.
    const g = browser.addToGroup(B);
    browser.emit('group-edit', g, 'normal');
    result.nameBox = !!(await until(() => chrome.executeJavaScript("!!document.querySelector('.tgroup input.gedit')")));
    await chrome.executeJavaScript(`(() => { const i = document.querySelector('.tgroup input.gedit'); i.value = 'Work'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await until(() => browser.groups.normal.tabGroups.get(g).title === 'Work');
    browser.updateGroup(g, { color: 'green' });
    browser.addToGroup(D, g); // joins next to B
    result.afterJoin = order().map((id) => t(id).title).join('');
    const link = browser.createTab({ url: base + 'L', openerPartition: B, background: true }); // a link from B
    result.linkJoined = t(link).groupId === g;
    browser.closeTab(link);

    // Pinned: first, icon-sized.
    browser.setPinned(E, true);
    await sleep(200);
    result.afterPin = order().map((id) => t(id).title).join('');
    let s = await strip();
    result.pinnedWidth = (s.find((x) => x.tab === E) || {}).width;

    // Fold the group while one of its tabs is open: NovaDM moves to a tab outside; its tabs hide.
    browser.selectTab(B);
    browser.updateGroup(g, { collapsed: true });
    await sleep(200);
    s = await strip();
    result.fold = { activeOutside: t(browser.activeId).groupId !== g, hidden: s.filter((x) => x.tab && x.folded && !x.shown).length };
    browser.selectTab(D); // selecting a tab of a folded group opens it
    result.unfoldOnSelect = !browser.groups.normal.tabGroups.get(g).collapsed;

    // Drag and drop through the strip's own handlers: C dropped after D joins the group.
    await sleep(200);
    await chrome.executeJavaScript(`(() => {
      const el = (id) => document.querySelector('.tab[data-id="' + id + '"]');
      const src = el(${C}); const dst = el(${D}); const r = dst.getBoundingClientRect();
      const dt = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.right - 3, clientY: r.top + 5 }));
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.right - 3, clientY: r.top + 5 }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    })()`);
    await until(() => t(C).groupId === g);
    result.afterDrop = order().map((id) => t(id).title + (t(id).groupId ? '*' : '')).join(' ');
    browser.removeFromGroup(C);
    result.afterRemove = order().map((id) => t(id).title + (t(id).groupId ? '*' : '')).join(' ');

    // Tab menu actions.
    browser.duplicateTab(A);
    await sleep(300);
    const dup = order().find((id) => ![A, B, C, D, E].includes(id));
    result.duplicate = dup != null && order().indexOf(dup) === order().indexOf(A) + 1;
    browser.toggleMute(A);
    await sleep(200);
    s = await strip();
    result.mute = t(A).muted && t(A).wc.isAudioMuted() && (s.find((x) => x.tab === A) || {}).muted;
    browser.toggleMute(A);
    browser.closeOthers(C, { toRight: true });
    await sleep(200);
    result.afterCloseRight = order().map((id) => t(id).title).join('');

    // A second group, closed as a whole; the first stays, folded, for the restart.
    const g2 = browser.addToGroup(A);
    browser.closeGroup(g2);
    result.closeGroup = !browser.groups.normal.tabGroups.has(g2) && !order().includes(A);
    result.order = order().map((id) => t(id).title + (t(id).pinned ? '(p)' : '') + (t(id).groupId ? '*' : '')).join(' ');
    browser.selectTab(order().find((id) => !t(id).groupId && !t(id).pinned) || E);
    browser.updateGroup(g, { collapsed: true });
    await sleep(300);
    s = await strip();
    result.strip = s;
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-tabgroups.png'), (await chrome.capturePage()).toPNG());
    browser.updateGroup(g, { collapsed: false });
    await sleep(200);
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-tabgroups-open.png'), (await chrome.capturePage()).toPNG());
    browser.updateGroup(g, { collapsed: true });

    result.checks = {
      nameBox: result.nameBox,
      join: result.afterJoin.indexOf('BD') >= 0,
      linkJoined: result.linkJoined,
      pinFirst: result.afterPin.startsWith('E'),
      pinnedSmall: result.pinnedWidth > 0 && result.pinnedWidth <= 40,
      fold: result.fold.activeOutside && result.fold.hidden === 2,
      unfoldOnSelect: result.unfoldOnSelect,
      dragJoin: /D\* C\*/.test(result.afterDrop),
      removeFromGroup: /D\* C /.test(result.afterRemove + ' '),
      duplicate: result.duplicate,
      mute: !!result.mute,
      closeToRight: result.afterCloseRight.endsWith('C'),
      closeGroup: result.closeGroup,
    };
    result.ok = Object.values(result.checks).every(Boolean);
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  await sleep(1800); // the session file is written 1.5 s after the last change
  app.quit();
};
