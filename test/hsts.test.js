'use strict';
// SEC-107 (1.8.0): sites that sent Strict-Transport-Security are remembered, and their certificate errors get no Proceed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Hsts, MAX } = require('../src/main/hsts');
const { Browser } = require('../src/main/browser');

test('SEC-107: remembered for max-age, sub-domains only with includeSubDomains, max-age=0 forgets, capped', () => {
  const h = new Hsts(null);
  const now = 1e12;
  h.note('a.test', 'max-age=100', now);
  h.note('b.test:443', 'max-age="100"; includeSubDomains', now);
  assert.ok(h.has('a.test', now) && !h.has('x.a.test', now), 'a.test only');
  assert.ok(h.has('b.test', now) && h.has('x.y.b.test', now), 'b.test and its sub-domains');
  assert.ok(!h.has('a.test', now + 101e3), 'expired');
  h.note('router', 'max-age=100', now);
  assert.ok(h.has('router', now), 'a one-word name too');
  h.note('a.test', 'max-age=0', now);
  assert.ok(!h.has('a.test', now));
  h.note('c.test', 'includeSubDomains', now);
  assert.ok(!h.has('c.test', now), 'no max-age, not remembered');
  for (let i = 0; i < MAX + 5; i++) h.note(`s${i}.test`, 'max-age=100', now);
  assert.strictEqual(Object.keys(h.hosts).length, MAX);
  assert.ok(!h.has('b.test', now) && h.has(`s${MAX + 4}.test`, now), 'the oldest go first');
});

test('SEC-107: normal windows keep hsts.json; clear() empties it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-hsts-'));
  const file = path.join(dir, 'hsts.json');
  const h = new Hsts(file);
  h.note('a.test', 'max-age=1000');
  h.store.flush();
  assert.ok(new Hsts(file).has('a.test'), 'read back after a restart');
  h.clear(); h.store.flush();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hosts: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SEC-107: no Proceed for an HSTS site; a header over an accepted bad certificate is ignored', () => {
  const b = { certSeen: new Map([['n|a.test', 'f1'], ['n|b.test', 'f2']]), certAllowed: new Set(['n|bad.test|f9']), hsts: { n: new Hsts(null), p: new Hsts(null) } };
  for (const k of ['noteHsts', 'hstsFor', 'certBypassed', 'allowCert']) b[k] = Browser.prototype[k].bind(b);
  b.noteHsts(false, { url: 'https://a.test/', responseHeaders: { 'Strict-Transport-Security': ['max-age=1000'] } });
  b.noteHsts(false, { url: 'https://bad.test/', responseHeaders: { 'strict-transport-security': ['max-age=1000'] } });
  b.noteHsts(false, { url: 'http://c.test/', responseHeaders: { 'strict-transport-security': ['max-age=1000'] } });
  assert.deepStrictEqual(Object.keys(b.hsts.n.hosts), ['a.test']);
  assert.strictEqual(b.allowCert({ incognito: false }, 'https://a.test/'), false, 'refused');
  assert.strictEqual(b.allowCert({ incognito: false }, 'https://b.test/'), true, 'a site without HSTS can still proceed');
  assert.strictEqual(b.hstsFor(true, 'https://a.test/'), false, 'private windows keep their own list');
});
