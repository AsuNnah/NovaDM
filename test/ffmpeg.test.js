'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { FFmpeg, pickBuild, parseTime } = require('../src/main/ffmpeg');
const { MergeDownload } = require('../src/main/download/merge-dl');

const SUMS = [
  '7c2f2b099bf7799e55b16b8214f608b26064980cf4d8d19022b3995f49732319  ffmpeg-master-latest-win64-gpl.zip',
  'd02601aa9e57428c26c165cc680f42ef0e6833913167a19da05735ac46ea33c5  ffmpeg-master-latest-win64-lgpl-shared.zip',
  'fab88c806009745666a4b0f4e0ff3b8cdbc91f8f5ae72cc67113dc6b5c67de46  ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip',
  '1a905e037d829278ff69f3fbd2bc418f009f3b4ff24e82d397d5af301cb76b60  ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip',
  'aaaa05e037d829278ff69f3fbd2bc418f009f3b4ff24e82d397d5af301cb76b6  ffmpeg-n9.0-latest-linux64-lgpl-shared-9.0.tar.xz',
].join('\n');

test('the newest stable Windows LGPL shared build is chosen from the official list', () => {
  assert.deepEqual(pickBuild(SUMS), { sha256: '1a905e037d829278ff69f3fbd2bc418f009f3b4ff24e82d397d5af301cb76b60', name: 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip' });
  assert.equal(pickBuild(SUMS.split('\n').filter((l) => !/-n\d/.test(l)).join('\n')).name, 'ffmpeg-master-latest-win64-lgpl-shared.zip');
  assert.equal(pickBuild('nothing useful'), null);
  assert.equal(parseTime('frame=  50 fps=0.0 q=-1.0 size=1024kB time=00:01:02.50 bitrate=...'), 62.5);
});

const settings = (v = {}) => ({ get: (k) => v[k] });

test('install: the download is checked against its published checksum, then unpacked', { skip: process.platform !== 'win32' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-ff-'));
  const src = path.join(tmp, 'src', 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0', 'bin');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'ffmpeg.exe'), 'not really ffmpeg');
  fs.writeFileSync(path.join(src, 'avcodec-62.dll'), 'dll');
  const zip = path.join(tmp, 'build.zip');
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', path.join(tmp, 'src'), 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0']);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  const sums = `${sha}  ffmpeg-n9.0-latest-win64-lgpl-shared-9.0.zip\n`;
  const userData = path.join(tmp, 'profile');
  const phases = [];
  let fetched = '';
  const ff = new FFmpeg({
    settings: settings(), userDataDir: userData, fetchText: async () => sums,
    download: async (url, dest, onProgress) => { fetched = url; fs.copyFileSync(zip, dest); onProgress({ received: 1, size: 1 }); },
  });
  await ff.install((p) => phases.push(p.phase));
  assert.match(fetched, /\/ffmpeg-n9\.0-latest-win64-lgpl-shared-9\.0\.zip$/);
  assert.ok(fs.existsSync(path.join(userData, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe')));
  assert.ok(fs.existsSync(path.join(userData, 'tools', 'ffmpeg', 'bin', 'avcodec-62.dll')), 'the libraries next to it too');
  assert.deepEqual(phases.filter((x, i, a) => a.indexOf(x) === i), ['checking', 'downloading', 'verifying', 'unpacking', 'done']);
  assert.equal(ff.exe(), path.join(userData, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'));

  // A download that doesn't match the list installs nothing.
  const other = path.join(tmp, 'profile2');
  const bad = new FFmpeg({ settings: settings(), userDataDir: other, fetchText: async () => sums.replace(sha, '0'.repeat(64)), download: async (u, dest) => fs.copyFileSync(zip, dest) });
  await assert.rejects(bad.install(), /checksum/);
  assert.equal(fs.existsSync(path.join(other, 'tools', 'ffmpeg')), false);
});

// WebM DASH: picture and sound go to separate files and FFmpeg joins them.
function webmServer(t) {
  const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const routes = {
    '/v/init.webm': Buffer.concat([ebml, Buffer.from('VIDEO-INIT')]), '/v/1.webm': Buffer.from('V1'), '/v/2.webm': Buffer.from('V2'),
    '/a/init.webm': Buffer.concat([ebml, Buffer.from('AUDIO-INIT')]), '/a/1.webm': Buffer.from('A1'), '/a/2.webm': Buffer.from('A2'),
    '/m.mpd': `<MPD type="static" mediaPresentationDuration="PT8S"><Period>
      <AdaptationSet contentType="video" mimeType="video/webm"><SegmentTemplate initialization="v/init.webm" media="v/$Number$.webm" duration="4"/><Representation id="v" bandwidth="1" height="720" codecs="vp9"/></AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/webm"><SegmentTemplate initialization="a/init.webm" media="a/$Number$.webm" duration="4"/><Representation id="a" bandwidth="1" codecs="opus"/></AdaptationSet></Period></MPD>`,
  };
  const server = http.createServer((req, res) => { const b = routes[req.url]; if (!b) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Length': Buffer.byteLength(b) }); res.end(b); });
  t.after(() => server.close());
  return { server, routes };
}
function nodeOpen(url, { range } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: range ? { range } : {} }, (res) => resolve({ res, status: res.statusCode, headers: res.headers, finalUrl: url, abort: () => req.destroy() }));
    req.on('error', reject);
  });
}

test('WebM picture and sound are saved separately and joined by FFmpeg into .mkv', async (t) => {
  const { server, routes } = webmServer(t);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const save = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-webm-')), 'clip.mp4');
  const calls = [];
  const ffmpeg = { available: () => true, merge: async (v, a, out) => { calls.push([path.basename(v), path.basename(a), path.basename(out)]); fs.writeFileSync(out, Buffer.concat([fs.readFileSync(v), fs.readFileSync(a)])); } };
  const dl = new MergeDownload({ id: 'w', savePath: save, source: { type: 'dash', url: base + '/m.mpd' }, openConn: nodeOpen, fetchText: async (u) => ({ text: routes[new URL(u).pathname], finalUrl: u }), ffmpeg });
  let renamed = '';
  dl.on('renamed', (p) => { renamed = p; });
  await new Promise((res, rej) => { dl.on('done', res); dl.on('error', rej); dl.start(); });
  assert.equal(path.basename(renamed), 'clip.mkv');
  assert.deepEqual(calls, [['clip.mp4.video.part', 'clip.mp4.audio.part', 'clip.mkv']]);
  const out = fs.readFileSync(renamed).toString('latin1');
  assert.ok(out.includes('VIDEO-INITV1V2') && out.includes('AUDIO-INITA1A2'), 'each track in order: ' + out);
  assert.equal(fs.existsSync(save + '.video.part'), false);
});

test('without FFmpeg a WebM stream asks for it instead of downloading for nothing', async (t) => {
  const { server, routes } = webmServer(t);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const save = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-webm-')), 'clip.mp4');
  const dl = new MergeDownload({ id: 'w2', savePath: save, source: { type: 'dash', url: base + '/m.mpd' }, openConn: nodeOpen, fetchText: async (u) => ({ text: routes[new URL(u).pathname], finalUrl: u }), ffmpeg: { available: () => false } });
  const err = await new Promise((r) => { dl.on('error', r); dl.on('done', () => r(null)); dl.start(); });
  assert.equal(err && err.code, 'NEEDS_FFMPEG');
});
