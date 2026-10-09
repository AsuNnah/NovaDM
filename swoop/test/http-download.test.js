'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HttpDownload } = require('../src/main/download/http');

// Adapter mimicking net.open() on top of Node's http client, for tests.
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

function makeServer(body, { ranges = true, dropFirst = 0, throttleMs = 0 } = {}) {
  let drops = dropFirst;
  const send = (res, slice) => {
    if (!throttleMs) return res.end(slice);
    let off = 0;
    const tick = () => {
      if (res.writableEnded) return;
      const n = Math.min(32 * 1024, slice.length - off);
      res.write(slice.subarray(off, off + n)); off += n;
      if (off >= slice.length) res.end(); else setTimeout(tick, throttleMs);
    };
    tick();
  };
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    if (ranges && range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = Number(m[1]);
      const end = m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes', 'Content-Type': 'video/mp4',
      });
      const slice = body.subarray(start, end + 1);
      if (drops-- > 0) { res.write(slice.subarray(0, Math.floor(slice.length / 2))); return res.destroy(); }
      send(res, slice);
    } else {
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': 'video/mp4', 'Accept-Ranges': ranges ? 'bytes' : 'none' });
      send(res, body);
    }
  });
  return server;
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swoop-dl-')), 'out.mp4');

test('multi-part download reassembles the file correctly', async () => {
  const body = crypto.randomBytes(5 * 1024 * 1024);
  const server = makeServer(body);
  const base = await listen(server);
  const save = tmp();
  const dl = new HttpDownload({ id: 'a', savePath: save, url: base + '/f.mp4', connections: 8, openConn: nodeOpen, retryDelayMs: 50 });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  assert.ok(fs.existsSync(save));
  assert.equal(fs.statSync(save).size, body.length);
  assert.ok(crypto.timingSafeEqual(fs.readFileSync(save), body));
  server.close();
});

test('recovers from dropped connections via retry', async () => {
  const body = crypto.randomBytes(2 * 1024 * 1024);
  const server = makeServer(body, { dropFirst: 3 });
  const base = await listen(server);
  const save = tmp();
  const dl = new HttpDownload({ id: 'b', savePath: save, url: base + '/f.mp4', connections: 4, openConn: nodeOpen, retryDelayMs: 20 });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  assert.ok(crypto.timingSafeEqual(fs.readFileSync(save), body));
  server.close();
});

test('non-resumable server falls back to a single stream', async () => {
  const body = crypto.randomBytes(1024 * 1024);
  const server = makeServer(body, { ranges: false });
  const base = await listen(server);
  const save = tmp();
  const dl = new HttpDownload({ id: 'c', savePath: save, url: base + '/f.mp4', connections: 8, openConn: nodeOpen, retryDelayMs: 20 });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  assert.equal(fs.statSync(save).size, body.length);
  assert.ok(crypto.timingSafeEqual(fs.readFileSync(save), body));
  server.close();
});

test('pause then resume continues from the saved parts', async () => {
  const body = crypto.randomBytes(4 * 1024 * 1024);
  const server = makeServer(body, { throttleMs: 15 });
  const base = await listen(server);
  const save = tmp();
  const dl = new HttpDownload({ id: 'd', savePath: save, url: base + '/f.mp4', connections: 4, openConn: nodeOpen, retryDelayMs: 20 });
  dl.start();
  await new Promise((r) => {
    dl.on('progress', (p) => { if (p.received > body.length * 0.2 && dl.state === 'downloading') { dl.pause(); r(); } });
  });
  assert.equal(dl.state, 'paused');
  assert.ok(fs.existsSync(save + '.part.meta'));
  const received1 = dl.received;
  const dl2 = new HttpDownload({ id: 'd', savePath: save, url: base + '/f.mp4', connections: 4, openConn: nodeOpen, retryDelayMs: 20 });
  await new Promise((res, rej) => { dl2.on('done', res); dl2.on('error', rej); dl2.start(); });
  assert.ok(dl2.received >= received1 || fs.statSync(save).size === body.length);
  assert.ok(crypto.timingSafeEqual(fs.readFileSync(save), body));
  server.close();
});

test('cancel removes the partial file', async () => {
  const body = crypto.randomBytes(4 * 1024 * 1024);
  const server = makeServer(body, { throttleMs: 15 });
  const base = await listen(server);
  const save = tmp();
  const dl = new HttpDownload({ id: 'e', savePath: save, url: base + '/f.mp4', connections: 2, openConn: nodeOpen });
  let done = false;
  dl.on('done', () => { done = true; });
  dl.start();
  await new Promise((r) => dl.on('progress', (p) => { if (p.received > 0 && dl.state === 'downloading') r(); }));
  assert.equal(done, false);
  dl.cancel();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!fs.existsSync(save + '.part'));
  assert.ok(!fs.existsSync(save));
  server.close();
});
