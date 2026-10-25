'use strict';
// 1.5.3: known security problems in add-on versions (installed and newest), from OSV.dev and the NVD.
const test = require('node:test');
const assert = require('node:assert');
const { addSecurity, lookupFor, pypiVersion } = require('../src/main/addon-vulns');

const nvdCve = (id, severity, match) => ({ cve: { id, metrics: { cvssMetricV31: [{ cvssData: { baseSeverity: severity } }] }, configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, ...match }] }] }] } });

/** Stand-ins for OSV.dev and the NVD. */
async function fake(url, opts = {}) {
  if (url.startsWith('https://api.osv.dev/')) {
    const q = JSON.parse(opts.body);
    const vulns = {
      'yt-dlp@2023.11.16': [{ id: 'GHSA-aaaa', aliases: ['CVE-2024-22423'], database_specific: { severity: 'HIGH' } }, { id: 'GHSA-bbbb', database_specific: { severity: 'LOW' } }, { id: 'GHSA-gone', withdrawn: '2025-01-01' }],
      'electron@30.0.0': [{ id: 'GHSA-cccc', aliases: ['CVE-2026-1'], database_specific: { severity: 'MODERATE' } }],
    }[`${q.package.name}@${q.version}`] || [];
    return { vulns };
  }
  if (url.startsWith('https://services.nvd.nist.gov/')) {
    const cpe = decodeURIComponent(url.split('virtualMatchString=')[1]);
    if (cpe === 'cpe:2.3:a:ffmpeg:ffmpeg:9.0.2') {
      return { vulnerabilities: [
        nvdCve('CVE-2025-25468', 'MEDIUM', { criteria: 'cpe:2.3:a:ffmpeg:ffmpeg:*:*:*:*:*:*:*:*', versionEndExcluding: '2025-01-13' }), // git-master dates: not a version range
        nvdCve('CVE-2026-0001', 'HIGH', { criteria: 'cpe:2.3:a:ffmpeg:ffmpeg:*:*:*:*:*:*:*:*', versionStartIncluding: '9.0', versionEndExcluding: '9.0.3' }),
        nvdCve('CVE-2026-0002', 'LOW', { criteria: 'cpe:2.3:a:ffmpeg:ffmpeg:*:*:*:*:*:*:*:*', versionEndExcluding: '8.1' }),
      ] };
    }
    if (cpe === 'cpe:2.3:a:aria2_project:aria2:1.33.0') return { vulnerabilities: [nvdCve('CVE-2019-3500', 'HIGH', { criteria: 'cpe:2.3:a:aria2_project:aria2:1.33.0:*:*:*:*:*:*:*' })] };
    return { vulnerabilities: [] };
  }
  throw new Error('unexpected ' + url);
}

test('versions are asked the way each database writes them; unknown versions are not asked', () => {
  assert.equal(pypiVersion('2026.08.19'), '2026.8.19');
  assert.ok(lookupFor('ytdlp', '2026.08.19') && lookupFor('electron', '44.7.0') && lookupFor('aria2', '1.37.0'));
  assert.ok(lookupFor('ffmpeg', 'n9.0.2-24-gfd5d616c29-20261009'), 'release build: 9.0.2');
  assert.equal(lookupFor('ffmpeg', '9.0'), null, 'only a branch: no exact version to ask about');
  assert.equal(lookupFor('ffmpeg', 'N-123456-gabcdef'), null, 'a development build has no release version');
});

test('installed and newest versions: problems found, most severe first; fixed in the newest', async () => {
  const items = await addSecurity([
    { id: 'ytdlp', name: 'yt-dlp', installed: '2023.11.16', latest: '2026.08.19' },
    { id: 'electron', name: 'Electron', installed: '30.0.0', latest: '44.7.0' },
    { id: 'aria2', name: 'aria2', installed: '1.33.0', latest: '1.37.0' },
    { id: 'ffmpeg', name: 'FFmpeg', installed: 'n9.0.2-24-gfd5d616c29', latest: '9.0' },
  ], fake);
  const by = Object.fromEntries(items.map((x) => [x.id, x.security]));
  assert.deepEqual(by.ytdlp, { source: 'OSV.dev', installed: [{ id: 'CVE-2024-22423', severity: 'HIGH' }, { id: 'GHSA-bbbb', severity: 'LOW' }], latest: [] }, 'withdrawn advisories left out');
  assert.deepEqual(by.electron, { source: 'OSV.dev', installed: [{ id: 'CVE-2026-1', severity: 'MODERATE' }], latest: [] });
  assert.deepEqual(by.aria2, { source: 'NVD', installed: [{ id: 'CVE-2019-3500', severity: 'HIGH' }], latest: [] });
  assert.deepEqual(by.ffmpeg, { source: 'NVD', installed: [{ id: 'CVE-2026-0001', severity: 'HIGH' }], latest: null }, 'date "ranges" and ranges that end earlier are ignored; the newest FFmpeg is a branch');
});

test('FFmpeg: when the installed release is the newest, the list says no release with a fix exists yet', async () => {
  const note = async (extra) => (await addSecurity([{ id: 'ffmpeg', name: 'FFmpeg', installed: 'n9.0.2-24-gfd5d616c29', latest: '9.0', ...extra }], fake))[0].security.note;
  assert.match(await note({ newestRelease: '9.0.2' }), /9\.0\.2 is still FFmpeg's newest release, so no release with a fix exists yet.*9\.0 branch can already contain fixes made after 9\.0\.2/);
  assert.match(await note({ newestRelease: '9.0.1' }), /no release with a fix/, 'a release older than the installed one cannot hold a fix either');
  assert.equal(await note({ newestRelease: '9.0.3' }), undefined, 'a newer release exists: updating is the answer');
  assert.equal(await note({}), undefined, 'newest release unknown: nothing said');
  const clean = await addSecurity([{ id: 'ffmpeg', installed: 'n9.1.0-3-gabc', latest: '9.1', newestRelease: '9.1.0' }], fake);
  assert.equal(clean[0].security.note, undefined, 'no problems listed: no note');
});

test('a database that fails is reported, the other add-ons still get their answer', async () => {
  const items = await addSecurity([
    { id: 'ytdlp', installed: '2023.11.16', latest: '2026.08.19' },
    { id: 'aria2', installed: '1.37.0', latest: '1.37.0' },
    { id: 'ffmpeg', error: 'offline' },
  ], async (url, opts) => { if (url.includes('nvd')) throw new Error('NVD answered 503'); return fake(url, opts); });
  assert.equal(items[0].security.installed.length, 2);
  assert.match(items[1].security.error, /503/);
  assert.equal(items[2].security, undefined, 'no versions: nothing asked');
});
