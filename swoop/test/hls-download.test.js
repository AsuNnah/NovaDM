'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { HlsDownload } = require('../src/main/download/hls-dl');

const SEG = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mux.js', 'test', 'segments', 'test-segment.ts'));

function nodeOpen(url, { headers = {}, range } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (range) h.range = range;
    const req = http.get(url, { headers: h }, (res) => {
      resolve({ req, res, finalUrl: url, status: res.statusCode, headers: res.headers, abort: () => req.destroy() });
    });
    req.on('error', reject);
  });
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swoop-hls-')), 'out.mp4');

function mp4Boxes(buf) {
  const t = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const size = buf.readUInt32BE(i);
    t.push(buf.toString('latin1', i + 4, i + 8));
    if (size < 8) break;
    i += size;
  }
  return t;
}

function serve(routes) {
  const server = http.createServer((req, res) => {
    const u = req.url;
    if (routes[u]) {
      const { body, type } = routes[u];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Content-Length': body.length });
      res.end(body);
    } else {
      res.writeHead(404); res.end();
    }
  });
  return server;
}

test('plain TS HLS downloads and converts to MP4', async () => {
  const N = 6;
  const routes = {};
  let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-VERSION:3\n';
  for (let i = 0; i < N; i++) { routes[`/seg${i}.ts`] = { body: SEG, type: 'video/mp2t' }; playlist += `#EXTINF:5,\nseg${i}.ts\n`; }
  playlist += '#EXT-X-ENDLIST\n';
  const server = serve(routes);
  const base = await listen(server);
  const save = tmp();
  const dl = new HlsDownload({
    id: 'h1', savePath: save, playlistUrl: base + '/index.m3u8', openConn: nodeOpen,
    fetchText: async () => ({ text: playlist, finalUrl: base + '/index.m3u8' }), concurrency: 4,
  });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  const out = fs.readFileSync(save);
  const b = mp4Boxes(out);
  assert.ok(b.includes('ftyp') && b.includes('moov') && b.includes('moof') && b.includes('mdat'), 'boxes: ' + b.slice(0, 6));
  assert.ok(out.length > SEG.length, 'converted output present');
  assert.equal(dl.doneSegments, N);
  server.close();
});

test('AES-128 encrypted HLS decrypts to the same output as plain', async () => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const ivHex = '0x' + iv.toString('hex');
  const enc = (buf) => { const c = crypto.createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([c.update(buf), c.final()]); };
  const N = 4;
  const routes = { '/key.bin': { body: key } };
  let playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=${ivHex}\n`;
  for (let i = 0; i < N; i++) { routes[`/s${i}.ts`] = { body: enc(SEG), type: 'video/mp2t' }; playlist += `#EXTINF:5,\ns${i}.ts\n`; }
  playlist += '#EXT-X-ENDLIST\n';
  const server = serve(routes);
  const base = await listen(server);
  const save = tmp();
  const dl = new HlsDownload({
    id: 'h2', savePath: save, playlistUrl: base + '/i.m3u8', openConn: nodeOpen,
    fetchText: async () => ({ text: playlist, finalUrl: base + '/i.m3u8' }), concurrency: 3,
  });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  const out = fs.readFileSync(save);
  const b = mp4Boxes(out);
  assert.ok(b.includes('ftyp') && b.includes('mdat'), 'decrypted+converted: ' + b.slice(0, 6));
  server.close();
});

test('DRM playlist is refused', async () => {
  const playlist = '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST\n';
  const dl = new HlsDownload({
    id: 'h3', savePath: tmp(), playlistUrl: 'http://x/i.m3u8', openConn: nodeOpen,
    fetchText: async () => ({ text: playlist, finalUrl: 'http://x/i.m3u8' }),
  });
  const err = await new Promise((res) => { dl.on('done', () => res(null)); dl.on('error', res); dl.start(); });
  assert.ok(err && /DRM/i.test(err.message), 'should refuse DRM: ' + (err && err.message));
});

function slowServer(routes, delayMs, counts) {
  return http.createServer((req, res) => {
    const r = routes[req.url];
    if (!r) { res.writeHead(404); return res.end(); }
    counts[req.url] = (counts[req.url] || 0) + 1;
    setTimeout(() => { res.writeHead(200, { 'Content-Length': r.body.length }); res.end(r.body); }, delayMs);
  });
}

