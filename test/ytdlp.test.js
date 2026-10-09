'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { YtDlp, choicesFrom, shaFromList, netscapeCookies } = require('../src/main/ytdlp');

// The shape of yt-dlp -J output (trimmed to what NovaDM reads).
const INFO = {
  title: 'A talk / with "odd" chars', duration: 640, webpage_url: 'https://video.example/watch?v=1', thumbnail: 'https://i.example/t.jpg',
  formats: [
    { format_id: 'sb0', protocol: 'mhtml', url: 'https://x/sb', vcodec: 'none', acodec: 'none' },
    { format_id: '18', protocol: 'https', url: 'https://cdn.example/360.mp4', ext: 'mp4', height: 360, width: 640, vcodec: 'avc1', acodec: 'mp4a', filesize: 20e6, http_headers: { 'User-Agent': 'x', Referer: 'https://video.example/' } },
    { format_id: 'hls-720', protocol: 'm3u8_native', url: 'https://cdn.example/720.m3u8', ext: 'mp4', height: 720, vcodec: 'avc1', acodec: 'mp4a' },
    { format_id: '137', protocol: 'https', url: 'https://cdn.example/1080v.mp4', ext: 'mp4', height: 1080, width: 1920, vcodec: 'avc1', acodec: 'none', filesize: 200e6 },
    { format_id: '248', protocol: 'https', url: 'https://cdn.example/1080v.webm', ext: 'webm', height: 1080, vcodec: 'vp9', acodec: 'none', filesize: 180e6 },
    { format_id: '140', protocol: 'https', url: 'https://cdn.example/a.m4a', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 128, filesize: 10e6 },
    { format_id: '251', protocol: 'https', url: 'https://cdn.example/a.webm', ext: 'webm', vcodec: 'none', acodec: 'opus', abr: 160 },
    { format_id: 'drm', protocol: 'https', url: 'https://cdn.example/drm.mp4', has_drm: true, vcodec: 'avc1', acodec: 'mp4a', height: 2160 },
  ],
};

test('yt-dlp formats become a short list of choices NovaDM can download', () => {
  const r = choicesFrom(INFO);
  assert.equal(r.title, 'A talk / with "odd" chars');
  const labels = r.choices.map((c) => c.label);
  assert.equal(labels[0], '1080p MP4 (picture + sound)', 'best first, MP4 + M4A needs no FFmpeg');
  assert.ok(labels.includes('720p stream'));
  assert.ok(labels.includes('360p MP4'));
  assert.ok(labels.includes('Sound only (M4A)'));
  assert.ok(!labels.some((l) => /2160/.test(l)), 'DRM formats are left out');
  const best = r.choices[0].spec;
  assert.equal(best.kind, 'merge');
  assert.deepEqual(best.mergeSource.tracks.map((t) => [t.kind, t.url]), [['video', 'https://cdn.example/1080v.mp4'], ['audio', 'https://cdn.example/a.m4a']]);
  assert.equal(best.size, 210e6);
  const mp4 = r.choices.find((c) => c.label === '360p MP4').spec;
  assert.deepEqual(mp4.headers, { referer: 'https://video.example/' }, 'site headers kept, user agent left to NovaDM');
  assert.equal(r.choices.find((c) => c.label === '720p stream').spec.kind, 'hls');
});

test('checksum list, cookies file', () => {
  assert.equal(shaFromList('aa  yt-dlp_linux\n' + 'b'.repeat(64) + '  yt-dlp.exe\n'), 'b'.repeat(64));
  assert.equal(shaFromList('nothing'), '');
  const txt = netscapeCookies([{ domain: '.video.example', path: '/', secure: true, expirationDate: 1900000000.5, name: 'sid', value: 'abc' }]);
  assert.equal(txt, '# Netscape HTTP Cookie File\n.video.example\tTRUE\t/\tTRUE\t1900000000\tsid\tabc\n');
});

test('find: yt-dlp gets the page (and its cookies in a file that is removed again)', async () => {
  let cookieFile = '';
  let seenArgs = [];
  const yt = new YtDlp({
    settings: { get: () => '' }, userDataDir: os.tmpdir(),
    run: async (args) => {
      seenArgs = args;
      cookieFile = args[args.indexOf('--cookies') + 1];
      assert.match(fs.readFileSync(cookieFile, 'utf8'), /\tsid\tabc/);
      return JSON.stringify(INFO);
    },
  });
  const r = await yt.find('https://video.example/watch?v=1', { cookies: [{ domain: 'video.example', name: 'sid', value: 'abc' }], referer: 'https://video.example/' });
  assert.ok(r.choices.length >= 4);
  assert.deepEqual(seenArgs.slice(-2), ['--', 'https://video.example/watch?v=1'], 'the page address can never be taken for an option');
  assert.equal(fs.existsSync(cookieFile), false, 'cookies file removed');
  await assert.rejects(yt.find('file:///C:/x'));
});

test('install: checked against the published checksum list', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-yt-'));
  const exe = Buffer.from('MZ fake yt-dlp');
  const sha = crypto.createHash('sha256').update(exe).digest('hex');
  const mk = (sums) => new YtDlp({ settings: { get: () => '' }, userDataDir: userData, fetchText: async () => sums, download: async (url, dest) => fs.writeFileSync(dest, exe) });
  await assert.rejects(mk(`${'0'.repeat(64)}  yt-dlp.exe\n`).install(), /checksum/);
  assert.equal(fs.existsSync(path.join(userData, 'tools', 'yt-dlp', 'yt-dlp.exe')), false);
  await mk(`${sha}  yt-dlp.exe\n`).install();
  assert.ok(fs.existsSync(path.join(userData, 'tools', 'yt-dlp', 'yt-dlp.exe')));
});
