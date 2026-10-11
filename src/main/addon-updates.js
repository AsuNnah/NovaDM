'use strict';
// "Check for updates" (Settings → About) also checks the add-ons and the Electron NovaDM is built on:
// the newest version of each, whether NovaDM can update it, and a warning when that update is a
// version this NovaDM isn't tested with. It only reads release names from GitHub; nothing is
// installed here (the Update buttons use the add-ons' own checksum-verified installers).
const { pickBuild, SUMS_URL, TESTED_MAJOR: FFMPEG_TESTED } = require('./ffmpeg');
const { ARIA2 } = require('./torrent/aria2');

const API = 'https://api.github.com/repos/';
const ELECTRON_SUPPORTED_MAJORS = 3; // Electron fixes security bugs in its newest 3 major versions

/** The numbers in a version: "2026.09.30", "n9.0.2-24-g…", "release-1.37.0", "v44.7.0". */
const nums = (v) => ((/\d+(?:\.\d+)*/.exec(String(v || '')) || [''])[0]).split('.').filter(Boolean).map(Number);
/** 1 when a is newer than b, -1 when older, 0 when the same. */
function cmp(a, b) {
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
const major = (v) => nums(v)[0] || 0;
const branch = (v) => nums(v).slice(0, 2).join('.'); // FFmpeg 9.0, 9.1 …

/**
 * [{ id, name, installed, latest, update?, action?, args?, warn?, note?, error? }]
 * ctx: { ytdlp, ffmpeg, aria2, electron (version), fetchText(url) }
 */
async function check({ ytdlp, ffmpeg, aria2, electron, fetchText }) {
  const json = async (url) => JSON.parse(await fetchText(url));
  const latestTag = async (repo) => String((await json(`${API}${repo}/releases/latest`)).tag_name || '');
  const item = async (id, name, fn) => { try { return { id, name, ...(await fn()) }; } catch (e) { return { id, name, error: e.message }; } };

  return Promise.all([
    item('ytdlp', 'yt-dlp', async () => {
      const st = await ytdlp.status();
      const r = { installed: st.installed ? st.version : '', latest: await latestTag('yt-dlp/yt-dlp') };
      // NovaDM reads only yt-dlp's -J output, which stays the same; sites change, so newer is better.
      if (st.installed && cmp(r.latest, st.version) > 0) {
        r.update = true;
        if (st.custom) r.note = 'This is your own copy of yt-dlp: update it yourself.';
        else r.action = 'ytdlp.install';
      }
      return r;
    }),
    item('ffmpeg', 'FFmpeg', async () => {
      const st = await ffmpeg.status();
      const sums = await fetchText(SUMS_URL);
      const newest = pickBuild(sums);
      const tested = pickBuild(sums, FFMPEG_TESTED);
      const ver = (b) => (b ? (/^ffmpeg-n(\d+\.\d+(?:\.\d+)?)/.exec(b.name) || [])[1] || '' : '');
      const r = { installed: st.installed ? st.version : '', latest: ver(newest) };
      // The official builds are made again every day; only a new release (9.0 → 9.1) counts as an update.
      if (!st.installed || !/^n?\d+\.\d+/.test(st.version)) return r;
      if (st.custom) {
        if (r.latest && cmp(branch(r.latest), branch(st.version)) > 0) { r.update = true; r.note = 'This is your own copy of FFmpeg: update it yourself.'; }
        return r;
      }
      if (ver(tested) && cmp(branch(ver(tested)), branch(st.version)) > 0) {
        Object.assign(r, { latest: ver(tested), update: true, action: 'ffmpeg.install' });
      } else if (r.latest && cmp(branch(r.latest), branch(st.version)) > 0) {
        Object.assign(r, { update: true, action: 'ffmpeg.install', args: { newest: true } });
        r.warn = `This NovaDM is tested with FFmpeg ${FFMPEG_TESTED}. FFmpeg ${major(r.latest)} may change options NovaDM uses to join picture and sound, save sound and repair videos. Waiting for a NovaDM update is safer.`;
      }
      return r;
    }),
    item('aria2', 'aria2', async () => {
      const st = await aria2.status();
      const r = { installed: st.installed ? (st.version || ARIA2.version) : '', latest: (await latestTag('aria2/aria2')).replace(/^release-/, '') };
      if (cmp(r.latest, ARIA2.version) > 0) r.note = `aria2 ${r.latest} is out. NovaDM installs only aria2 ${ARIA2.version}, the version it has checked (aria2 publishes no checksums); a NovaDM update will bring the new one.`;
      return r;
    }),
    item('electron', 'Electron (built into NovaDM)', async () => {
      // /releases/latest can name a patch of an older major, so take the newest of the recent ones.
      const list = await json(`${API}electron/electron/releases?per_page=50`);
      const latest = (Array.isArray(list) ? list : []).filter((x) => !x.draft && !x.prerelease).map((x) => String(x.tag_name || '').replace(/^v/, ''))
        .filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => cmp(b, a))[0] || '';
      const r = { installed: electron, latest };
      if (latest && major(latest) - major(electron) >= ELECTRON_SUPPORTED_MAJORS) {
        r.warn = `Electron ${major(electron)} no longer gets security fixes (only the newest ${ELECTRON_SUPPORTED_MAJORS} major versions do). Update NovaDM when a new version is out.`;
      } else if (latest && cmp(latest, electron) > 0) {
        r.note = `Electron ${latest} is out. It is part of NovaDM and can't be updated on its own: a new major version needs changes in NovaDM, so it comes with a NovaDM update after testing.`;
      }
      return r;
    }),
  ]);
}

module.exports = { check, cmp };
