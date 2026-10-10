'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Aria2, ARIA2 } = require('../src/main/torrent/aria2');

test('aria2 install: a download that is not the official zip is refused', async () => {
  assert.match(ARIA2.sha256, /^[0-9a-f]{64}$/); // pinned
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-aria2-test-'));
  const aria2 = new Aria2({
    settings: { get: () => '' },
    userDataDir: dir,
    download: async (_url, dest) => fs.writeFileSync(dest, 'not the real aria2 zip'),
  });
  const phases = [];
  await assert.rejects(aria2.install((p) => phases.push(p.phase)), /did not match the expected checksum/);
  assert.ok(phases.includes('verifying') && !phases.includes('unpacking'));
  assert.ok(!fs.existsSync(path.join(dir, 'tools', 'aria2', 'aria2c.exe')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('update notice: only a newer, well-formed release, linking to this project', async () => {
  const { check, newer, LATEST } = require('../src/main/updates');
  assert.ok(newer('1.10.0', '1.9.3') && newer('2.0.0', '1.99.99') && !newer('1.4.0', '1.4.0') && !newer('1.3.9', '1.4.0'));
  const reply = (r) => async (url) => { assert.strictEqual(url, LATEST); return JSON.stringify(r); };
  assert.deepStrictEqual(await check('1.4.0', reply({ tag_name: 'v1.5.0', html_url: 'https://github.com/AsuNnah/NovaDM/releases/tag/v1.5.0' })), { version: '1.5.0', url: 'https://github.com/AsuNnah/NovaDM/releases/tag/v1.5.0' });
  assert.strictEqual(await check('1.4.0', reply({ tag_name: 'v1.4.0' })), null);
  assert.strictEqual(await check('1.4.0', reply({ tag_name: 'nightly' })), null);
  // A link elsewhere is never opened: the notice falls back to the project's releases page.
  assert.strictEqual((await check('1.4.0', reply({ tag_name: 'v9.0.0', html_url: 'https://evil.example/' }))).url, 'https://github.com/AsuNnah/NovaDM/releases/latest');
});
