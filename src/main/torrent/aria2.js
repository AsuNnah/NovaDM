'use strict';
// BitTorrent and magnet links through aria2 (the engine Motrix uses), run as a hidden helper:
//  - installed on demand from the official release (github.com/aria2/aria2) over HTTPS, or the
//    user's own aria2c.exe. aria2 publishes no checksums, so the zip's SHA-256 is pinned below and
//    every install is compared against it
//  - started with JSON-RPC on 127.0.0.1 only, a random port and a random secret; it exits with
//    NovaDM (--stop-with-process)
//  - DHT, peer exchange and local peer discovery on; an up-to-date public tracker list is added
//  - seeding stops at the user's ratio / time limit
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const ARIA2 = {
  version: '1.37.0',
  url: 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0-win-64bit-build1.zip',
  // SHA-256 of the official zip (2026-10-10: same as Scoop's aria2 manifest).
  sha256: '67d015301eef0b612191212d564c5bb0a14b5b9c4796b76454276a4d28d9b288',
};
const TRACKERS_URL = 'https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt';
const TRACKERS_MAX_AGE = 12 * 3600 * 1000;

class Aria2 extends EventEmitter {
  /** ctx: { settings, userDataDir, download(url, dest, onProgress), fetchText(url), spawn (tests), rpcPort/secret (tests) } */
  constructor(ctx) {
    super();
    this.settings = ctx.settings;
    this.dir = path.join(ctx.userDataDir, 'tools', 'aria2');
    this.stateDir = path.join(ctx.userDataDir, 'aria2');
    this.download = ctx.download;
    this.fetchText = ctx.fetchText;
    this.spawnFn = ctx.spawn || null;
    this.proc = null;
    this.port = ctx.rpcPort || 0;
    this.secret = ctx.secret || '';
    this.starting = null;
    this.installing = null;
    this.external = !!ctx.rpcPort; // tests: an RPC server that is already running
  }

  exe() {
    const custom = this.settings.get('aria2Path');
    if (custom && fs.existsSync(custom)) return custom;
    const own = path.join(this.dir, 'aria2c.exe');
    return fs.existsSync(own) ? own : '';
  }

  available() { return this.external || !!this.exe(); }

  async status() {
    const exe = this.exe();
    if (!exe && !this.external) return { installed: false, running: false, installing: !!this.installing };
    let version = '';
    if (this.proc || this.external) { try { version = (await this.call('getVersion')).version; } catch {} }
    if (!version && exe) {
      version = await new Promise((resolve) => {
        try { execFile(exe, ['--version'], { windowsHide: true, timeout: 10000 }, (err, out) => resolve(err ? '' : (/aria2 version (\S+)/.exec(out || '') || [])[1] || '')); } catch { resolve(''); }
      });
    }
    return { installed: !!version || this.external, version, running: !!this.proc || this.external, path: exe, custom: !!this.settings.get('aria2Path'), installing: !!this.installing, sha256: this.installedSha256 || '' };
  }

