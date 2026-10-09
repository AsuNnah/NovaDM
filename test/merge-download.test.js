'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const muxjs = require('mux.js');
const { MergeDownload } = require('../src/main/download/merge-dl');
const { readBoxes, parseInit } = require('../src/main/media/mp4');

const SEGDIR = path.join(__dirname, '..', 'node_modules', 'mux.js', 'test', 'segments');
const TS = fs.readFileSync(path.join(SEGDIR, 'test-segment.ts'));
const TS_VIDEO_ONLY = fs.readFileSync(path.join(SEGDIR, 'test-no-audio-segment.ts'));
const AAC = fs.readFileSync(path.join(SEGDIR, 'test-aac-segment.aac'));

function nodeOpen(url, { headers = {}, range } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (range) h.range = range;
    const req = http.get(url, { headers: h }, (res) => resolve({ req, res, finalUrl: url, status: res.statusCode, headers: res.headers, abort: () => req.destroy() }));
    req.on('error', reject);
  });
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-merge-')), 'out.mp4');
const run = (dl) => new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });

function serve(routes, { delayMs = 0, stats = {} } = {}) {
  stats.hits = stats.hits || {};
  return http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    stats.hits[u] = (stats.hits[u] || 0) + 1;
    const body = routes[u];
    if (body == null) { res.writeHead(404); return res.end(); }
    setTimeout(() => { res.writeHead(200, { 'Content-Length': Buffer.byteLength(body) }); res.end(body); }, delayMs);
  });
}

// A DASH stream: N segments of 10 s for video and audio, as separate fragmented MP4s.
function dashStream(n) {
  const routes = {};
  for (let k = 0; k < n; k++) {
    const tx = new muxjs.mp4.Transmuxer({ remux: false, baseMediaDecodeTime: k * 900000 });
    tx.on('data', (s) => {
      const dir = s.type === 'video' ? 'v' : 'a';
      if (k === 0) routes[`/${dir}/init.mp4`] = Buffer.from(s.initSegment);
      routes[`/${dir}/${k + 1}.m4s`] = Buffer.from(s.data);
    });
    tx.push(new Uint8Array(TS)); tx.flush();
  }
  routes['/stream.mpd'] = `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT${n * 10}S"><Period>
    <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate initialization="v/init.mp4" media="v/$Number$.m4s" timescale="1" duration="10"/>
      <Representation id="v1" bandwidth="1000000" width="640" height="360" codecs="avc1.4d401e"/></AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4"><SegmentTemplate initialization="a/init.mp4" media="a/$Number$.m4s" timescale="1" duration="10"/>
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/></AdaptationSet></Period></MPD>`;
  return routes;
}

function check(file) {
  const buf = fs.readFileSync(file);
  const top = readBoxes(buf).map((b) => b.type);
  const info = parseInit(buf);
  const parsed = muxjs.mp4.tools.inspect(new Uint8Array(buf)).filter((b) => b.type === 'moof');
  const seqs = parsed.map((m) => m.boxes.find((x) => x.type === 'mfhd').sequenceNumber);
  const perTrack = {};
  for (const m of parsed) {
    const traf = m.boxes.find((x) => x.type === 'traf');
    const id = traf.boxes.find((x) => x.type === 'tfhd').trackId;
    const t = traf.boxes.find((x) => x.type === 'tfdt').baseMediaDecodeTime;
    (perTrack[id] = perTrack[id] || []).push(Number(t));
  }
  return { top, tracks: info.tracks.map((t) => t.handler), seqs, perTrack };
}

test('DASH: video and audio are downloaded and merged into one MP4', async (t) => {
  const routes = dashStream(3);
  const server = serve(routes); t.after(() => server.close());
  const base = await listen(server);
  const save = tmp();
  const dl = new MergeDownload({ id: 'd1', savePath: save, source: { type: 'dash', url: base + '/stream.mpd' }, openConn: nodeOpen, fetchText: async (u) => ({ text: routes[new URL(u).pathname], finalUrl: u }), concurrency: 3 });
  await run(dl);
  const r = check(save);
  assert.deepEqual(r.top.slice(0, 2), ['ftyp', 'moov']);
  assert.equal(r.top.filter((x) => x === 'moof').length, 6);
  assert.deepEqual(r.tracks.sort(), ['soun', 'vide']);
  assert.deepEqual(r.seqs, [1, 2, 3, 4, 5, 6]);
  for (const times of Object.values(r.perTrack)) {
    assert.equal(times.length, 3);
    assert.ok(times[0] === 0 && times[1] > times[0] && times[2] > times[1], 'timeline starts at 0 and goes forward: ' + times);
  }
  assert.ok(!fs.existsSync(save + '.part.meta') && !fs.existsSync(save + '.part.tracks'), 'temporary files removed');
});

