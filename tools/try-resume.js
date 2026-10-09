'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HttpDownload } = require('../src/main/download/http');

function nodeOpen(url, { headers = {}, range, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (range) h.range = range;
    const req = http.get(url, { headers: h }, (res) => {
      resolve({ req, res, finalUrl: url, status: res.statusCode, headers: res.headers, abort: () => req.destroy() });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  const body = crypto.randomBytes(4 * 1024 * 1024);
  // Throttled server so the download doesn't finish instantly.
  const server = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : body.length - 1;
    res.writeHead(m ? 206 : 200, { 'Content-Range': m ? `bytes ${start}-${end}/${body.length}` : undefined, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' });
    const slice = body.subarray(start, end + 1);
    let off = 0;
    const tick = () => {
      if (res.writableEnded) return;
      const n = Math.min(32 * 1024, slice.length - off);
      res.write(slice.subarray(off, off + n)); off += n;
      if (off >= slice.length) res.end(); else setTimeout(tick, 15);
    };
    tick();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const save = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-res-')), 'out.mp4');
  const hard = setTimeout(() => { console.log('HANG phase1'); process.exit(2); }, 15000);

  const dl = new HttpDownload({ id: 'd', savePath: save, url: base + '/f.mp4', connections: 4, openConn: nodeOpen, retryDelayMs: 20 });
  await new Promise((r) => {
    dl.on('progress', (p) => { if (p.received > body.length * 0.2 && dl.state === 'downloading') { dl.pause(); r(); } });
    dl.start();
  });
  clearTimeout(hard);
  console.log('paused at', dl.received, 'state', dl.state, 'meta?', fs.existsSync(save + '.part.meta'));

  const hard2 = setTimeout(() => {
    console.log('HANG phase2 state=', dl2.state, 'recv=', dl2.received, 'size=', dl2.size, 'segs=', dl2.segments.map((s) => `${s.pos}/${s.end}`).join(','));
    process.exit(3);
  }, 15000);
  const dl2 = new HttpDownload({ id: 'd', savePath: save, url: base + '/f.mp4', connections: 4, openConn: nodeOpen, retryDelayMs: 20 });
  dl2.on('error', (e) => { clearTimeout(hard2); console.log('dl2 ERROR', e.message); process.exit(4); });
  await new Promise((res) => { dl2.on('done', res); dl2.start(); });
  clearTimeout(hard2);
  const ok = crypto.timingSafeEqual(fs.readFileSync(save), body);
  console.log('resumed DONE ok=', ok, 'size=', fs.statSync(save).size);
  server.close(); process.exit(ok ? 0 : 5);
})();
