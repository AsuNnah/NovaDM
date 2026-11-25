'use strict';
// In-app self-test (AU-30): a file stored with Content-Encoding: gzip (as S3 or a CDN may serve a .tar.gz), split over
// several connections, through both transports. The saved file must be whole: the stored (gzip) bytes or the decoded
// bytes, never a mix or a cut-off file. (Browser-only mode can't fetch such a file by range; it ends in an error.)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = path.join(os.tmpdir(), 'novadm-selftest-gzip.json');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

module.exports = async ({ app, downloads, settings }) => {
  const result = {};
  // Half random, half repeating, so gzip changes the length a lot but not to almost nothing.
  const raw = Buffer.concat([crypto.randomBytes(3 * 1024 * 1024), Buffer.alloc(3 * 1024 * 1024, 'novadm ')]);
  const gz = zlib.gzipSync(raw);
  const requests = [];
  try {
    const server = http.createServer((req, res) => {
      requests.push({ range: req.headers.range || '', ae: req.headers['accept-encoding'] || '' });
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const s = m ? Number(m[1]) : 0; const e = m && m[2] ? Math.min(Number(m[2]), gz.length - 1) : gz.length - 1;
      res.writeHead(m ? 206 : 200, {
        'Content-Type': 'application/x-tar', 'Content-Encoding': 'gzip', 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1,
        'Content-Disposition': 'attachment; filename="pack.tar"', ...(m ? { 'Content-Range': `bytes ${s}-${e}/${gz.length}` } : {}),
      });
      let off = s; // slowly, so the download is split over several connections
      const tick = () => { if (res.destroyed || off > e) return res.end(); const n = Math.min(64 * 1024, e - off + 1); res.write(gz.subarray(off, off + n)); off += n; setTimeout(tick, 15); };
      tick();
    });
    const base = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
    const dlDir = path.join(app.getPath('userData'), 'dl-gzip');
    fs.rmSync(dlDir, { recursive: true, force: true });
    for (const transport of ['auto', 'direct']) {
      requests.length = 0;
      settings.set({ downloadDir: path.join(dlDir, transport), connections: 4, downloadTransport: transport });
      const rec = downloads.add({ kind: 'http', url: `${base}/${transport}/pack.tar`, pageUrl: base + '/' });
      const t0 = Date.now();
      while (Date.now() - t0 < 60000 && !['done', 'error'].includes(downloads.get(rec.id).state)) await sleep(150);
      const fin = downloads.get(rec.id);
      const buf = fin.state === 'done' && fs.existsSync(fin.savePath) ? fs.readFileSync(fin.savePath) : Buffer.alloc(0);
      result[transport] = {
        state: fin.state, error: fin.error || '', bytes: buf.length, gzBytes: gz.length, rawBytes: raw.length,
        whole: sha(buf) === sha(gz) ? 'stored gzip bytes' : sha(buf) === sha(raw) ? 'decoded bytes' : 'BROKEN',
        requests: requests.length, ranged: requests.filter((q) => q.range).length, acceptEncoding: [...new Set(requests.map((q) => q.ae))],
      };
    }
    server.close();
  } catch (e) {
    result.error = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
