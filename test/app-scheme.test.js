'use strict';
// SEC-108 (1.8.0): NovaDM's own pages come from app://ui/, which serves only files inside src/ui and can't be framed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { uiUrl, fileFor, serve, isUiUrl } = require('../src/main/app-scheme');

test('SEC-108: app://ui serves only files inside the UI folder, not framable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-ui-'));
  fs.writeFileSync(path.join(root, 'settings.html'), '<p>ok</p>');
  fs.writeFileSync(path.join(path.dirname(root), 'novadm-secret.txt'), 'secret');

  const res = await serve({ url: 'app://ui/settings.html?private=1' }, root);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'text/html');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.strictEqual(await res.text(), '<p>ok</p>');

  for (const bad of ['app://ui/../novadm-secret.txt', 'app://ui/%2e%2e/novadm-secret.txt', 'app://ui/..%2fnovadm-secret.txt', 'app://ui/..%5cnovadm-secret.txt',
    'app://other/settings.html', 'file:///etc/passwd', 'app://ui/missing.html', 'app://ui/%E0%A4%A.html']) {
    assert.strictEqual((await serve({ url: bad }, root)).status, 404, bad);
  }
  assert.strictEqual(fileFor('app://ui/sub/x.js', root), path.join(root, 'sub', 'x.js'));

  assert.strictEqual(uiUrl('error.html', { u: 'https://a.test/?x=1&y', c: -200 }), 'app://ui/error.html?u=https%3A%2F%2Fa.test%2F%3Fx%3D1%26y&c=-200');
  assert.ok(isUiUrl('app://ui/history.html?private=1') && isUiUrl('app://ui/newtab.html'));
  assert.ok(!isUiUrl('app://ui/x.js') && !isUiUrl('app://uix/a.html') && !isUiUrl('https://ui/a.html'));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(path.dirname(root), 'novadm-secret.txt'), { force: true });
});
