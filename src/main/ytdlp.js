'use strict';
// Optional yt-dlp add-on: finds the videos of 1,000+ sites that NovaDM's own detection can't see.
// Installed on demand from the official release (github.com/yt-dlp/yt-dlp), checked against the
// SHA-256 list published with it, or the user's own yt-dlp.exe. NovaDM only asks yt-dlp what a page
// offers (-J); the downloading itself is done by NovaDM's engines. Each site's terms apply.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const RELEASE = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/';

/** "1a2b...  yt-dlp.exe" lines -> sha256 of yt-dlp.exe, or ''. */
function shaFromList(text, name = 'yt-dlp.exe') {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return '';
}

/** Cookies (Electron's cookie objects) in the Netscape cookies.txt format yt-dlp reads. */
function netscapeCookies(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies || []) {
    const domain = c.domain || '';
    lines.push([
      domain, domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path || '/', c.secure ? 'TRUE' : 'FALSE',
      c.expirationDate ? Math.floor(c.expirationDate) : 0, c.name, c.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

const hasV = (f) => f.vcodec && f.vcodec !== 'none';
const hasA = (f) => f.acodec && f.acodec !== 'none';
const isHls = (f) => /m3u8/.test(f.protocol || '');
const isPlain = (f) => /^https?$/.test(f.protocol || '');
const sizeOf = (f) => f.filesize || f.filesize_approx || 0;

/**
 * yt-dlp's JSON (-J) -> what NovaDM can offer: { title, duration, choices: [{ label, spec }] }.
 * spec is a NovaDM download spec: http, hls, or merge (separate video + audio files).
 */
function choicesFrom(info) {
  const formats = (info.formats || []).filter((f) => f.url && !/^(mhtml|f4m|ism|rtmp)/.test(f.protocol || '') && !(f.has_drm));
  const headersOf = (f) => {
    const h = {};
    for (const [k, v] of Object.entries(f.http_headers || {})) if (typeof v === 'string' && !/^(user-agent|accept|accept-language|sec-)/i.test(k)) h[k.toLowerCase()] = v;
    return h;
  };
  const title = String(info.title || 'video').slice(0, 150);
  const out = [];
  const seen = new Set();
  const push = (label, spec, height) => { if (seen.has(label)) return; seen.add(label); out.push({ label, spec: { ...spec, pageUrl: info.webpage_url || '' }, height: height || 0 }); };
  // Complete files and streams (picture and sound together), best first.
  const combined = formats.filter((f) => hasV(f) && hasA(f) && (isPlain(f) || isHls(f))).sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0));
  for (const f of combined) {
    const label = `${f.height ? f.height + 'p' : f.format_note || f.format_id} ${isHls(f) ? 'stream' : (f.ext || '').toUpperCase()}`.trim();
    if (isHls(f)) push(label, { kind: 'hls', playlistUrl: f.url, headers: headersOf(f), name: `${title}.mp4`, category: 'video', meta: { duration: info.duration || 0, height: f.height || 0, width: f.width || 0 } }, f.height);
    else push(label, { kind: 'http', url: f.url, sources: [f.url], headers: headersOf(f), name: `${title}.${f.ext || 'mp4'}`, size: sizeOf(f) || -1, category: 'video' }, f.height);
  }
  // Best picture-only + best sound-only files, joined by NovaDM (MP4 first: no FFmpeg needed).
  const videos = formats.filter((f) => hasV(f) && !hasA(f) && isPlain(f)).sort((a, b) => (b.height || 0) - (a.height || 0) || ((a.ext === 'mp4') ? -1 : 1) || (b.tbr || 0) - (a.tbr || 0));
  const audios = formats.filter((f) => hasA(f) && !hasV(f) && isPlain(f)).sort((a, b) => ((a.ext === 'm4a') ? -1 : (b.ext === 'm4a') ? 1 : 0) || (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
  if (videos.length && audios.length) {
    const byHeight = new Map();
    for (const v of videos) if (!byHeight.has(v.height)) byHeight.set(v.height, v);
    for (const v of byHeight.values()) {
      const a = v.ext === 'mp4' ? (audios.find((x) => x.ext === 'm4a') || audios[0]) : (audios.find((x) => x.ext === 'webm') || audios[0]);
      push(`${v.height || '?'}p ${v.ext === 'mp4' && a.ext === 'm4a' ? 'MP4' : 'video'} (picture + sound)`, {
        kind: 'merge', name: `${title}.mp4`, category: 'video', size: (sizeOf(v) + sizeOf(a)) || -1,
        mergeSource: { type: 'direct', tracks: [{ kind: 'video', url: v.url, headers: headersOf(v), duration: info.duration || 0 }, { kind: 'audio', url: a.url, headers: headersOf(a), duration: info.duration || 0 }] },
        meta: { duration: info.duration || 0, height: v.height || 0, width: v.width || 0 },
      }, v.height);
    }
  }
  if (audios.length) {
    const a = audios[0];
    push(`Sound only (${(a.ext || '').toUpperCase()})`, { kind: 'http', url: a.url, sources: [a.url], headers: headersOf(a), name: `${title}.${a.ext || 'm4a'}`, size: sizeOf(a) || -1, category: 'music' }, -1);
  }
  out.sort((x, y) => y.height - x.height);
  return { title, duration: info.duration || 0, thumbnail: info.thumbnail || '', choices: out.slice(0, 12).map(({ label, spec }) => ({ label, spec })) };
}

class YtDlp {
  /** ctx: { settings, userDataDir, download(url, dest, onProgress), fetchText(url), run (tests) } */
  constructor(ctx) {
    this.settings = ctx.settings;
    this.dir = path.join(ctx.userDataDir, 'tools', 'yt-dlp');
    this.download = ctx.download;
    this.fetchText = ctx.fetchText;
    this.runner = ctx.run || null;
    this.installing = null;
  }

  exe() {
    const custom = this.settings.get('ytdlpPath');
    if (custom && fs.existsSync(custom)) return custom;
    const own = path.join(this.dir, 'yt-dlp.exe');
    return fs.existsSync(own) ? own : '';
  }

  available() { return !!(this.runner || this.exe()); }

  async status() {
    const exe = this.exe();
    if (!exe) return { installed: false, installing: !!this.installing };
    const version = await new Promise((resolve) => {
      try { execFile(exe, ['--version'], { windowsHide: true, timeout: 20000 }, (err, out) => resolve(err ? '' : String(out).trim())); } catch { resolve(''); }
    });
    return { installed: !!version, version, path: exe, custom: !!this.settings.get('ytdlpPath'), installing: !!this.installing };
  }

  install(onProgress = () => {}) {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      onProgress({ phase: 'checking' });
      const sha = shaFromList(await this.fetchText(RELEASE + 'SHA2-256SUMS'));
      if (!sha) throw new Error('Could not read the checksum list of the yt-dlp release');
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-ytdlp-'));
      try {
        const file = path.join(tmp, 'yt-dlp.exe');
        await this.download(RELEASE + 'yt-dlp.exe', file, (p) => onProgress({ phase: 'downloading', ...p }));
        onProgress({ phase: 'verifying' });
        const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        if (got !== sha) throw new Error('The download did not match its published checksum; nothing was installed');
        fs.mkdirSync(this.dir, { recursive: true });
        fs.copyFileSync(file, path.join(this.dir, 'yt-dlp.exe'));
        onProgress({ phase: 'done' });
        return this.status();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    })().finally(() => { this.installing = null; });
    return this.installing;
  }

  uninstall() { fs.rmSync(this.dir, { recursive: true, force: true }); }

  /** What yt-dlp finds on a page. cookies: Electron cookie objects for the page (stay on this PC). */
  async find(pageUrl, { cookies = [], referer = '' } = {}) {
    if (!/^https?:\/\//i.test(pageUrl)) throw new Error('Not a web page');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-ytdlp-'));
    const cookieFile = path.join(tmp, 'cookies.txt');
    try {
      const args = ['-J', '--no-playlist', '--no-warnings', '--skip-download', '--no-progress'];
      if (cookies.length) { fs.writeFileSync(cookieFile, netscapeCookies(cookies)); args.push('--cookies', cookieFile); }
      if (/^https?:/i.test(referer)) args.push('--referer', referer);
      args.push('--', pageUrl);
      const out = await this.run(args);
      return choicesFrom(JSON.parse(out));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true }); // the cookies never stay on disk
    }
  }

  run(args) {
    if (this.runner) return this.runner(args);
    const exe = this.exe();
    if (!exe) { const e = new Error('yt-dlp is not installed (Settings → Video tools)'); e.code = 'NEEDS_YTDLP'; return Promise.reject(e); }
    return new Promise((resolve, reject) => {
      execFile(exe, args, { windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err, out, errOut) => {
        if (err) {
          const line = String(errOut || err.message).trim().split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop() || String(errOut || err.message).trim().split(/\r?\n/).pop();
          return reject(new Error(String(line || 'yt-dlp failed').replace(/^ERROR:\s*/, '')));
        }
        resolve(out);
      });
    });
  }
}

module.exports = { YtDlp, choicesFrom, shaFromList, netscapeCookies };
