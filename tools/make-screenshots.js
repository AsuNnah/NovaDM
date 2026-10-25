'use strict';
// Makes the README screenshots (screenshots/*.png) from a throwaway profile with made-up content: a demo site on
// this PC, made-up bookmarks and downloads. Nothing of the person running it is shown (a fresh profile has no history,
// bookmarks or sign-ins). Run it with run-screenshots.ps1 or by hand:
//   NOVADM_USERDATA=<empty temp folder> NOVADM_SELFTEST=tools/make-screenshots.js npx electron . --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
// (The three switches keep the window drawing when other programs cover it; without them the pictures can come out empty.)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { nativeImage } = require('electron');
const { encode } = require('./png');

const OUT_DIR = path.join(__dirname, '..', 'screenshots');
const RESULT = path.join(os.tmpdir(), 'novadm-selftest-make-screenshots.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };

const PALETTE = [[91, 124, 250], [34, 170, 140], [240, 150, 60], [200, 80, 120], [120, 90, 200], [60, 140, 210]];
const gradient = (w, h, i) => {
  const a = PALETTE[i % PALETTE.length]; const b = PALETTE[(i + 2) % PALETTE.length];
  return encode(w, h, (x, y) => { const t = (x / w + y / h) / 2; return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)).concat(255); });
};