test('HLS with a separate audio rendition (TS video + packed AAC) becomes one MP4', async (t) => {
  const routes = {
    '/master.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"\nvideo.m3u8\n',
    '/video.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nv0.ts\n#EXTINF:1,\nv1.ts\n#EXT-X-ENDLIST\n',
    '/audio.m3u8': '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\na0.aac\n#EXTINF:1,\na1.aac\n#EXT-X-ENDLIST\n',
    '/v0.ts': TS_VIDEO_ONLY, '/v1.ts': TS_VIDEO_ONLY, '/a0.aac': AAC, '/a1.aac': AAC,
  };
  const server = serve(routes); t.after(() => server.close());
  const base = await listen(server);
  const save = tmp();
  const dl = new MergeDownload({ id: 'h1', savePath: save, source: { type: 'hls', url: base + '/master.m3u8' }, openConn: nodeOpen, fetchText: async (u) => ({ text: routes[new URL(u).pathname], finalUrl: u }), concurrency: 2 });
  await run(dl);
  const r = check(save);
  assert.deepEqual(r.tracks.sort(), ['soun', 'vide']);
  assert.equal(r.top.filter((x) => x === 'moof').length, 4);
  for (const times of Object.values(r.perTrack)) assert.ok(times[1] > times[0], 'the repeated segment was moved forward on the timeline: ' + times);
  assert.ok(Math.min(...Object.values(r.perTrack).map((x) => x[0])) === 0, 'the earliest track starts at 0');
});

test('a paused merge resumes and gives the same file as an uninterrupted download', async (t) => {
  const routes = dashStream(6);
  const stats = {};
  const server = serve(routes, { delayMs: 150, stats }); t.after(() => server.close());
  const base = await listen(server);
  const opts = { source: { type: 'dash', url: base + '/stream.mpd' }, openConn: nodeOpen, fetchText: async (u) => ({ text: routes[new URL(u).pathname], finalUrl: u }), concurrency: 2 };
  const whole = tmp();
  await run(new MergeDownload({ id: 'w', savePath: whole, ...opts }));

  const save = tmp();
  const dl = new MergeDownload({ id: 'p', savePath: save, ...opts, checkpointMs: 1 });
  dl.start();
  // Poll the engine (progress events are throttled and could skip straight past the mark).
  const t0 = Date.now();
  while (dl.doneSegments < 4 && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 10));
  assert.equal(dl.state, 'downloading', 'still downloading when paused');
  await dl.pause();
  const written = dl.doneSegments;
  stats.hits = {};
  // The manifest is gone now: the resume must use the saved track list.
  delete routes['/stream.mpd'];
  const dl2 = new MergeDownload({ id: 'p', savePath: save, ...opts });
  await run(dl2);
  assert.equal(dl2.resumed, true);
  assert.ok(fs.readFileSync(save).equals(fs.readFileSync(whole)), 'byte-identical to the uninterrupted download');
  assert.ok(Object.values(stats.hits).reduce((a, b) => a + b, 0) <= 12 - written + 2, 'segments already written were not fetched again');
});

test('a DASH manifest with DRM is refused', async () => {
  const mpd = '<MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><SegmentTemplate media="$Number$.m4s" initialization="i.mp4" duration="10"/><Representation id="v" bandwidth="1" height="360"/></AdaptationSet></Period></MPD>';
  const dl = new MergeDownload({ id: 'x', savePath: tmp(), source: { type: 'dash', url: 'http://127.0.0.1:9/m.mpd' }, fetchText: async () => ({ text: mpd, finalUrl: 'http://127.0.0.1:9/m.mpd' }), openConn: nodeOpen });
  const err = await new Promise((r) => { dl.on('error', r); dl.on('done', () => r(null)); dl.start(); });
  assert.equal(err && err.code, 'DRM');
});

