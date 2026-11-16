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
  assert.deepStrictEqual(proxyConfig(fake(data)), { mode: 'fixed_servers', proxyRules: 'socks5://proxy.example:1080', proxyBypassRules: '' }, 'no local-name bypass either');
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
  s.set({ proxyProfiles: [{ ...page, server: 'no-port' }] });
  assert.strictEqual(s.get('proxyProfile'), 'p1', 'a failed edit keeps the profile in use on');
  assert.strictEqual(s.get('proxyProfiles')[0].name, 'Renamed', 'and the saved profile unchanged');
  s.set({ proxyProfile: 'nope' });
  assert.strictEqual(s.get('proxyProfile'), 'p1', 'only a saved profile can be switched on');
  const { exportData } = require('../src/main/backup');
  const out = exportData({ settings: s, downloads: { records: new Map() }, version: 'x', includeDownloads: false }).settings;
  assert.ok(!('proxyProfile' in out) && out.proxyProfiles[0].passEnc === undefined, 'a backup carries no password and switches nothing on');
  s.set({ proxyProfiles: [] });
  assert.strictEqual(s.get('proxyProfile'), '');
});

test('SEC-111: yt-dlp gets the profile\'s proxy in its environment; none without a profile', () => {
  const { profileProxyEnv } = require('../src/main/proxy');
  const data = { proxyProfiles: [{ ...good, user: 'a b', passEnc: '' }], proxyProfile: 'p1' };
  const env = profileProxyEnv(fake(data));
  assert.strictEqual(env.https_proxy, 'socks5h://a%20b:@proxy.example:1080', 'names resolved at the proxy');
  assert.strictEqual(env.no_proxy, '', 'no host is let around the proxy');
  data.proxyProfile = '';
  assert.strictEqual(profileProxyEnv(fake(data)), null);
});

test('SEC-111: torrents refuse to start while a profile is on (peers would see the real address)', async () => {
  const { Aria2 } = require('../src/main/torrent/aria2');
  const a = new Aria2({ settings: fake({ proxyProfiles: [good], proxyProfile: 'p1' }), userDataDir: 'x' });
  await assert.rejects(a.start(), (e) => e.code === 'NOVADM_PROFILE' && /Work VPN/.test(e.message));
});

test('REQ-314: the check reads Cloudflare\'s trace and compares the country with the profile', async () => {
  const { checkRoute, parseTrace } = require('../src/main/country');
  assert.deepStrictEqual(parseTrace('fl=1\nip=203.0.113.7\nloc=NL\nts=1'), { ip: '203.0.113.7', country: 'NL' });
  assert.deepStrictEqual(parseTrace('ip=<script>\nloc=nl'), { ip: '', country: '' }, 'odd answers are not shown');
  const fetchFn = async () => ({ text: async () => 'ip=203.0.113.7\nloc=NL\n' });
  const de = { ...good, name: 'Home', country: 'DE', timeZone: 'Europe/Berlin', lang: 'de-DE' };
  const r = await checkRoute({ fetchFn, profile: de, webrtcPolicy: 'disable_non_proxied_udp', realTz: 'Asia/Jakarta', realLang: 'id-ID' });
  assert.deepStrictEqual([r.ip, r.country, r.countryMatches, r.timeZone, r.webrtcProtected, r.locationRefused], ['203.0.113.7', 'NL', false, 'Europe/Berlin', true, true]);
  const none = await checkRoute({ fetchFn: async () => { throw new Error('down'); }, profile: de, realTz: 'Asia/Jakarta' });
  assert.match(none.error, /No answer through "Home"/);
  const mine = await checkRoute({ fetchFn, profile: null, webrtcPolicy: 'default_public_interface_only', realTz: 'Asia/Jakarta', realLang: 'id-ID' });
  assert.deepStrictEqual([mine.countryMatches, mine.timeZone, mine.locationRefused], [null, 'Asia/Jakarta', false]);
});

test('SEC-111: a host the session sends through a proxy is not looked up here (the lookup would leak around it)', async () => {
  const { sessionLookup } = require('../src/main/netguard');
  let looked = 0;
  const ses = { resolveProxy: async () => 'PROXY proxy.example:1080', resolveHost: async () => { looked++; return { endpoints: [{ address: '10.0.0.1' }] }; } };
  assert.deepStrictEqual(await sessionLookup(ses)('a.example'), []);
  assert.strictEqual(looked, 0);
  ses.resolveProxy = async () => 'DIRECT';
  assert.deepStrictEqual(await sessionLookup(ses)('a.example'), [{ address: '10.0.0.1' }]);
});
