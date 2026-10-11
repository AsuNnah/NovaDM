'use strict';
// 1.4.5: "Check for updates" for the add-ons and Electron, the update preview (release notes since
// the installed version), FFmpeg installs staying on the tested major version, yt-dlp subtitles.
const test = require('node:test');
const assert = require('node:assert');
const { check, cmp } = require('../src/main/addon-updates');
const { cleanNotes, whatsNew } = require('../src/main/updates');
const { pickBuild, TESTED_MAJOR } = require('../src/main/ffmpeg');
const { ARIA2 } = require('../src/main/torrent/aria2');
const { choicesFrom } = require('../src/main/ytdlp');

const sums = (...versions) => versions.map((v, i) => `${String(i).repeat(64).slice(0, 64)}  ffmpeg-n${v}-latest-win64-lgpl-shared-${v}.zip`).join('\n');

/** GitHub stand-in: latest release tags per repo, Electron's release list, FFmpeg's checksum list. */
function github({ ytdlp = '2026.09.30', aria2 = 'release-1.37.0', electron = ['44.8.0', '45.2.0', '46.1.0'], ffmpeg = sums('9.0', '9.1') } = {}) {
  return async (url) => {
    if (url.includes('/yt-dlp/yt-dlp/releases/latest')) return JSON.stringify({ tag_name: ytdlp });
    if (url.includes('/aria2/aria2/releases/latest')) return JSON.stringify({ tag_name: aria2 });
    if (url.includes('/electron/electron/releases')) return JSON.stringify([...electron.map((v) => ({ tag_name: 'v' + v })), { tag_name: 'v99.0.0-alpha.1', prerelease: true }]);
    if (url.endsWith('checksums.sha256')) return ffmpeg;
    throw new Error('unexpected ' + url);
  };
}
const addons = ({ yt = { installed: true, version: '2026.08.19' }, ff = { installed: true, version: 'n9.0.2-24-gfd5d616c29-20261009' }, ar = { installed: true, version: '1.37.0' } } = {}) => ({
  ytdlp: { status: async () => yt }, ffmpeg: { status: async () => ff }, aria2: { status: async () => ar }, electron: '44.7.0',
});
const run = async (o = {}, g = {}) => Object.fromEntries((await check({ ...addons(o), fetchText: github(g) })).map((r) => [r.id, r]));

test('versions compare by their numbers, whatever their style', () => {
  assert.equal(cmp('2026.09.30', '2026.08.19'), 1);
  assert.equal(cmp('n9.0.2-24-gfd5d616c29', '9.0.2'), 0);
  assert.equal(cmp('release-1.37.0', '1.38.0'), -1);
  assert.equal(cmp('v44.7.0', '44.7'), 0);
});

test('add-ons: yt-dlp updates, FFmpeg stays on its tested major, aria2 and Electron only inform', async () => {
  const r = await run();
  assert.deepEqual([r.ytdlp.update, r.ytdlp.action, r.ytdlp.latest], [true, 'ytdlp.install', '2026.09.30']);
  assert.deepEqual([r.ffmpeg.update, r.ffmpeg.action, r.ffmpeg.args, r.ffmpeg.warn, r.ffmpeg.latest], [true, 'ffmpeg.install', undefined, undefined, '9.1']);
  assert.ok(!r.aria2.update && !r.aria2.action && !r.aria2.note, 'aria2 1.37.0 is the newest');
  assert.ok(!r.electron.warn && /46\.1\.0 is out/.test(r.electron.note) && !r.electron.action, 'a newer Electron comes with NovaDM');
});

test('a newer FFmpeg major than tested is offered only with a warning, as "newest"', async () => {
  const r = await run({ ff: { installed: true, version: `n${TESTED_MAJOR}.1.0-3-gabc` } }, { ffmpeg: sums(`${TESTED_MAJOR}.1`, `${TESTED_MAJOR + 1}.0`) });
  assert.equal(r.ffmpeg.latest, `${TESTED_MAJOR + 1}.0`);
  assert.deepEqual(r.ffmpeg.args, { newest: true });
  assert.match(r.ffmpeg.warn, new RegExp(`tested with FFmpeg ${TESTED_MAJOR}`));
  // A fresh install takes the tested major; "Update anyway" the newest.
  assert.match(pickBuild(sums(`${TESTED_MAJOR}.1`, `${TESTED_MAJOR + 1}.0`), TESTED_MAJOR).name, new RegExp(`-n${TESTED_MAJOR}\\.1-`));
  assert.match(pickBuild(sums(`${TESTED_MAJOR}.1`, `${TESTED_MAJOR + 1}.0`)).name, new RegExp(`-n${TESTED_MAJOR + 1}\\.0-`));
});

