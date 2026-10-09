'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HttpDownload } = require('../src/main/download/http');

// Adapter mimicking net.open() on top of Node's http client (keep-alive off: one TCP per request).
function nodeOpen(url, { headers = {}, range, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (range) h.range = range;
    const req = http.get(url, { headers: h, agent: false }, (res) => {
      resolve({ req, res, finalUrl: url, status: res.statusCode, headers: res.headers, abort: () => req.destroy() });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

/**
 * Test server.
 * opts: ranges, throttleMs (per 32 KB), dropFirst (range responses cut in half), maxConcurrent (403 above),
 *       tooMany (first N extra requests get 429 + Retry-After), etag, expireAfter (410 after N requests)
 */
function makeServer(state, opts = {}) {
  const { ranges = true, throttleMs = 0, maxConcurrent = Infinity, retryAfter = 1 } = opts;
  let drops = opts.dropFirst || 0;
  let tooMany = opts.tooMany || 0;
  state.active = 0; state.peak = 0; state.requests = 0; state.bytes = 0;
  const send = (res, slice) => {
    let off = 0;
    const tick = () => {
      if (res.destroyed) return;
      if (off >= slice.length) return res.end();
      const n = Math.min(32 * 1024, slice.length - off);
      state.bytes += n;
      const ok = res.write(slice.subarray(off, off + n)); off += n;
      if (throttleMs) setTimeout(tick, throttleMs); else if (ok) setImmediate(tick); else res.once('drain', tick);
    };
    tick();
  };
  return http.createServer((req, res) => {
    state.requests++;
    if (opts.expireAfter && state.requests > opts.expireAfter) { res.writeHead(410); return res.end('gone'); }
    if (state.active >= maxConcurrent) { res.writeHead(403); return res.end('too many connections'); }
    if (tooMany > 0 && state.requests > 1) { tooMany--; res.writeHead(429, { 'Retry-After': String(retryAfter) }); return res.end(); }
    state.active++; state.peak = Math.max(state.peak, state.active);
    res.on('close', () => { state.active--; });
    const body = state.body;
    const etag = state.etag || '"v1"';
    const range = req.headers.range;
    const ifRange = req.headers['if-range'];
    if (ranges && range && (!ifRange || ifRange === etag)) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]); const end = m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4', ETag: etag });
      const slice = body.subarray(start, end + 1);
      if (drops-- > 0 && start > 0) { res.write(slice.subarray(0, Math.floor(slice.length / 2))); return setTimeout(() => res.destroy(), 20); }
      return send(res, slice);
    }
    res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'video/mp4', 'Accept-Ranges': ranges ? 'bytes' : 'none', ETag: etag });
    send(res, body);
  });
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-dl-')), 'out.mp4');
const run = (dl) => new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
const same = (file, body) => fs.existsSync(file) && fs.statSync(file).size === body.length && crypto.timingSafeEqual(fs.readFileSync(file), body);
const base = (o) => ({ id: 'x', openConn: nodeOpen, retryDelayMs: 30, minSplitBytes: 128 * 1024, ...o });

test('downloads and reassembles the file correctly', async (t) => {
  const st = { body: crypto.randomBytes(5 * 1024 * 1024) };
  const server = makeServer(st); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  await run(new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 8 })));
  assert.ok(same(save, st.body));
});

test('slow start opens more connections over time and parts are re-split', async (t) => {
  const st = { body: crypto.randomBytes(12 * 1024 * 1024) };
  const server = makeServer(st, { throttleMs: 10 }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  const dl = new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 8 }));
  await run(dl);
  assert.ok(same(save, st.body));
  assert.ok(st.peak >= 4, 'expected several parallel connections, peak was ' + st.peak);
  assert.ok(dl.segments.length >= 4, 'work was split: ' + dl.segments.length + ' parts');
});

test('recovers from dropped connections', async (t) => {
  const st = { body: crypto.randomBytes(3 * 1024 * 1024) };
  const server = makeServer(st, { dropFirst: 3, throttleMs: 2 }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  await run(new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 4 })));
  assert.ok(same(save, st.body));
});

test('server without ranges falls back to one connection', async (t) => {
  const st = { body: crypto.randomBytes(1024 * 1024) };
  const server = makeServer(st, { ranges: false }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  const dl = new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 8 }));
  await run(dl);
  assert.ok(same(save, st.body));
  assert.equal(dl.resumable, false);
  assert.equal(st.requests, 1, 'the first response was used, no probe');
});

