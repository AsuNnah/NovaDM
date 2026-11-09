'use strict';
// SEC-105 / REQ-307 (1.8.0): with Strict only on, Secure DNS never falls back to the network's DNS; without it, the
// fallback is reported so the Guard button can show it.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

function loadDns(calls) {
  const id = require.resolve('electron');
  const saved = require.cache[id];
  const m = new Module(id); m.exports = { app: { configureHostResolver: (o) => calls.push(o.secureDnsMode) } }; m.loaded = true; require.cache[id] = m;
  try { delete require.cache[path.join(__dirname, '..', 'src', 'main', 'dns.js')]; return require('../src/main/dns'); } finally { if (saved) require.cache[id] = saved; else delete require.cache[id]; }
}
const settingsOf = (o) => ({ get: (k) => o[k] });

test('SEC-105, REQ-307: Strict only stays encrypted when the servers are down; otherwise the fallback is reported', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  const calls = [];
  const { applySecureDns } = loadDns(calls);

  global.fetch = async () => { throw new Error('unreachable'); };
  let s = await applySecureDns(settingsOf({ secureDns: 'cloudflare', secureDnsStrict: true }));
  assert.deepStrictEqual(calls, ['secure'], 'never switched to automatic');
  assert.strictEqual(s.mode, 'secure'); assert.strictEqual(s.unreachable, true); assert.match(s.note, /Strict only/);

  calls.length = 0;
  s = await applySecureDns(settingsOf({ secureDns: 'cloudflare', secureDnsStrict: false }));
  assert.deepStrictEqual(calls, ['secure', 'automatic']);
  assert.strictEqual(s.mode, 'automatic', 'the fallback the Guard button warns about');

  calls.length = 0;
  global.fetch = async () => ({ ok: true });
  s = await applySecureDns(settingsOf({ secureDns: 'cloudflare', secureDnsStrict: true }));
  assert.deepStrictEqual(calls, ['secure']);
  assert.strictEqual(s.mode, 'secure'); assert.ok(!s.unreachable);
});