  install(onProgress = () => {}) {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-aria2-'));
      try {
        const zip = path.join(tmp, path.basename(ARIA2.url));
        await this.download(ARIA2.url, zip, (p) => onProgress({ phase: 'downloading', ...p }));
        onProgress({ phase: 'verifying' });
        const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
        if (sha !== ARIA2.sha256) throw new Error('The download did not match the expected checksum; nothing was installed');
        this.installedSha256 = sha; // shown in Settings, so it can be compared by hand
        onProgress({ phase: 'unpacking' });
        const out = path.join(tmp, 'x');
        fs.mkdirSync(out);
        const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
        await new Promise((resolve, reject) => execFile(tar, ['-xf', zip, '-C', out], { windowsHide: true }, (err) => (err ? reject(new Error('Could not unpack aria2: ' + err.message)) : resolve())));
        const found = findFile(out, 'aria2c.exe');
        if (!found) throw new Error('aria2c.exe was not in the download');
        fs.mkdirSync(this.dir, { recursive: true });
        fs.copyFileSync(found, path.join(this.dir, 'aria2c.exe'));
        for (const f of ['COPYING', 'README.html']) { const p = findFile(out, f); if (p) fs.copyFileSync(p, path.join(this.dir, f)); }
        onProgress({ phase: 'done' });
        return this.status();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    })().finally(() => { this.installing = null; });
    return this.installing;
  }

  uninstall() {
    this.stop();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  // ---- the aria2 process -------------------------------------------------------------------------

  /** Start aria2 if it isn't running. Resolves when its RPC answers. */
  start() {
    if (this.external || this.proc) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const exe = this.exe();
      if (!exe) { const e = new Error('aria2 is not installed (Settings → Add-ons)'); e.code = 'NEEDS_ARIA2'; throw e; }
      fs.mkdirSync(this.stateDir, { recursive: true });
      this.port = await freePort();
      this.secret = crypto.randomBytes(16).toString('hex');
      const trackers = await this.trackers().catch(() => []);
      const s = (k, d) => { const v = this.settings.get(k); return v == null ? d : v; };
      const args = [
        '--enable-rpc=true', `--rpc-listen-port=${this.port}`, '--rpc-listen-all=false', `--rpc-secret=${this.secret}`,
        `--stop-with-process=${process.pid}`, '--console-log-level=warn', '--summary-interval=0', '--quiet=true',
        '--continue=true', '--follow-torrent=mem', '--bt-save-metadata=false', '--pause-metadata=true',
        '--enable-dht=true', '--enable-dht6=true', `--dht-file-path=${path.join(this.stateDir, 'dht.dat')}`, `--dht-file-path6=${path.join(this.stateDir, 'dht6.dat')}`,
        '--bt-enable-lpd=true', '--enable-peer-exchange=true', '--bt-max-peers=128', '--bt-prioritize-piece=head=2M,tail=2M',
        `--seed-ratio=${Number(s('torrentSeedRatio', 1)) || 0}`, `--seed-time=${Number(s('torrentSeedMinutes', 60)) || 0}`,
        `--max-overall-upload-limit=${Math.max(0, Number(s('torrentUploadKBps', 0)) || 0)}K`,
        '--file-allocation=falloc', '--disk-cache=32M', '--max-concurrent-downloads=10',
        `--dir=${this.settings.get('downloadDir')}`,
      ];
      const port = Number(s('torrentPort', 0));
      if (port) args.push(`--listen-port=${port}`, `--dht-listen-port=${port}`);
      if (trackers.length) args.push(`--bt-tracker=${trackers.join(',')}`);
      const proc = (this.spawnFn || spawn)(exe, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = proc;
      let err = '';
      if (proc.stderr) proc.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
      proc.on('exit', (code) => {
        this.proc = null;
        this.emit('exit', code, err.trim());
      });
      for (let i = 0; i < 50; i++) {
        try { await this.call('getVersion'); return; } catch {}
        if (!this.proc) throw new Error('aria2 did not start: ' + (err.trim() || 'unknown error'));
        await sleep(100);
      }
      throw new Error('aria2 did not answer');
    })().finally(() => { this.starting = null; });
    return this.starting;
  }

  stop() {
    if (this.proc) {
      this.call('shutdown').catch(() => {});
      const p = this.proc;
      setTimeout(() => { try { p.kill(); } catch {} }, 3000);
      this.proc = null;
    }
  }

  /** Apply changed settings to the running aria2. */
  async applySettings() {
    if (!this.proc && !this.external) return;
    const s = (k, d) => { const v = this.settings.get(k); return v == null ? d : v; };
    await this.call('changeGlobalOption', {
      'seed-ratio': String(Number(s('torrentSeedRatio', 1)) || 0), 'seed-time': String(Number(s('torrentSeedMinutes', 60)) || 0),
      'max-overall-upload-limit': `${Math.max(0, Number(s('torrentUploadKBps', 0)) || 0)}K`,
    }).catch(() => {});
  }

  // ---- RPC ---------------------------------------------------------------------------------------

  call(method, ...params) {
    const body = JSON.stringify({ jsonrpc: '2.0', id: crypto.randomBytes(4).toString('hex'), method: 'aria2.' + method, params: [`token:${this.secret}`, ...params] });
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: this.port, path: '/jsonrpc', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let j;
          try { j = JSON.parse(data); } catch { return reject(new Error('aria2 sent an unreadable answer')); }
          if (j.error) { const e = new Error(j.error.message || 'aria2 error'); e.code = 'ARIA2_' + j.error.code; return reject(e); }
          resolve(j.result);
        });
      });
      req.on('timeout', () => req.destroy(new Error('aria2 did not answer')));
      req.on('error', reject);
      req.end(body);
    });
  }

  // ---- public trackers ---------------------------------------------------------------------------

  /** The public tracker list (refreshed every 12 hours, kept on disk). */
  async trackers() {
    if (this.settings.get('torrentTrackerList') === false) return [];
    const file = path.join(this.stateDir, 'trackers.txt');
    let st = null;
    try { st = fs.statSync(file); } catch {}
    if (!st || Date.now() - st.mtimeMs > TRACKERS_MAX_AGE) {
      try {
        const text = await this.fetchText(TRACKERS_URL);
        const list = parseTrackers(text);
        if (list.length) { fs.mkdirSync(this.stateDir, { recursive: true }); fs.writeFileSync(file, list.join('\n')); }
      } catch {}
    }
    try { return parseTrackers(fs.readFileSync(file, 'utf8')); } catch { return []; }
  }
}

function parseTrackers(text) {
  return [...new Set(String(text || '').split(/\s+/).filter((u) => /^(udp|https?|wss?):\/\/[^\s,]+$/i.test(u)))].slice(0, 200);
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory()) { const f = findFile(p, name); if (f) return f; }
  }
  return '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = require('net').createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Aria2, ARIA2, parseTrackers };
