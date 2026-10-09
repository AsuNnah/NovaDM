'use strict';
// In-app self-test for download engine v2 + the direct transport, through the real download manager:
//  - "Automatic" opens more than Chromium's 6 connections to an HTTP/1.1 server (direct transport),
//    "Browser only" stays at 6 or fewer
//  - the browser's cookies and the page Referer reach the server on every connection
//  - hosts resolve through the browser session (Secure DNS), and HTTPS works with Windows' certificates
// Run with a throwaway profile: NOVADM_USERDATA=<temp dir> NOVADM_SELFTEST=tools/selftest-transport.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-transport.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(body, stats) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url !== '/big.bin') { res.writeHead(404); return res.end(); }
      stats.requests++;
      if (req.headers.cookie) stats.cookies.add(req.headers.cookie);
      stats.referers.add(req.headers.referer || '(none)');
      stats.active++; stats.peak = Math.max(stats.peak, stats.active);
      res.on('close', () => { stats.active--; });
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const s = m ? Number(m[1]) : 0;
      const e = m && m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(m ? 206 : 200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', ETag: '"t1"',
        ...(m ? { 'Content-Range': `bytes ${s}-${e}/${body.length}` } : {}),
      });
      // About 1 MB/s per connection, so more connections really are faster.
      let off = s;
      const tick = () => {
        if (res.destroyed) return;
        if (off > e) return res.end();
        const n = Math.min(32 * 1024, e - off + 1);
        res.write(body.subarray(off, off + n)); off += n;
        setTimeout(tick, 20);
      };
      tick();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function runOne(downloads, settings, url, page, mode, stats) {
  settings.set({ downloadTransport: mode });
  stats.active = 0; stats.peak = 0; stats.requests = 0; stats.cookies = new Set(); stats.referers = new Set();
  const rec = downloads.add({ kind: 'http', url, name: `big-${mode}.bin`, headers: { referer: page }, pageUrl: page });
  let maxConns = 0; let maxDirect = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const r = downloads.get(rec.id);
    maxConns = Math.max(maxConns, r.connections || 0);
    maxDirect = Math.max(maxDirect, r.directConnections || 0);
    if (r.state === 'done' || r.state === 'error') break;
    await sleep(100);
  }
  const r = downloads.get(rec.id);
  return {
    mode, state: r.state, error: r.error, seconds: (Date.now() - t0) / 1000, savePath: r.savePath,
    serverPeak: stats.peak, requests: stats.requests, engineMaxConnections: maxConns, engineMaxDirect: maxDirect,
    cookies: [...stats.cookies], referers: [...stats.referers],
  };
}

module.exports = async ({ app, browser, downloads, settings }) => {
  const result = {};
  try {
    const body = crypto.randomBytes(40 * 1024 * 1024);
    const hash = crypto.createHash('sha256').update(body).digest('hex');
    const stats = {};
    const { server, port } = await startServer(body, stats);
    const dlDir = path.join(app.getPath('userData'), 'dl-transport');
    fs.rmSync(dlDir, { recursive: true, force: true });
    settings.set({ downloadDir: dlDir, categoryFolders: false, connections: 16, maxActive: 1 });
    // "localhost" so the direct transport has to resolve a name through the session.
    const base = `http://localhost:${port}`;
    await browser.normalSession.cookies.set({ url: base, name: 'sid', value: 'nova123' });
    const page = base + '/watch/page.html';

    for (const mode of ['auto', 'browser']) {
      const r = await runOne(downloads, settings, base + '/big.bin', page, mode, stats);
      try {
        r.sha256ok = crypto.createHash('sha256').update(fs.readFileSync(r.savePath)).digest('hex') === hash;
      } catch (e) { r.sha256ok = false; r.readError = e.message; }
      result[mode] = r;
    }

    // Secure DNS lookups from the session (what the direct transport uses) and TLS with the
    // Windows certificate store against a public endpoint (tiny, no download).
    const ses = browser.normalSession;
    try {
      const rh = await ses.resolveHost('www.gstatic.com');
      result.resolveHost = (rh.endpoints || []).map((x) => x.address).slice(0, 3);
    } catch (e) { result.resolveHost = 'error: ' + e.message; }
    try {
      const conn = await downloads.transport.directOpen('https://www.gstatic.com/generate_204', { session: ses, timeoutMs: 15000 });
      result.directTls = { status: conn.status, transport: conn.transport };
      conn.abort();
    } catch (e) { result.directTls = 'error: ' + (e.code || '') + ' ' + e.message; }
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.quit();
};
