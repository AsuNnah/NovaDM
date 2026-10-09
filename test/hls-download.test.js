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
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-hls-')), 'out.mp4');

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

// Latency-bound server: each request waits delayMs, so more parallel fetches finish sooner.
function latencyServer(routes, delayMs, stats, opts = {}) {
  stats.active = 0; stats.peak = 0; stats.requests = 0;
  let throttle = opts.throttle || 0;
  return http.createServer((req, res) => {
    const r = routes[req.url];
    if (!r || r.gone) { res.writeHead(r ? 410 : 404); return res.end(); }
    stats.requests++;
    if (throttle > 0 && stats.requests > 4) { throttle--; res.writeHead(429, { 'Retry-After': '1' }); return res.end(); }
    stats.active++; stats.peak = Math.max(stats.peak, stats.active);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Length': r.body.length });
      res.end(r.body, () => { stats.active--; });
    }, delayMs);
  });
}

test('parallel segment fetches grow while the total speed rises', async (t) => {
  const N = 200;
  const routes = {};
  let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n';
  for (let i = 0; i < N; i++) { routes[`/g${i}.bin`] = { body: Buffer.alloc(16384, i & 255) }; playlist += `#EXTINF:1,\ng${i}.bin\n`; }
  playlist += '#EXT-X-ENDLIST\n';
  const stats = {};
  const server = latencyServer(routes, 100, stats); t.after(() => server.close());
  const base = await listen(server);
  const save = tmp();
  const dl = new HlsDownload({
    id: 'g1', savePath: save, playlistUrl: base + '/g.m3u8', openConn: nodeOpen, convertTs: false, concurrency: 12,
    fetchText: async () => ({ text: playlist, finalUrl: base + '/g.m3u8' }),
  });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  assert.equal(fs.statSync(save).size, N * 16384);
  assert.ok(stats.peak >= 6, 'expected the parallel fetches to grow past the start value, peak was ' + stats.peak);
});

test('resume works after the playlist and key links have expired', async (t) => {
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const enc = (buf) => { const c = crypto.createCipheriv('aes-128-cbc', key, iv); return Buffer.concat([c.update(buf), c.final()]); };
  const N = 12;
  const routes = { '/k.bin': { body: key } };
  let playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x${iv.toString('hex')}\n`;
  const plain = [];
  for (let i = 0; i < N; i++) {
    plain.push(Buffer.alloc(4000, i));
    routes[`/e${i}.bin`] = { body: enc(plain[i]) };
    playlist += `#EXTINF:1,\ne${i}.bin\n`;
  }
  playlist += '#EXT-X-ENDLIST\n';
  const stats = {};
  const server = latencyServer(routes, 40, stats); t.after(() => server.close());
  const base = await listen(server);
  const save = tmp();
  const opts = { savePath: save, playlistUrl: base + '/p.m3u8', openConn: nodeOpen, convertTs: false, concurrency: 2 };
  const dl = new HlsDownload({ id: 'k1', ...opts, fetchText: async () => ({ text: playlist, finalUrl: base + '/p.m3u8' }) });
  dl.start();
  await new Promise((r) => dl.on('progress', (p) => { if (p.doneSegments >= 4 && dl.state === 'downloading') r(); }));
  await dl.pause();
  assert.ok(fs.existsSync(save + '.part.m3u8'), 'playlist copy kept while unfinished');

  // Both links are dead now: the playlist request fails and the key is gone.
  routes['/k.bin'].gone = true;
  const expired = async () => { const e = new Error('HTTP 410'); e.status = 410; throw e; };
  const dl2 = new HlsDownload({ id: 'k1', ...opts, fetchText: expired });
  await new Promise((res, rej) => { dl2.on('done', res); dl2.on('error', rej); dl2.start(); });
  assert.equal(dl2.resumed, true);
  assert.ok(fs.readFileSync(save).equals(Buffer.concat(plain)), 'decrypted output matches');
  assert.ok(!fs.existsSync(save + '.part.m3u8'), 'playlist copy removed when finished');
});