test('pause keeps progress and a new engine resumes without re-downloading', async (t) => {
  const st = { body: crypto.randomBytes(4 * 1024 * 1024) };
  const server = makeServer(st, { throttleMs: 10 }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  const dl = new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 4 }));
  dl.start();
  await new Promise((r) => dl.on('progress', (p) => { if (p.received > st.body.length * 0.4 && dl.state === 'downloading') r(); }));
  await dl.pause();
  assert.equal(dl.state, 'paused');
  assert.ok(fs.existsSync(save + '.part.meta'));
  const doneAtPause = dl.segments.reduce((s, x) => s + x.done, 0);
  st.bytes = 0;
  await run(new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 4 })));
  assert.ok(same(save, st.body));
  assert.ok(st.bytes <= st.body.length - doneAtPause + 512 * 1024, `resume re-downloaded too much: ${st.bytes} bytes`);
});

test('cancel removes the partial file', async (t) => {
  const st = { body: crypto.randomBytes(4 * 1024 * 1024) };
  const server = makeServer(st, { throttleMs: 15 }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  const dl = new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 2 }));
  dl.start();
  await new Promise((r) => dl.on('progress', (p) => { if (p.received > 0 && dl.state === 'downloading') r(); }));
  await dl.cancel();
  assert.ok(!fs.existsSync(save + '.part'));
  assert.ok(!fs.existsSync(save + '.part.meta'));
  assert.ok(!fs.existsSync(save));
});

test('a server connection limit (403 on extra connections) is respected and the download finishes', async (t) => {
  const st = { body: crypto.randomBytes(4 * 1024 * 1024) };
  const server = makeServer(st, { maxConcurrent: 2, throttleMs: 5 }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  const dl = new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 8 }));
  await run(dl);
  assert.ok(same(save, st.body));
  assert.ok(st.peak <= 2);
});

test('429 Too Many Requests backs off and still completes', async (t) => {
  const st = { body: crypto.randomBytes(2 * 1024 * 1024) };
  const server = makeServer(st, { tooMany: 3, retryAfter: 1, throttleMs: 3 }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  await run(new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 4 })));
  assert.ok(same(save, st.body));
});

test('if the file changed on the server, resume starts over instead of mixing versions', async (t) => {
  const st = { body: crypto.randomBytes(3 * 1024 * 1024), etag: '"v1"' };
  const server = makeServer(st, { throttleMs: 10 }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  const dl = new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 3 }));
  dl.start();
  await new Promise((r) => dl.on('progress', (p) => { if (p.received > st.body.length * 0.3 && dl.state === 'downloading') r(); }));
  await dl.pause();
  st.body = crypto.randomBytes(3 * 1024 * 1024); // new version, new ETag
  st.etag = '"v2"';
  await run(new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 3 })));
  assert.ok(same(save, st.body), 'file must be entirely the new version');
});

test('after a crash, resume continues from the last checkpoint', async (t) => {
  const st = { body: crypto.randomBytes(4 * 1024 * 1024) };
  const server = makeServer(st, { throttleMs: 10 }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  const dl = new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 3, checkpointMs: 300 }));
  dl.start();
  await new Promise((r) => dl.on('progress', (p) => { if (p.received > st.body.length * 0.5 && dl.state === 'downloading') r(); }));
  await new Promise((r) => setTimeout(r, 400)); // let at least one checkpoint happen
  // Simulated crash: stop everything without writing caches or saving progress.
  dl._stopping = true;
  for (const c of dl.conns) if (c.abort) c.abort();
  clearInterval(dl._tick);
  dl.closeFd();
  const meta = JSON.parse(fs.readFileSync(save + '.part.meta', 'utf8'));
  const saved = meta.segments.reduce((s, x) => s + x.done, 0);
  assert.ok(saved > 0, 'checkpoint recorded progress');
  st.bytes = 0;
  await run(new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 3 })));
  assert.ok(same(save, st.body));
  assert.ok(st.bytes <= st.body.length - saved + 512 * 1024, `crash resume re-downloaded too much: ${st.bytes}`);
});

test('an expired link is reported as LINK_EXPIRED', async (t) => {
  const st = { body: crypto.randomBytes(3 * 1024 * 1024) };
  const server = makeServer(st, { throttleMs: 10 }); t.after(() => server.close()); const url = await listen(server);
  const save = tmp();
  const dl = new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 2, retries: 2 }));
  dl.start();
  await new Promise((r) => dl.on('progress', (p) => { if (p.received > 300 * 1024 && dl.state === 'downloading') r(); }));
  await dl.pause();
  // The link now answers 410 Gone for everything.
  server.close();
  const st2 = { body: st.body };
  const server2 = makeServer(st2, { expireAfter: 0.5 }); t.after(() => server2.close());
  await new Promise((r) => server2.listen(new URL(url).port, '127.0.0.1', r));
  const dl2 = new HttpDownload(base({ savePath: save, url: url + '/f.mp4', connections: 2, retries: 2 }));
  const err = await new Promise((r) => { dl2.on('done', () => r(null)); dl2.on('error', r); dl2.start(); });
  assert.ok(err, 'should fail');
  assert.equal(err.code, 'LINK_EXPIRED');
});
