'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseScanOutput, wantsScan, markOfTheWeb, readMarkOfTheWeb } = require('../src/main/download/postprocess');

test('Defender output decides the result, not its exit code', () => {
  assert.deepEqual(parseScanOutput('Scan starting...\nScan finished.\nScanning C:\\x\\a.zip found no threats.\n'), { result: 'clean', detail: '' });
  const threat = parseScanOutput('Scanning C:\\x\\eicar.com found 1 threats.\n<===========================LIST OF DETECTED THREATS==========================>\n----------------------------- Threat information ------------------------------\nThreat                  : Virus:DOS/EICAR_Test_File\n');
  assert.equal(threat.result, 'threat');
  assert.equal(threat.detail, 'Virus:DOS/EICAR_Test_File');
  const failed = parseScanOutput('[Failed][0x80004005] Unspecified error\nCmdTool: Failed with hr = 0x80004005. Check C:\\log for more information');
  assert.equal(failed.result, 'error');
  assert.match(failed.detail, /Failed/);
});

test('which downloads get scanned', () => {
  assert.equal(wantsScan('programs', 'programs'), true);
  assert.equal(wantsScan('programs', 'archives'), true);
  assert.equal(wantsScan('programs', 'video'), false);
  assert.equal(wantsScan('all', 'video'), true);
  assert.equal(wantsScan('off', 'programs'), false);
});

test('Mark of the Web is written next to the file (Windows, NTFS)', { skip: process.platform !== 'win32' }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-motw-')), 'setup.exe');
  fs.writeFileSync(file, 'MZ');
  assert.equal(markOfTheWeb(file, { url: 'https://dl.example.com/setup.exe', referrer: 'https://example.com/download' }), true);
  const zone = readMarkOfTheWeb(file);
  assert.match(zone, /ZoneId=3/);
  assert.match(zone, /HostUrl=https:\/\/dl\.example\.com\/setup\.exe/);
  assert.match(zone, /ReferrerUrl=https:\/\/example\.com\/download/);
  const priv = path.join(path.dirname(file), 'private.zip');
  fs.writeFileSync(priv, 'PK');
  markOfTheWeb(priv, { url: 'https://secret.example.com/x.zip', incognito: true });
  assert.doesNotMatch(readMarkOfTheWeb(priv), /secret/);
  assert.match(readMarkOfTheWeb(priv), /HostUrl=about:internet/);
});

// 1.4.4: finished video downloads become a normal MP4 with FFmpeg (index first: plays and seeks at once).
const { isFragmentedMp4, makeFaststart } = require('../src/main/download/postprocess');
const { TsToMp4 } = require('../src/main/media/transmux');
const { makeBox, readBoxes, child } = require('../src/main/media/mp4');
const SEG = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mux.js', 'test', 'segments', 'test-segment.ts'));

function fragmentedMp4(file, segments = 3) {
  const chunks = [];
  const tx = new TsToMp4((b) => chunks.push(Buffer.from(b)));
  for (let i = 0; i < segments; i++) { tx.push(SEG, 10); tx.flushSegment(); }
  tx.end();
  fs.writeFileSync(file, Buffer.concat(chunks));
  return fs.statSync(file).size;
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-faststart-'));

test('faststart: a fragmented MP4 is recognised, a normal one and other files are not', () => {
  const dir = tmpDir();
  try {
    fragmentedMp4(path.join(dir, 'frag.mp4'));
    assert.equal(isFragmentedMp4(path.join(dir, 'frag.mp4')), true);
    fs.writeFileSync(path.join(dir, 'plain.mp4'), Buffer.concat([makeBox('ftyp', Buffer.from('isom\0\0\0\0')), makeBox('moov', makeBox('mvhd', Buffer.alloc(100))), makeBox('mdat', Buffer.alloc(64))]));
    assert.equal(isFragmentedMp4(path.join(dir, 'plain.mp4')), false);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'hello');
    assert.equal(isFragmentedMp4(path.join(dir, 'x.txt')), false);
    assert.equal(isFragmentedMp4(path.join(dir, 'missing.mp4')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('faststart: FFmpeg copies the streams with the index first; the result replaces the video', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'v.mp4');
  try {
    const size = fragmentedMp4(file);
    let args;
    const ffmpeg = { run: async (a) => { args = a; fs.writeFileSync(a[a.length - 1], Buffer.alloc(size + 100, 1)); } };
    assert.deepEqual(await makeFaststart(file, ffmpeg), { ok: true, size: size + 100 });
    assert.deepEqual(args, ['-i', file, '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', file + '.faststart.part']);
    assert.equal(fs.statSync(file).size, size + 100);
    assert.ok(!fs.existsSync(file + '.faststart.part'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('faststart: when FFmpeg fails or its file is too small, the video stays as it was', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'v.mp4');
  try {
    const size = fragmentedMp4(file);
    const original = fs.readFileSync(file);
    const failed = await makeFaststart(file, { run: async (a) => { fs.writeFileSync(a[a.length - 1], 'partial'); throw new Error('Invalid data'); } });
    assert.deepEqual(failed, { ok: false, error: 'Invalid data' });
    const small = await makeFaststart(file, { run: async (a) => fs.writeFileSync(a[a.length - 1], Buffer.alloc(Math.floor(size / 2))) });
    assert.equal(small.ok, false);
    assert.match(small.error, /too small/);
    assert.ok(fs.readFileSync(file).equals(original), 'original untouched');
    assert.ok(!fs.existsSync(file + '.faststart.part'), 'no leftover');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// With a real FFmpeg (NOVADM_TEST_FFMPEG=<path to ffmpeg.exe>): the result is a normal MP4, index first, same length.
test('faststart with the real FFmpeg', { skip: !process.env.NOVADM_TEST_FFMPEG && 'set NOVADM_TEST_FFMPEG to run' }, async () => {
  const { FFmpeg } = require('../src/main/ffmpeg');
  const dir = tmpDir();
  const file = path.join(dir, 'v.mp4');
  try {
    fragmentedMp4(file, 3);
    const ffmpeg = new FFmpeg({ settings: { get: (k) => (k === 'ffmpegPath' ? process.env.NOVADM_TEST_FFMPEG : undefined) }, userDataDir: dir });
    const r = await makeFaststart(file, ffmpeg);
    assert.equal(r.ok, true, r.error);
    const buf = fs.readFileSync(file);
    const top = readBoxes(buf).map((b) => b.type);
    assert.ok(!top.includes('moof') && top.indexOf('moov') < top.indexOf('mdat'), 'normal MP4, index first: ' + top.join(','));
    assert.equal(isFragmentedMp4(file), false);
    const moov = readBoxes(buf).find((b) => b.type === 'moov');
    const mvhd = child(buf, moov, 'mvhd');
    const v1 = buf[mvhd.start + mvhd.header] === 1;
    const scale = buf.readUInt32BE(mvhd.start + mvhd.header + (v1 ? 20 : 12));
    const dur = v1 ? Number(buf.readBigUInt64BE(mvhd.start + mvhd.header + 24)) : buf.readUInt32BE(mvhd.start + mvhd.header + 16);
    assert.ok(Math.abs(dur / scale - 30) < 1.5, `length ${dur / scale} s`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
