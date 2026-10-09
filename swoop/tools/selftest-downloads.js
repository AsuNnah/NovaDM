'use strict';
// In-app self-test: Downloads page, Properties + checksum, and HLS pause/resume via the manager.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'swoop-selftest-downloads.json');
const SEGS = 30;
const SEG_BYTES = 64 * 1024;

function startServer(counts) {
  const big = crypto.randomBytes(6 * 1024 * 1024);
  const small = crypto.randomBytes(300 * 1024);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url;
      counts[u] = (counts[u] || 0) + 1;
      if (u === '/files/photo.jpg') { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': small.length }); return res.end(small); }
      if (u === '/files/slow.zip') {
        // Slow server so this one is still running when the screenshot is taken.
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        const s = m ? Number(m[1]) : 0; const e = m && m[2] ? Number(m[2]) : big.length - 1;
        res.writeHead(m ? 206 : 200, { 'Content-Type': 'application/zip', 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${s}-${e}/${big.length}` } : {}) });
        let off = s;
        const tick = () => { if (res.destroyed || off > e) return res.end(); const n = Math.min(8 * 1024, e - off + 1); res.write(big.subarray(off, off + n)); off += n; setTimeout(tick, 60); };
        return tick();
      }
      if (u === '/hls/index.m3u8') {
        let p = '#EXTM3U\n#EXT-X-TARGETDURATION:4\n';
        for (let i = 0; i < SEGS; i++) p += `#EXTINF:4,\nseg${i}.bin\n`;
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(p + '#EXT-X-ENDLIST\n');
      }
      const m = /^\/hls\/seg(\d+)\.bin$/.exec(u);
      if (m) {
        const body = Buffer.alloc(SEG_BYTES, Number(m[1]));
        return setTimeout(() => { res.writeHead(200, { 'Content-Length': body.length }); res.end(body); }, 120);
      }
      res.writeHead(404); res.end('missing');
    });
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

module.exports = async ({ app, browser, downloads, settings }) => {
  const result = {};
  const counts = {};
  try {
    const base = await startServer(counts);
    const dlDir = path.join(app.getPath('userData'), 'dl2');
    fs.rmSync(dlDir, { recursive: true, force: true });
    for (const d of downloads.list()) await downloads.cancel(d.id, true);
    settings.set({ downloadDir: dlDir, maxActive: 4, connections: 4 });

    const photo = downloads.add({ kind: 'http', url: base + '/files/photo.jpg', pageUrl: base + '/gallery.html' });
    const stream = downloads.add({
      kind: 'hls', name: 'Test stream [720p].mp4', playlistUrl: base + '/hls/index.m3u8', pageUrl: base + '/watch',
      convertTs: false, category: 'video', meta: { duration: SEGS * 4, width: 1280, height: 720 },
    });
    downloads.add({ kind: 'http', url: base + '/files/missing.pdf', pageUrl: base + '/docs' });
    downloads.add({ kind: 'http', url: base + '/files/slow.zip', pageUrl: base + '/files' });

    // Pause the stream part-way.
    const t0 = Date.now();
    while (Date.now() - t0 < 20000 && !((downloads.get(stream.id).doneSegments || 0) >= 8)) await sleep(100);
    downloads.pause(stream.id);
    await (downloads.get(stream.id)._pausing || Promise.resolve());
    const atPause = downloads.get(stream.id);
    result.pause = { state: atPause.state, doneSegments: atPause.doneSegments, metaSaved: fs.existsSync(atPause.savePath + '.part.meta') };
    while (Date.now() - t0 < 20000 && downloads.get(photo.id).state !== 'done') await sleep(100);

    // Downloads page.
    browser.openInternal('downloads');
    const tab = browser.activeTab();
    await new Promise((r) => (tab.wc.isLoading() ? tab.wc.once('did-finish-load', r) : r()));
    await sleep(1500);
    fs.writeFileSync(path.join(os.tmpdir(), 'swoop-dlpage.png'), (await tab.wc.capturePage()).toPNG());
    result.page = await tab.wc.executeJavaScript(`({ rows: document.querySelectorAll('.row').length, tabs: [...document.querySelectorAll('#tabs .tab')].map(b => b.textContent), statuses: [...document.querySelectorAll('.row .status')].map(s => s.textContent) })`);

    // Properties of the finished photo, with MD5.
    await tab.wc.executeJavaScript(`showProperties(${JSON.stringify(photo.id)})`);
    await sleep(500);
    await tab.wc.executeJavaScript(`document.getElementById('c-md5').click()`);
    await sleep(1200);
    fs.writeFileSync(path.join(os.tmpdir(), 'swoop-dlprops.png'), (await tab.wc.capturePage()).toPNG());
    const shownMd5 = await tab.wc.executeJavaScript(`document.getElementById('h-md5').textContent`);
    const realMd5 = crypto.createHash('md5').update(fs.readFileSync(downloads.get(photo.id).savePath)).digest('hex');
    result.checksum = { shown: shownMd5, real: realMd5, match: shownMd5 === realMd5 };
    await tab.wc.executeJavaScript(`closeLayer()`);

    // Resume the stream; it must continue, not start over.
    for (const k of Object.keys(counts)) delete counts[k];
    downloads.resume(stream.id);
    const t1 = Date.now();
    while (Date.now() - t1 < 30000 && downloads.get(stream.id).state !== 'done') await sleep(150);
    const fin = downloads.get(stream.id);
    const buf = fs.existsSync(fin.savePath) ? fs.readFileSync(fin.savePath) : Buffer.alloc(0);
    let ordered = buf.length === SEGS * SEG_BYTES;
    for (let i = 0; ordered && i < SEGS; i++) if (buf[i * SEG_BYTES] !== i) ordered = false;
    const refetched = Object.keys(counts).filter((u) => { const m = /seg(\d+)\.bin/.exec(u); return m && Number(m[1]) < result.pause.doneSegments; });
    result.resume = { state: fin.state, bytes: buf.length, ordered, refetchedEarlierSegments: refetched.length };
    const props = downloads.properties(stream.id);
    result.streamProps = { resumable: props.resumable, activeMs: props.activeMs, avgSpeed: props.avgSpeed, meta: props.meta, segments: props.segments };
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
