'use strict';
// 1.8.1 Hide your country: country profiles (REQ-312), fail closed (SEC-111).
const test = require('node:test');
const assert = require('node:assert');
const { cleanProfiles, activeProfile, acceptLanguage, COUNTRIES } = require('../src/main/country');
const { proxyConfig, proxyCredentials } = require('../src/main/proxy');

const good = { id: 'p1', name: 'Work VPN', country: 'US', type: 'socks5', server: 'proxy.example:1080', user: 'me', passEnc: 'enc', timeZone: 'America/New_York', lang: 'en-US' };
const fake = (data) => ({ get: (k) => data[k] });

test('REQ-312: profiles are checked; bad ones dropped', () => {
  const out = cleanProfiles([good, { ...good, id: 'p1' }, { ...good, id: 'p2', server: 'no-port' }, { ...good, id: 'p3', timeZone: 'Mars/Base' }, { ...good, id: 'p4', type: 'ftp', server: 'socks5://h.example:9' }, null]);
  assert.deepStrictEqual(out.map((p) => p.id), ['p1', 'p4']);
  assert.strictEqual(out[1].type, 'http');
  assert.strictEqual(out[1].server, 'h.example:9', 'a scheme typed in the address is dropped');
});

test('REQ-312: every country in the table has a valid time zone and language', () => {
  for (const [code, [, tz, lang]] of Object.entries(COUNTRIES)) {
    assert.match(code, /^[A-Z]{2}$/);
    assert.ok(cleanProfiles([{ ...good, timeZone: tz, lang }])[0].lang === lang, code);
  }
  assert.strictEqual(acceptLanguage('de-DE'), 'de-DE,de');
});

test('SEC-111: a profile on means its proxy only, with no direct fallback', () => {
  const data = { proxyMode: 'none', proxyProfiles: [good], proxyProfile: 'p1', proxyUser: 'other' };
  assert.deepStrictEqual(proxyConfig(fake(data)), { mode: 'fixed_servers', proxyRules: 'socks5://proxy.example:1080', proxyBypassRules: '<local>' });
  assert.strictEqual(activeProfile(fake(data)).name, 'Work VPN');
  assert.strictEqual(proxyCredentials(fake(data)).user, 'me', 'the profile\'s sign-in, not the normal proxy\'s');
  data.proxyProfile = 'gone';
  assert.deepStrictEqual(proxyConfig(fake(data)).proxyRules, 'http://127.0.0.1:9', 'a missing profile fails closed, never direct');
  data.proxyProfile = '';
  assert.deepStrictEqual(proxyConfig(fake(data)), { mode: 'direct' }, 'your connection: the normal settings');
});

test('REQ-312: saving keeps stored passwords; deleting the profile in use goes back to your connection', () => {
  const os = require('os'); const fs = require('fs'); const path = require('path'); const Module = require('module');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-prof-'));
  const id = require.resolve('electron'); const saved = require.cache[id];
  const m = new Module(id); m.exports = { app: { isPackaged: false, getPath: () => dir } }; m.loaded = true; require.cache[id] = m;
  let s;
  try { delete require.cache[require.resolve('../src/main/settings')]; s = new (require('../src/main/settings').Settings)(); } finally { if (saved) require.cache[id] = saved; else delete require.cache[id]; }
  s.set({ proxyProfiles: [good], proxyProfile: 'p1' });
  const page = s.all().proxyProfiles[0];
  assert.strictEqual(page.passEnc, undefined, 'the settings page never sees the encrypted password');
  assert.strictEqual(page.hasPassword, true);
  s.set({ proxyProfiles: [{ ...page, name: 'Renamed' }] });
  assert.strictEqual(s.get('proxyProfiles')[0].passEnc, 'enc', 'kept on save');
  s.set({ proxyProfiles: [] });
  assert.strictEqual(s.get('proxyProfile'), '');
});