const PAGES = {
  '/': ['Nova Lake Journal', 'Slow mornings by the lake', 0],
  '/docs': ['Nova Lake Docs', 'Everything about the lake station', 1],
  '/recipes': ['Slow Cooking Recipes', 'Soups and stews for cold evenings', 2],
  '/maps': ['Trail Maps', 'Hikes around the lake, with distances', 3],
  '/brief': ['Daily Brief', 'Five minutes, five stories', 4],
};
const WATCH = `<!doctype html><meta charset="utf-8"><title>Lake Conference 2026: opening talk</title><link rel="icon" href="/fav/5.png">
<style>body{margin:0;font:16px/1.5 "Segoe UI",system-ui,sans-serif;background:#10131a;color:#e8ebf3}main{max-width:880px;margin:40px auto}video{width:880px;height:495px;background:#000 url(/img/5.png) center/cover;border-radius:10px}h1{font-size:24px;margin:18px 0 4px}p{color:#9aa3b8;margin:0}</style>
<main><video controls></video><h1>Lake Conference 2026: opening talk</h1><p>Made-up page for NovaDM's screenshots.</p></main><script>fetch('/hls/master.m3u8').then((r) => r.text())</script>`;
const pageHtml = (url) => {
  const [title, lead, n] = PAGES[url];
  const cards = [0, 1, 2].map((i) => `<div class="card"><img src="/img/${n + i}.png" width="360" height="190"><h3>${['The first ferry', 'Mist over the pier', 'A quiet harbour'][i]}</h3><p>Short notes from the lake, written between the first light and the last boat. Read it with coffee.</p></div>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><link rel="icon" href="/fav/${n}.png">
<style>body{margin:0;font:16px/1.55 "Segoe UI",system-ui,sans-serif;color:#1d2330;background:#f6f7fb}
header{display:flex;gap:28px;align-items:center;padding:18px 48px;background:#fff;border-bottom:1px solid #e3e6ee}
header b{font-size:20px;color:#3a55d8}header a{color:#4a5368;text-decoration:none}
.hero{padding:64px 48px;color:#fff;background:linear-gradient(120deg,#5b7cfa,#22aa8c)}.hero h1{margin:0 0 8px;font-size:40px}.hero p{margin:0;font-size:19px;opacity:.92}
.cards{display:flex;gap:24px;padding:36px 48px}.card{flex:1;background:#fff;border-radius:12px;box-shadow:0 2px 10px #1d233012;padding:12px 12px 20px}
.card img{width:100%;height:auto;border-radius:8px}.card h3{margin:14px 8px 6px}.card p{margin:0 8px;color:#586177;font-size:14.5px}</style>
<header><b>${title}</b><a>Home</a><a>Stories</a><a>Maps</a><a>About</a></header>
<div class="hero"><h1>${lead}</h1><p>Made-up page for NovaDM's screenshots.</p></div><div class="cards">${cards}</div>`;
};

function startServer(files) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u === '/watch') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(WATCH); }
      if (u === '/hls/master.m3u8') { // three qualities, so the video panel has something to choose from
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        return res.end(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080', '1080/index.m3u8', '#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720', '720/index.m3u8',
          '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=854x480', '480/index.m3u8', ''].join('\n'));
      }
      if (/^\/hls\/\d+\/index\.m3u8$/.test(u)) {
        const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:6'];
        for (let i = 0; i < 40; i++) lines.push('#EXTINF:6,', `seg${i}.ts`);
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        return res.end(lines.concat('#EXT-X-ENDLIST', '').join('\n'));
      }
      if (/^\/hls\/\d+\/seg\d+\.ts$/.test(u)) { res.writeHead(200, { 'content-type': 'video/mp2t' }); return res.end(crypto.randomBytes(20000)); }
      if (PAGES[u]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(pageHtml(u)); }
      let m = /^\/img\/(\d+)\.png$/.exec(u);
      if (m) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(gradient(360, 190, Number(m[1]))); }
      m = /^\/fav\/(\d+)\.png$/.exec(u);
      if (m) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(gradient(32, 32, Number(m[1]))); }
      m = /^\/files\/(.+)$/.exec(u);
      const f = m && files[decodeURIComponent(m[1])];
      if (f) { // f = { bytes, kbps }: sent at about kbps KB/s, so the slow ones are still running at screenshot time
        const rng = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        const s = rng ? Number(rng[1]) : 0; const e = rng && rng[2] ? Number(rng[2]) : f.bytes.length - 1;
        res.writeHead(rng ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': e - s + 1, 'accept-ranges': 'bytes', ...(rng ? { 'content-range': `bytes ${s}-${e}/${f.bytes.length}` } : {}) });
        if (!f.kbps) return res.end(f.bytes.subarray(s, e + 1));
        let off = s; const chunk = 16 * 1024; const delay = Math.round(chunk / (f.kbps * 1024 / 1000));
        const tick = () => { if (res.destroyed || off > e) return res.end(); const n = Math.min(chunk, e - off + 1); res.write(f.bytes.subarray(off, off + n)); off += n; setTimeout(tick, delay); };
        return tick();
      }
      res.writeHead(404); res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

/** One picture of the whole window: every visible view, bottom to top, drawn at its place (the window itself can't be captured). */
async function shootWindow(win, file) {
  const [W, H] = win.getContentSize();
  const views = win.contentView.children.filter((v) => v.webContents && v.getVisible && v.getVisible());
  let ratio = 1; let out = null; const parts = [];
  for (const v of views) {
    const b = v.getBounds(); if (b.width < 2 || b.height < 2) continue;
    const img = await v.webContents.capturePage(); const s = img.getSize(); if (!s.width) continue;
    parts.push({ b, s, bmp: img.toBitmap() });
    if (!out) { ratio = Math.max(1, Math.round(s.width / b.width)); out = Buffer.alloc(W * ratio * H * ratio * 4, 255); }
  }
  const OW = W * ratio;
  for (const { b, s, bmp } of parts) {
    const w = b.width * ratio; const h = b.height * ratio; const x0 = b.x * ratio; const y0 = b.y * ratio;
    for (let y = 0; y < h; y++) {
      const sy = Math.min(s.height - 1, Math.floor(y * s.height / h)); const oy = y0 + y; if (oy < 0 || oy >= H * ratio) continue;
      for (let x = 0; x < w; x++) {
        const ox = x0 + x; if (ox < 0 || ox >= OW) continue;
        const si = (sy * s.width + Math.min(s.width - 1, Math.floor(x * s.width / w))) * 4; const di = (oy * OW + ox) * 4; const a = bmp[si + 3];
        if (a === 255) { out[di] = bmp[si]; out[di + 1] = bmp[si + 1]; out[di + 2] = bmp[si + 2]; out[di + 3] = 255; }
        else if (a) { const k = 255 - a; for (let c = 0; c < 3; c++) out[di + c] = Math.min(255, bmp[si + c] + Math.round(out[di + c] * k / 255)); } // premultiplied
      }
    }
  }
  const png = nativeImage.createFromBitmap(out, { width: OW, height: H * ratio }).toPNG();
  fs.writeFileSync(file, png);
  return { file: path.basename(file), width: OW, height: H * ratio, bytes: png.length };
}

module.exports = async ({ app, browser, browsing, downloads, settings, getWindow, chromeView, overlayView, setPanel }) => {
  const result = { shots: [] };
  let server;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const MB = 1024 * 1024;
    const rnd = (n) => crypto.randomBytes(n);
    const files = {
      'holiday-photos.zip': { bytes: rnd(100 * MB), kbps: 900 },
      'podcast-episode-12.mp3': { bytes: rnd(90 * MB), kbps: 400 },
      'annual-report.pdf': { bytes: rnd(3 * MB) },
      'conference-talk.mp4': { bytes: rnd(40 * MB) },
      'photo-0042.jpg': { bytes: rnd(2 * MB) },
      'notes.txt': { bytes: rnd(40 * 1024) },
    };
    const srv = await startServer(files); server = srv.server; const base = srv.base;
    const win = getWindow();
    const ui = (code) => chromeView.webContents.executeJavaScript(code);
    const hideBadge = () => ui("document.getElementById('menu-badge').classList.add('hidden')"); // this profile has no add-ons installed; not something to show
    if (win.isMaximized()) win.unmaximize();
    if (win.isFullScreen()) win.setFullScreen(false);
    win.setContentSize(1280, 800); win.center();
    const dlDir = path.join(app.getPath('userData'), 'demo-downloads');
    settings.set({ theme: 'light', accent: '#5b7cfa', downloadDir: dlDir, categoryFolders: true, maxActive: 4, connections: 8, notifyOnComplete: false });

    // Tabs: the journal, the docs, a group "Reading" with two tabs, and a last one.
    const old = browser.order.slice();
    const mk = (p) => browser.createTab({ url: base + p, win: 'normal', background: true });
    const [journal, docs, recipes, maps, brief] = ['/', '/docs', '/recipes', '/maps', '/brief'].map(mk);
    for (const id of old) browser.closeTab(id);
    const g = browser.addToGroup(recipes); browser.updateGroup(g, { title: 'Reading', color: 'green' }); browser.addToGroup(maps, g);
    await until(() => [journal, docs, recipes, maps, brief].every((id) => { const t = browser.tabs.get(id); return t && t.title && !/^(New tab|Loading)/i.test(t.title) && !t.loading; }));

    // Bookmarks bar: a few links and a folder.
    const bm = browsing.bookmarks;
    for (const [t, p] of [['Nova Lake', '/'], ['Docs', '/docs'], ['Recipes', '/recipes'], ['Trail Maps', '/maps']]) bm.add({ url: base + p, title: t, parent: 'bar' });
    const folder = bm.addFolder('Reading list', 'bar');
    bm.add({ url: base + '/brief', title: 'Daily Brief', parent: folder.id });
    bm.add({ url: base + '/maps?saved', title: 'Trail Maps', parent: folder.id });
    bm.addFolder('Projects', 'other');
    browser.selectTab(journal);
    await sleep(1500);
    await hideBadge();
    result.shots.push(await shootWindow(win, path.join(OUT_DIR, 'browser.png')));

    // Video detection: a page that asks for a playlist; the toolbar's video button lists what was found.
    const watch = browser.createTab({ url: base + '/watch', win: 'normal', background: false }); browser.selectTab(watch);
    await until(async () => ui("!document.getElementById('media-badge').classList.contains('hidden')"), 15000);
    await sleep(500); await ui("document.getElementById('media-btn').click()"); await sleep(1800); await hideBadge();
    result.shots.push(await shootWindow(win, path.join(OUT_DIR, 'video.png')));
    setPanel(false); await sleep(300); browser.closeTab(watch); browser.selectTab(journal);

    // Downloads: some finished, two still running.
    for (const n of ['annual-report.pdf', 'conference-talk.mp4', 'photo-0042.jpg', 'notes.txt']) downloads.add({ kind: 'http', url: `${base}/files/${n}`, name: n, pageUrl: base + '/' });
    await until(() => downloads.list().filter((d) => d.state === 'done').length >= 4, 30000);
    for (const n of ['holiday-photos.zip', 'podcast-episode-12.mp3']) downloads.add({ kind: 'http', url: `${base}/files/${n}`, name: n, pageUrl: base + '/' });
    await sleep(4500);
    const page = (url) => { const id = browser.createTab({ url, win: 'normal', background: false }); browser.selectTab(id); return id; };
    const dl = page('novadm://downloads'); await sleep(2500);
    result.shots.push(await shootWindow(win, path.join(OUT_DIR, 'downloads.png')));

    await hideBadge();
    browser.closeTab(dl); const b = page('novadm://bookmarks'); await sleep(2000); await hideBadge();
    result.shots.push(await shootWindow(win, path.join(OUT_DIR, 'bookmarks.png')));

    browser.closeTab(b); const st = page('novadm://settings'); await sleep(2000); await hideBadge();
    await browser.tabs.get(st).wc.executeJavaScript("[...document.querySelectorAll('h2')].find((h) => h.textContent.trim() === 'Privacy and security').scrollIntoView()"); await sleep(700);
    result.shots.push(await shootWindow(win, path.join(OUT_DIR, 'settings.png')));

    browser.closeTab(st); browser.selectTab(journal); await sleep(800);
    win.setContentSize(1280, 900); await sleep(800); // the menu is taller than the other screens
    await ui("document.getElementById('menu-btn').click()"); await sleep(1500); await hideBadge();
    await overlayView.webContents.executeJavaScript("document.querySelectorAll('.addon-warn').forEach((e) => { e.style.display = 'none'; })"); // this profile has no add-ons installed; not something to show
    await sleep(400);
    result.shots.push(await shootWindow(win, path.join(OUT_DIR, 'menu.png')));
    setPanel(false);

    for (const d of downloads.list()) { try { await downloads.cancel(d.id, true); } catch {} }
    result.ok = result.shots.length === 6;
  } catch (e) { result.error = String((e && e.stack) || e); }
  try { if (server) server.close(); } catch {}
  fs.writeFileSync(RESULT, JSON.stringify(result, null, 2));
  app.exit(0);
};
