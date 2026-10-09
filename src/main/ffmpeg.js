'use strict';
// FFmpeg on demand. NovaDM works without it; it is only needed to join picture and sound that come
// as plain MP4 or WebM files, to save a video's sound, and to repair a damaged video. The user
// installs it from Settings → Add-ons: the official build list (BtbN/FFmpeg-Builds on GitHub)
// gives the newest stable LGPL "shared" build and its SHA-256; the download is verified before it
// is unpacked (with Windows' own tar.exe). Or the user picks an ffmpeg.exe they already have.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const RELEASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/';
const SUMS_URL = RELEASE + 'checksums.sha256';

/** From the checksum list: the newest stable win64 LGPL shared build { name, sha256 } (master as fallback). */
function pickBuild(sums) {
  const rows = String(sums || '').split(/\r?\n/).map((l) => /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(l.trim())).filter(Boolean).map((m) => ({ sha256: m[1].toLowerCase(), name: m[2] }));
  const stable = rows.filter((r) => /^ffmpeg-n(\d+)\.(\d+)(?:\.(\d+))?-latest-win64-lgpl-shared-[\d.]+\.zip$/.test(r.name));
  const ver = (n) => (/^ffmpeg-n(\d+)\.(\d+)(?:\.(\d+))?/.exec(n) || []).slice(1).map((x) => Number(x) || 0);
  stable.sort((a, b) => { const va = ver(a.name); const vb = ver(b.name); for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return vb[i] - va[i]; return 0; });
  return stable[0] || rows.find((r) => r.name === 'ffmpeg-master-latest-win64-lgpl-shared.zip') || null;
}

/** "time=00:01:02.50" in FFmpeg's progress output, in seconds. */
function parseTime(line) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

class FFmpeg {
  /** ctx: { settings, userDataDir, download(url, savePath, onProgress) => Promise, fetchText(url) => Promise<string>, run (tests) } */
  constructor(ctx) {
    this.settings = ctx.settings;
    this.dir = path.join(ctx.userDataDir, 'tools', 'ffmpeg');
    this.download = ctx.download;
    this.fetchText = ctx.fetchText;
    this.runner = ctx.run || null;
    this.versionCache = null;
    this.installing = null;
  }

  exe() {
    const custom = this.settings.get('ffmpegPath');
    if (custom && fs.existsSync(custom)) return custom;
    const own = path.join(this.dir, 'bin', 'ffmpeg.exe');
    return fs.existsSync(own) ? own : '';
  }

  available() { return !!(this.runner || this.exe()); }

  async status() {
    const exe = this.exe();
    if (!exe) return { installed: false, path: '', version: '', installing: !!this.installing };
    if (!this.versionCache || this.versionCache.exe !== exe) {
      // A file that isn't a working program can fail right away instead of through the callback.
      const version = await new Promise((resolve) => {
        try {
          execFile(exe, ['-hide_banner', '-version'], { windowsHide: true, timeout: 15000 }, (err, out) => {
            resolve(err ? '' : (/ffmpeg version (\S+)/.exec(out || '') || [])[1] || 'unknown');
          });
        } catch {
          resolve('');
        }
      });
      this.versionCache = { exe, version };
    }
    return { installed: !!this.versionCache.version, path: exe, version: this.versionCache.version, custom: exe !== path.join(this.dir, 'bin', 'ffmpeg.exe'), installing: !!this.installing };
  }

  /** Download, verify and unpack the official build. onProgress({ phase, received, size }). */
  install(onProgress = () => {}) {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      onProgress({ phase: 'checking' });
      const build = pickBuild(await this.fetchText(SUMS_URL));
      if (!build) throw new Error('Could not find an FFmpeg build for Windows in the official list');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-ffmpeg-'));
      try {
        const zip = path.join(tmp, build.name);
        await this.download(RELEASE + build.name, zip, (p) => onProgress({ phase: 'downloading', ...p }));
        onProgress({ phase: 'verifying' });
        const sha = await new Promise((resolve, reject) => {
          const h = crypto.createHash('sha256');
          fs.createReadStream(zip).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
        });
        if (sha !== build.sha256) throw new Error('The download did not match its published checksum; nothing was installed');
        onProgress({ phase: 'unpacking' });
        const out = path.join(tmp, 'x');
        fs.mkdirSync(out);
        const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        await new Promise((resolve, reject) => execFile(tar, ['-xf', zip, '-C', out], { windowsHide: true, timeout: 300000 }, (err) => (err ? reject(new Error('Could not unpack FFmpeg: ' + err.message)) : resolve())));
        const top = fs.readdirSync(out).map((d) => path.join(out, d)).find((d) => fs.existsSync(path.join(d, 'bin', 'ffmpeg.exe')));
        if (!top) throw new Error('ffmpeg.exe was not in the download');
        fs.rmSync(this.dir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(this.dir), { recursive: true });
        fs.cpSync(path.join(top, 'bin'), path.join(this.dir, 'bin'), { recursive: true });
        for (const f of ['LICENSE.txt']) { try { fs.copyFileSync(path.join(top, f), path.join(this.dir, f)); } catch {} }
        this.versionCache = null;
        onProgress({ phase: 'done' });
        return this.status();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    })().finally(() => { this.installing = null; });
    return this.installing;
  }

  uninstall() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.versionCache = null;
  }

  /** Run FFmpeg. onProgress(seconds done). Resolves when it exits 0, rejects with its last error line. */
  run(args, { onProgress } = {}) {
    if (this.runner) return this.runner(args, { onProgress });
    const exe = this.exe();
    if (!exe) { const e = new Error('FFmpeg is not installed (Settings → Add-ons)'); e.code = 'NEEDS_FFMPEG'; return Promise.reject(e); }
    return new Promise((resolve, reject) => {
      const p = spawn(exe, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
      let tail = '';
      p.stderr.on('data', (d) => {
        const s = d.toString();
        tail = (tail + s).slice(-2000);
        const t = parseTime(s);
        if (t != null && onProgress) onProgress(t);
      });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0) return resolve();
        const last = tail.trim().split(/\r?\n/).filter(Boolean).pop() || `FFmpeg stopped (code ${code})`;
        reject(new Error(last));
      });
    });
  }

  /** Join a video file and an audio file without re-encoding. */
  merge(video, audio, out, opts) {
    return this.run(['-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', out], opts);
  }

  /** The sound of a video: copied as it is (.m4a for AAC) or converted to MP3. */
  extractAudio(input, out, { mp3 = false, ...opts } = {}) {
    return this.run(['-i', input, '-vn', ...(mp3 ? ['-c:a', 'libmp3lame', '-q:a', '2'] : ['-c:a', 'copy']), out], opts);
  }

  /** Rewrite a video into a fresh MP4 (fixes broken indexes and timestamps) without re-encoding. */
  repair(input, out, opts) {
    return this.run(['-fflags', '+genpts', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', out], opts);
  }
}

module.exports = { FFmpeg, pickBuild, parseTime, SUMS_URL };
