'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsonStore } = require('../src/main/store');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-store-'));

test('saves and reads back', () => {
  const file = path.join(tmpDir(), 'a.json');
  const s = new JsonStore(file, { n: 0 });
  s.data.n = 5; s.flush();
  assert.deepStrictEqual(new JsonStore(file, { n: 0 }).data, { n: 5 });
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
});

test('a refused rename (Windows EPERM) is retried, then written in place', () => {
  const file = path.join(tmpDir(), 'history.json');
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = () => { calls++; const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; };
  try {
    const s = new JsonStore(file, { visits: [] });
    s.data.visits.push('https://example.com/'); s.flush();
  } finally { fs.renameSync = real; }
  assert.ok(calls > 1, 'retried');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { visits: ['https://example.com/'] });
});

test('a rename that works on a retry', () => {
  const file = path.join(tmpDir(), 'b.json');
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = (a, b) => { if (++calls < 3) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return real(a, b); };
  try { const s = new JsonStore(file, { n: 0 }); s.data.n = 2; s.flush(); } finally { fs.renameSync = real; }
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2 });
});

test('history left only in the temp file (as in 1.5.1) is recovered at start-up', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'history.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ seq: 1, visits: [{ id: 1 }] }));
  const s = new JsonStore(file, { seq: 0, visits: [] });
  assert.deepStrictEqual(s.data, { seq: 1, visits: [{ id: 1 }] });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { seq: 1, visits: [{ id: 1 }] }); // repaired
  assert.strictEqual(fs.existsSync(file + '.tmp'), false);
});

test('a newer temp file wins over an older file; a broken temp file is ignored', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ v: 'old' }));
  fs.writeFileSync(file + '.tmp', JSON.stringify({ v: 'new' }));
  const past = new Date(Date.now() - 60e3);
  fs.utimesSync(file, past, past);
  assert.deepStrictEqual(new JsonStore(file, {}).data, { v: 'new' });

  fs.writeFileSync(file + '.tmp', '{"v": "half-writ');
  assert.deepStrictEqual(new JsonStore(file, {}).data, { v: 'new' });
});