// A whole fragmented MP4 file with an index (sidx), like YouTube-style DASH formats.
function indexedFile(type, n) {
  let init = null; const frags = [];
  for (let k = 0; k < n; k++) {
    const tx = new muxjs.mp4.Transmuxer({ remux: false, baseMediaDecodeTime: k * 900000 });
    tx.on('data', (s) => { if (s.type !== type) return; if (!init) init = Buffer.from(s.initSegment); frags.push(Buffer.from(s.data)); });
    tx.push(new Uint8Array(TS)); tx.flush();
  }
  const { makeBox } = require('../src/main/media/mp4');
  // sidx v0: version/flags, reference_ID, timescale, earliest time, first_offset, reserved, count, refs
  const body = Buffer.alloc(24 + frags.length * 12);
  body.writeUInt32BE(1, 4); body.writeUInt32BE(90000, 8); body.writeUInt16BE(frags.length, 22);
  frags.forEach((f, i) => { body.writeUInt32BE(f.length, 24 + i * 12); body.writeUInt32BE(900000, 28 + i * 12); body.writeUInt32BE(0x90000000, 32 + i * 12); });
  return Buffer.concat([init, makeBox('sidx', body), ...frags]);
}

function rangeServer(t, files, { ranges = true } = {}) {
  const server = http.createServer((req, res) => {
    const body = files[req.url];
    if (!body) { res.writeHead(404); return res.end(); }
    const m = ranges && /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'Content-Length': body.length }); return res.end(body); }
    const s = Number(m[1]); const e = Math.min(Number(m[2]), body.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${s}-${e}/${body.length}`, 'Content-Length': e - s + 1 });
    res.end(body.subarray(s, e + 1));
  });
  t.after(() => server.close());
  return server;
}

test('separate video and audio files with an index are merged without FFmpeg', async (t) => {
  const files = { '/v.mp4': indexedFile('video', 3), '/a.m4a': indexedFile('audio', 3) };
  const server = rangeServer(t, files);
  const base = await listen(server);
  const save = tmp();
  const dl = new MergeDownload({ id: 'y', savePath: save, openConn: nodeOpen, source: { type: 'direct', tracks: [{ kind: 'video', url: base + '/v.mp4' }, { kind: 'audio', url: base + '/a.m4a' }] } });
  await run(dl);
  const r = check(save);
  assert.deepEqual(r.tracks.sort(), ['soun', 'vide']);
  assert.equal(r.top.filter((x) => x === 'moof').length, 6);
  assert.ok(!r.top.includes('sidx'), 'the old index is not copied');
});

test('plain files are fetched in ranges and joined by FFmpeg; servers without ranges are refused', async (t) => {
  const files = { '/v.webm': Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(9000, 1)]), '/a.webm': Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(5000, 2)]) };
  const server = rangeServer(t, files);
  const base = await listen(server);
  const save = tmp();
  const joined = [];
  const ffmpeg = { available: () => true, merge: async (v, a, out) => { joined.push(out); fs.writeFileSync(out, Buffer.concat([fs.readFileSync(v), fs.readFileSync(a)])); } };
  const dl = new MergeDownload({ id: 'p', savePath: save, openConn: nodeOpen, ffmpeg, source: { type: 'direct', tracks: [{ kind: 'video', url: base + '/v.webm' }, { kind: 'audio', url: base + '/a.webm' }] } });
  let renamed = '';
  dl.on('renamed', (p) => { renamed = p; });
  await run(dl);
  assert.match(renamed, /\.mkv$/);
  assert.equal(fs.readFileSync(renamed).length, 9004 + 5004);

  const noRanges = rangeServer(t, { '/big.bin': Buffer.alloc(3 * 1024 * 1024, 7) }, { ranges: false });
  const base2 = await listen(noRanges);
  const dl2 = new MergeDownload({ id: 'n', savePath: tmp(), openConn: nodeOpen, ffmpeg, source: { type: 'direct', tracks: [{ kind: 'video', url: base2 + '/big.bin' }] } });
  const err = await new Promise((r) => { dl2.on('error', r); dl2.on('done', () => r(null)); dl2.start(); });
  assert.match(String(err && err.message), /parts of files/);
});
