'use strict';
// 1.5.3: memory overload protection rules, crash leftovers, capped session caches, store temp files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { underPressure, appMemoryBytes, cleanLeftovers, capSize } = require('../src/main/housekeeping');
const { JsonStore } = require('../src/main/store');

const GB = 1024 ** 3;

test('memory is short when the PC has under 10% free, or NovaDM uses over 40% of it', () => {
  assert.equal(underPressure({ freeBytes: 4 * GB, totalBytes: 16 * GB, appBytes: 2 * GB }), false);
  assert.equal(underPressure({ freeBytes: 1 * GB, totalBytes: 16 * GB, appBytes: 2 * GB }), true, 'PC low');
  assert.equal(underPressure({ freeBytes: 6 * GB, totalBytes: 16 * GB, appBytes: 7 * GB }), true, 'NovaDM heavy');
  assert.equal(underPressure({ freeBytes: 0, totalBytes: 0, appBytes: 0 }), false, 'unknown totals: do nothing');
  assert.equal(appMemoryBytes([{ memory: { workingSetSize: 1024 } }, { memory: { workingSetSize: 2048 } }, {}]), 3 * 1024 * 1024);
});

test('session caches keep at most their limit, dropping the oldest first', () => {
  const m = new Map();
  for (let i = 0; i < 1005; i++) { m.set('k' + i, i); capSize(m, 1000); }
  assert.equal(m.size, 1000);
  assert.ok(!m.has('k0') && m.has('k1004'));
  const s = new Set(['a', 'b', 'c']);
  capSize(s, 2);
  assert.deepEqual([...s], ['b', 'c']);
});

test('crash leftovers older than a day are removed; recent ones and other files stay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-hk-'));
  const tmp = path.join(root, 'tmp'); const ud = path.join(root, 'ud');
  fs.mkdirSync(tmp); fs.mkdirSync(ud);
  const old = Date.now() - 3 * 24 * 3600 * 1000;
  const mk = (p, isDir, t) => { if (isDir) fs.mkdirSync(p); else fs.writeFileSync(p, 'x'); if (t) fs.utimesSync(p, t / 1000, t / 1000); };
  try {
    mk(path.join(tmp, 'novadm-ffmpeg-abc'), true, old);
    mk(path.join(tmp, 'novadm-ytdlp-new'), true, 0);
    mk(path.join(tmp, 'other-app-xyz'), true, old);
    mk(path.join(ud, 'cabc471c-68f3-4dcf-bd3b-53a1fee0ae2f.tmp'), false, old);
    mk(path.join(ud, 'history.json'), false, old);
    const removed = cleanLeftovers({ userDataDir: ud, tmpDir: tmp });
    assert.deepEqual(removed.sort(), ['cabc471c-68f3-4dcf-bd3b-53a1fee0ae2f.tmp', 'novadm-ffmpeg-abc']);
    assert.ok(fs.existsSync(path.join(tmp, 'novadm-ytdlp-new')) && fs.existsSync(path.join(tmp, 'other-app-xyz')) && fs.existsSync(path.join(ud, 'history.json')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a store removes a leftover temp file it does not need', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-store-'));
  const file = path.join(dir, 'x.json');
  try {
    fs.writeFileSync(file + '.tmp', JSON.stringify({ v: 'old' }));
    const t = (Date.now() - 60000) / 1000; fs.utimesSync(file + '.tmp', t, t);
    fs.writeFileSync(file, JSON.stringify({ v: 'current' }));
    const s = new JsonStore(file, {});
    assert.equal(s.data.v, 'current');
    assert.ok(!fs.existsSync(file + '.tmp'), 'older temp file removed');
    fs.writeFileSync(file + '.tmp', '{"v": "brok');
    assert.equal(new JsonStore(file, {}).data.v, 'current');
    assert.ok(!fs.existsSync(file + '.tmp'), 'broken temp file removed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
