'use strict';
// tools/check-private.js --build reads the built app with the asar reader: a user folder in a packed file is found.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const asar = require('@electron/asar');

// The check also reads the git history, so it needs git (CI has it; a bare test machine may not).
const noGit = spawnSync('git', ['--version']).status !== 0 && 'needs git';

test('check-private --build finds a user folder inside the packed app, and passes a clean one', { skip: noGit }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-asar-'));
  const make = async (name, content) => {
    const src = path.join(dir, name); fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(src, 'lib', 'a.js'), content);
    await asar.createPackage(src, path.join(dir, name + '.asar'));
    return path.join(dir, name + '.asar');
  };
  const run = (a) => spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'check-private.js'), '--build', a], { encoding: 'utf8' });
  const dirty = run(await make('dirty', 'const p = "C:\\\\Users\\\\alicew\\\\AppData";'));
  assert.strictEqual(dirty.status, 1);
  assert.match(dirty.stdout, /app\.asar\/lib\/a\.js: C:\\\\Users\\\\alicew/);
  const clean = run(await make('clean', 'module.exports = 1;'));
  assert.strictEqual(clean.status, 0, clean.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
});
