'use strict';
// In-app self-test for 1.7.7: the bookmark star in the address bar is on only for a page that is bookmarked, follows the
// page when the tab goes elsewhere, switches tabs or the bookmark is removed, is hidden on NovaDM's own pages, and says
// where the bookmark is (so a page that was imported or added with "Bookmark all tabs" can be recognised).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-star.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async ({ app, browser, browsing, ipc, chromeView, setPanel }) => {
  const result = {};
  let server;
  try {
    server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>P ${req.url}</title>page ${req.url}`); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ui = (code) => chromeView.webContents.executeJavaScript(code);
    const star = () => ui("(() => { const b = document.getElementById('star-btn'); return { shown: !b.classList.contains('hidden'), on: b.classList.contains('on'), title: b.title }; })()");
    const bm = browsing.bookmarks;
    const c = {};

    const t1 = browser.createTab({ url: base + '/p1', win: 'normal', background: false }); browser.selectTab(t1); await sleep(1500);
    let s = await star();
    c.offForAPageThatIsNotBookmarked = s.shown && !s.on && /^Bookmark this page/.test(s.title);

    await ipc['bookmarks.toggleActive'](); await sleep(900); setPanel(false); await sleep(500);
    s = await star();
    c.onAfterBookmarking = s.shown && s.on && /Bookmarked in the bookmarks bar/.test(s.title);

    browser.navigate(t1, base + '/p2'); await sleep(1500);
    c.offOnceTheTabGoesElsewhere = await star().then((x) => x.shown && !x.on);

    const t2 = browser.createTab({ url: base + '/p3', win: 'normal', background: false }); browser.selectTab(t2); await sleep(1500);
    c.offInANewTab = await star().then((x) => !x.on);
    browser.selectTab(t1); await sleep(600);
    c.offBackInTheFirstTab = await star().then((x) => !x.on);

    browser.navigate(t1, base + '/p1'); await sleep(1500);
    c.onAgainOnTheBookmarkedPage = await star().then((x) => x.on);

    const b = bm.find(base + '/p1'); bm.remove(b.id); await sleep(900);
    c.offAfterTheBookmarkIsRemoved = await star().then((x) => x.shown && !x.on);

    // A bookmark in a folder: the tooltip names the folder.
    const folder = bm.addFolder('Reading list', 'other');
    bm.add({ url: base + '/p1', title: 'P1', parent: folder.id }); await sleep(900);
    s = await star();
    c.tooltipNamesTheFolder = s.on && /Bookmarked in the folder “Reading list”/.test(s.title);
    bm.remove(bm.find(base + '/p1').id); await sleep(600);

    const t3 = browser.createTab({ url: 'novadm://newtab', win: 'normal', background: false }); browser.selectTab(t3); await sleep(1200);
    c.hiddenOnNovaDMsOwnPages = await star().then((x) => !x.shown);
    const t4 = browser.createTab({ url: base + '/p4#section', win: 'normal', background: false }); browser.selectTab(t4); await sleep(1500);
    c.offForAnotherAddressWithAHash = await star().then((x) => x.shown && !x.on);

    result.checks = c;
    result.ok = Object.values(c).every(Boolean);
  } catch (e) { result.error = String((e && e.stack) || e); }
  try { if (server) server.close(); } catch {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