test('up to date, own copies, a newer aria2, an unsupported Electron, and a failed check', async () => {
  const same = await run({}, { ytdlp: '2026.08.19', ffmpeg: sums('9.0') });
  assert.ok(!same.ytdlp.update && !same.ffmpeg.update, 'nothing to update');
  const own = await run({ yt: { installed: true, version: '2026.08.19', custom: true }, ff: { installed: true, version: 'n9.0.2', custom: true } });
  assert.ok(own.ytdlp.update && !own.ytdlp.action && /your own copy/.test(own.ytdlp.note));
  assert.ok(own.ffmpeg.update && !own.ffmpeg.action && /your own copy/.test(own.ffmpeg.note));
  const later = await run({}, { aria2: 'release-1.38.0', electron: ['44.8.0', '47.0.0'] });
  assert.ok(/aria2 1\.38\.0 is out/.test(later.aria2.note) && !later.aria2.action, `only ${ARIA2.version} (checked) is installed`);
  assert.match(later.electron.warn, /no longer gets security fixes/);
  const broken = Object.fromEntries((await check({ ...addons(), fetchText: async () => { throw new Error('offline'); } })).map((x) => [x.id, x]));
  assert.deepEqual(Object.values(broken).map((x) => x.error), ['offline', 'offline', 'offline', 'offline']);
});

const BODY = [
  '### Fixed', '- **Downloaded videos showed the wrong length** (for example 13:15:21) and',
  '  seeking jumped around. See [the issue](https://example.com/1).', '', '### Added', '- About NovaDM on the `menu`.',
  '', '', 'The files are not code-signed yet, so Windows SmartScreen may warn.', '', '| File | SHA-256 |', '|---|---|', '| NovaDM-Setup.exe | `abc` |',
].join('\n');

test('update preview: release notes become plain text, without the checksum table', () => {
  assert.deepEqual(cleanNotes(BODY), [
    { title: 'Fixed', items: ['Downloaded videos showed the wrong length (for example 13:15:21) and seeking jumped around. See the issue.'] },
    { title: 'Added', items: ['About NovaDM on the menu.'] },
  ]);
});

test('update preview: every release newer than the installed one, newest first', async () => {
  const releases = [
    { tag_name: 'v1.4.3', body: BODY }, { tag_name: 'v1.4.5', body: BODY }, { tag_name: 'v1.4.4', body: BODY },
    { tag_name: 'v1.5.0', body: BODY, draft: true }, { tag_name: 'v1.4.6-beta', body: BODY, prerelease: true },
  ];
  const list = await whatsNew('1.4.3', async () => JSON.stringify(releases));
  assert.deepEqual(list.map((r) => r.version), ['1.4.5', '1.4.4']);
  assert.equal(list[0].sections[0].title, 'Fixed');
});

test('yt-dlp: subtitles are offered as VTT files named like the video', () => {
  const info = {
    title: 'Talk', webpage_url: 'https://example.com/v', language: 'ja', duration: 60,
    formats: [{ format_id: '18', protocol: 'https', url: 'https://example.com/v.mp4', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a' }],
    subtitles: {
      fr: [{ ext: 'json3', url: 'https://example.com/fr.json' }, { ext: 'vtt', url: 'https://example.com/fr.vtt', name: 'French' }],
      'en-US': [{ ext: 'vtt', url: 'https://example.com/en.vtt', name: 'English' }],
      live_chat: [{ ext: 'vtt', url: 'https://example.com/chat' }],
      de: [{ ext: 'srv3', url: 'https://example.com/de.xml' }],
    },
    automatic_captions: { 'ja-orig': [{ ext: 'vtt', url: 'https://example.com/ja.vtt', name: 'Japanese (Original)' }], ko: [{ ext: 'vtt', url: 'https://example.com/ko.vtt' }] },
  };
  const subs = choicesFrom(info).choices.filter((c) => c.label.startsWith('Subtitles'));
  assert.deepEqual(subs.map((c) => c.label), ['Subtitles: English (VTT)', 'Subtitles: French (VTT)', 'Subtitles: Japanese (automatic, VTT)']);
  assert.deepEqual(subs.map((c) => c.spec.name), ['Talk.en-US.vtt', 'Talk.fr.vtt', 'Talk.ja.vtt']);
  assert.ok(subs.every((c) => c.spec.kind === 'http' && c.spec.category === 'video'), 'saved in the video folder');
  assert.deepEqual(choicesFrom({ ...info, subtitles: undefined, automatic_captions: undefined }).choices.filter((c) => c.label.startsWith('Subtitles')), []);
});
