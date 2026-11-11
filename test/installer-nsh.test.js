'use strict';
// REQ-310 (1.8.0): the uninstaller removes NovaDM's link keys, never on an update, and magnet: only when it is
// NovaDM's. The real run is on the Windows VM; this keeps the script's rules from drifting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('REQ-310: uninstall removes novadm: (and NovaDM\'s own magnet:), not on update', () => {
  const nsh = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
  const m = /!macro customUnInstall([\s\S]*?)!macroend/.exec(nsh);
  assert.ok(m, 'customUnInstall macro');
  const body = m[1].trim().split('\n').map((l) => l.trim());
  assert.strictEqual(body[0], '${ifNot} ${isUpdated}', 'everything is skipped on an update');
  assert.strictEqual(body[body.length - 1], '${endIf}');
  assert.ok(body.includes('DeleteRegKey HKCU "Software\\Classes\\novadm"'));
  const magnet = body.indexOf('DeleteRegKey HKCU "Software\\Classes\\magnet"');
  assert.ok(magnet > 0 && body[magnet - 1] === `\${if} $0 == '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "%1"'`, 'magnet: only when its command is this NovaDM');
  assert.ok(!/HKLM/.test(m[1]), 'only the user\'s own keys');
  const pkg = require('../package.json');
  assert.strictEqual(pkg.build.nsis.include, 'build/installer.nsh');
});
