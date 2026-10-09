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
  const body = crypto.randomBytes(5 * 1024 * 1024);
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]); const end = m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4' });
      res.end(body.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
      res.end(body);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const save = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-try-')), 'out.mp4');
  const dl = new HttpDownload({ id: 'a', savePath: save, url: base + '/f.mp4', connections: 8, openConn: nodeOpen, retryDelayMs: 50 });
  const hardTimer = setTimeout(() => {
    console.log('HANG. state=', dl.state, 'received=', dl.received, 'size=', dl.size,
      'active=', [...dl.active.keys()], 'segs=', dl.segments.map((s) => `${s.pos}/${s.end}`).join(','));
    process.exit(2);
  }, 12000);
  dl.on('progress', (p) => { if (p.received % (1024 * 1024) < 70000) console.log('progress', p.state, Math.round(p.percent) + '%', 'conns', p.connections); });
  dl.on('done', () => {
    clearTimeout(hardTimer);
    const ok = crypto.timingSafeEqual(fs.readFileSync(save), body);
    console.log('DONE ok=', ok, 'size=', fs.statSync(save).size);
    server.close(); process.exit(ok ? 0 : 3);
  });
  dl.on('error', (e) => { clearTimeout(hardTimer); console.log('ERROR', e.message); process.exit(4); });
  dl.start();
})();