test('429 from the server shrinks parallel fetches and the download still finishes', async (t) => {
  const N = 30;
  const routes = {};
  let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n';
  for (let i = 0; i < N; i++) { routes[`/t${i}.bin`] = { body: Buffer.alloc(2048, i) }; playlist += `#EXTINF:1,\nt${i}.bin\n`; }
  playlist += '#EXT-X-ENDLIST\n';
  const stats = {};
  const server = latencyServer(routes, 20, stats, { throttle: 3 }); t.after(() => server.close());
  const base = await listen(server);
  const save = tmp();
  const dl = new HlsDownload({
    id: 't1', savePath: save, playlistUrl: base + '/t.m3u8', openConn: nodeOpen, convertTs: false, concurrency: 8, retryDelayMs: 20,
    fetchText: async () => ({ text: playlist, finalUrl: base + '/t.m3u8' }),
  });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  const out = fs.readFileSync(save);
  assert.equal(out.length, N * 2048);
  for (let i = 0; i < N; i++) assert.equal(out[i * 2048], i);
  assert.ok(dl.steady && dl.target < 3, 'stopped growing after 429, target ' + dl.target);
});

test('speed-limited HLS keeps every byte of every segment', async (t) => {
  const { RateLimiter } = require('../src/main/download/limiter');
  const N = 8;
  const routes = {};
  let playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n';
  const parts = [];
  for (let i = 0; i < N; i++) { parts.push(crypto.randomBytes(96 * 1024)); routes[`/l${i}.bin`] = { body: parts[i] }; playlist += `#EXTINF:1,\nl${i}.bin\n`; }
  playlist += '#EXT-X-ENDLIST\n';
  const server = serve(routes); t.after(() => server.close());
  const base = await listen(server);
  const save = tmp();
  const dl = new HlsDownload({
    id: 'l1', savePath: save, playlistUrl: base + '/l.m3u8', openConn: nodeOpen, convertTs: false, concurrency: 3,
    taskLimiter: new RateLimiter(256 * 1024), fetchText: async () => ({ text: playlist, finalUrl: base + '/l.m3u8' }),
  });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  assert.ok(fs.readFileSync(save).equals(Buffer.concat(parts)), 'output is every segment, complete and in order');
});

// A live stream: a new 1-second segment appears every 300 ms; the playlist lists the last 4.
function liveServer(t, { endAfter = Infinity } = {}) {
  const t0 = Date.now();
  const routes = {};
  const seg = (n) => Buffer.alloc(2000, n % 256);
  const playlist = () => {
    const n = Math.floor((Date.now() - t0) / 300) + 4;
    const last = Math.min(n, endAfter);
    const first = Math.max(0, last - 4);
    let p = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${first}\n`;
    for (let i = first; i < last; i++) p += `#EXTINF:1,\nlive${i}.bin\n`;
    if (n >= endAfter) p += '#EXT-X-ENDLIST\n';
    return p;
  };
  const server = http.createServer((req, res) => {
    const m = /^\/live(\d+)\.bin$/.exec(req.url);
    if (!m) { res.writeHead(404); return res.end(); }
    const body = seg(Number(m[1]));
    res.writeHead(200, { 'Content-Length': body.length }); res.end(body);
  });
  t.after(() => server.close());
  return { server, playlist, seg };
}

test('a live stream is recorded until it is stopped, without gaps or repeats', async (t) => {
  const { server, playlist } = liveServer(t);
  const base = await listen(server);
  const save = tmp();
  const dl = new HlsDownload({
    id: 'live1', savePath: save, playlistUrl: base + '/live.m3u8', openConn: nodeOpen, convertTs: false, concurrency: 4,
    fetchText: async () => ({ text: playlist(), finalUrl: base + '/live.m3u8' }),
  });
  const done = new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); });
  dl.start();
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(dl.isRecording(), true);
  assert.equal(dl.progress().recording, true);
  dl.stopRecording();
  await done;
  const out = fs.readFileSync(save);
  assert.equal(out.length % 2000, 0);
  const ids = [];
  for (let i = 0; i < out.length; i += 2000) ids.push(out[i]);
  assert.ok(ids.length >= 6, 'recorded several new segments: ' + ids.length);
  for (let i = 1; i < ids.length; i++) assert.equal(ids[i], (ids[i - 1] + 1) % 256, 'segments in order, no gaps or repeats: ' + ids);
  assert.equal(dl.liveGaps, 0);
  assert.ok(dl.progress().recordedSeconds >= 6);
});

test('a recording ends by itself when the broadcast ends', async (t) => {
  const { server, playlist } = liveServer(t, { endAfter: 10 });
  const base = await listen(server);
  const save = tmp();
  const dl = new HlsDownload({
    id: 'live2', savePath: save, playlistUrl: base + '/live.m3u8', openConn: nodeOpen, convertTs: false,
    fetchText: async () => ({ text: playlist(), finalUrl: base + '/live.m3u8' }),
  });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  const out = fs.readFileSync(save);
  assert.equal(out[out.length - 1], 9, 'the last segment of the broadcast is included');
});