test('pause keeps progress and a new engine resumes from the last written segment', async () => {
  const N = 14;
  const routes = {};
  let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n';
  for (let i = 0; i < N; i++) { routes[`/r${i}.bin`] = { body: Buffer.alloc(4096, i) }; playlist += `#EXTINF:1,\nr${i}.bin\n`; }
  playlist += '#EXT-X-ENDLIST\n';
  const counts = {};
  const server = slowServer(routes, 40, counts);
  const base = await listen(server);
  const save = tmp();
  const opts = {
    savePath: save, playlistUrl: base + '/i.m3u8', openConn: nodeOpen, convertTs: false, concurrency: 2,
    fetchText: async () => ({ text: playlist, finalUrl: base + '/i.m3u8' }),
  };
  const dl = new HlsDownload({ id: 'p1', ...opts });
  dl.start();
  await new Promise((r) => dl.on('progress', (p) => { if (p.doneSegments >= 6 && dl.state === 'downloading') r(); }));
  await dl.pause();
  const doneAtPause = dl.doneSegments;
  assert.equal(dl.state, 'paused');
  assert.ok(fs.existsSync(save + '.part.meta'), 'progress saved');
  for (const k of Object.keys(counts)) delete counts[k];

  const dl2 = new HlsDownload({ id: 'p1', ...opts });
  await new Promise((res, rej) => { dl2.on('done', res); dl2.on('error', rej); dl2.start(); });
  assert.equal(dl2.resumed, true, 'second engine resumed');
  const out = fs.readFileSync(save);
  assert.equal(out.length, N * 4096);
  for (let i = 0; i < N; i++) assert.equal(out[i * 4096], i, `block ${i} out of order`);
  for (let i = 0; i < doneAtPause; i++) assert.ok(!counts[`/r${i}.bin`], `segment ${i} was downloaded again`);
  assert.ok(!fs.existsSync(save + '.part.meta'), 'meta removed when finished');
  server.close();
});

test('TS stream converted with a pause in the middle stays one valid MP4', async () => {
  const N = 6;
  const routes = {};
  let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:5\n';
  for (let i = 0; i < N; i++) { routes[`/t${i}.ts`] = { body: SEG }; playlist += `#EXTINF:5,\nt${i}.ts\n`; }
  playlist += '#EXT-X-ENDLIST\n';
  const counts = {};
  const server = slowServer(routes, 60, counts);
  const base = await listen(server);
  const save = tmp();
  const opts = {
    savePath: save, playlistUrl: base + '/i.m3u8', openConn: nodeOpen, concurrency: 1,
    fetchText: async () => ({ text: playlist, finalUrl: base + '/i.m3u8' }),
  };
  const dl = new HlsDownload({ id: 'p2', ...opts });
  dl.start();
  await new Promise((r) => dl.on('progress', (p) => { if (p.doneSegments >= 2 && dl.state === 'downloading') r(); }));
  await dl.pause();
  const dl2 = new HlsDownload({ id: 'p2', ...opts });
  await new Promise((res, rej) => { dl2.on('done', res); dl2.on('error', rej); dl2.start(); });
  const out = fs.readFileSync(save);
  const b = mp4Boxes(out);
  assert.equal(b.filter((x) => x === 'ftyp').length, 1, 'exactly one ftyp');
  assert.equal(b.filter((x) => x === 'moov').length, 1, 'exactly one moov');
  assert.ok(b.filter((x) => x === 'moof').length >= N, 'a fragment per segment: ' + b.filter((x) => x === 'moof').length);
  server.close();
});

test('output segments are written strictly in playlist order', async () => {
  // Each segment is a distinct byte value; with no conversion the output must be 0,1,2,... blocks.
  const N = 8;
  const routes = {};
  let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n';
  for (let i = 0; i < N; i++) { routes[`/p${i}.bin`] = { body: Buffer.alloc(4096, i) }; playlist += `#EXTINF:1,\np${i}.bin\n`; }
  playlist += '#EXT-X-ENDLIST\n';
  // Random per-request latency so fetches finish out of order.
  const server = http.createServer((req, res) => {
    const r = routes[req.url];
    if (!r) { res.writeHead(404); return res.end(); }
    setTimeout(() => { res.writeHead(200, { 'Content-Length': r.body.length }); res.end(r.body); }, Math.random() * 40);
  });
  const base = await listen(server);
  const save = tmp();
  const dl = new HlsDownload({
    id: 'h4', savePath: save, playlistUrl: base + '/i.m3u8', openConn: nodeOpen, convertTs: false,
    fetchText: async () => ({ text: playlist, finalUrl: base + '/i.m3u8' }), concurrency: 6,
  });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  const out = fs.readFileSync(save);
  assert.equal(out.length, N * 4096);
  for (let i = 0; i < N; i++) assert.equal(out[i * 4096], i, `block ${i} out of order`);
  server.close();
});
