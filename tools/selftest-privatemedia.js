'use strict';
// In-app self-test for 1.7.12: what NovaDM fetches for a private tab uses the private session. A stream playlist the
// private tab plays, a grabber preview and a grabber download carry no cookie of the normal session, and the grabber
// download is not saved in the downloads list. Made-up site on this PC only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { net: enet } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-privatemedia.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

module.exports = async ({ app, browser, ipc, downloads }) => {
  const result = { checks: {} };
  const c = result.checks;
  const seen = {}; // path -> cookie headers the server got
  let server;
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    server = http.createServer((req, res) => {
      const p = req.url.split('?')[0];
      (seen[p] = seen[p] || []).push(req.headers.cookie || '');
      if (p === '/set') { res.writeHead(200, { 'set-cookie': 'zebra=normal; Path=/', 'content-type': 'text/html' }); return res.end('<title>Set</title>ok'); }
      if (p === '/pl.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST\n'); }
      if (p === '/pic.png') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length }); return res.end(png); }
      if (p === '/file.zip') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 4096 }); return res.end(Buffer.alloc(4096, 3)); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Private page</title><img src="/pic.png" width="300" height="300"><a href="/file.zip">file.zip</a><script>fetch("/pl.m3u8")</script>');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const normalCookie = (list) => (list || []).some((h) => /zebra=normal/.test(h));

    // The normal session gets a cookie for the site.
    const n = browser.createTab({ url: `${base}/set`, win: 'normal', background: false });
    browser.selectTab(n);
    c.normalCookieSet = !!(await until(async () => (await browser.normalSession.cookies.get({ name: 'zebra' })).length));

    // A private tab plays a playlist: NovaDM reads it too (the media panel), with the private session.
    const p = browser.createTab({ url: `${base}/page`, incognito: true, background: false });
    browser.selectTab(p);
    c.playlistReadTwice = !!(await until(() => (seen['/pl.m3u8'] || []).length >= 2, 15000));
    c.playlistNoNormalCookie = c.playlistReadTwice && !normalCookie(seen['/pl.m3u8']);

    // The grabber in the private tab: items are marked private, the preview and the download use the private session.
    await until(() => { const t = browser.tabs.get(p); return t && t.wc && !t.wc.isLoading(); });
    const scan = await ipc['grab.scan']({ autoScroll: false });
    const pic = scan.items.find((i) => /pic\.png/.test(i.url));
    const file = scan.items.find((i) => /file\.zip/.test(i.url));
    c.itemsMarkedPrivate = !!(pic && file && pic.private && file.private);
    if (pic) {
      seen['/pic.png'] = [];
      const r = await enet.fetch('novadm-thumb://img/?u=' + encodeURIComponent(pic.url) + '&r=' + encodeURIComponent(pic.pageUrl) + '&p=1');
      c.thumbLoaded = r.ok;
      c.thumbNoNormalCookie = (seen['/pic.png'] || []).length > 0 && !normalCookie(seen['/pic.png']);
    }
    if (file) {
      seen['/file.zip'] = [];
      await ipc['grab.download']({ items: [file], subfolder: false });
      const d = await until(() => downloads.list().find((x) => /file/.test(x.name) && x.state === 'done'), 15000);
      c.downloadDone = !!d;
      c.downloadPrivate = !!(d && downloads.get(d.id).incognito);
      c.downloadNoNormalCookie = (seen['/file.zip'] || []).length > 0 && !normalCookie(seen['/file.zip']);
      downloads.persist(); downloads.store.flush();
      const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'downloads.json'), 'utf8'));
      c.downloadNotSaved = !JSON.stringify(saved).includes('file.zip');
    }
  } catch (e) {
    result.error = String(e && e.stack || e);
  } finally {
    if (server) server.close();
    result.pass = !result.error && Object.keys(result.checks).length >= 10 && Object.values(result.checks).every(Boolean);
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    app.exit(0);
  }
};
