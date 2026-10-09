'use strict';
// Multi-part HTTP download: splits a file into parallel connections over mirrors, writes each
// range in place into a single .part file, supports pause/resume, retries and dynamic splitting.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const net = require('../net');
const { HttpError } = net;

const MIN_PART = 512 * 1024; // don't split below this

class HttpDownload extends EventEmitter {
  /**
   * @param {object} opts
   *   id, savePath, sources [url, ...] (first is primary; rest are mirrors), headers,
   *   session, connections, limiter, retries, retryDelayMs, timeoutMs, size (optional known size)
   *   openConn (optional, for tests) => net.open-compatible
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.savePath = opts.savePath;
    this.partPath = opts.savePath + '.part';
    this.metaPath = opts.savePath + '.part.meta';
    this.sources = opts.sources && opts.sources.length ? opts.sources.slice() : [opts.url];
    this.headers = opts.headers || {};
    this.session = opts.session;
    this.connections = Math.min(32, Math.max(1, opts.connections || 8));
    this.limiter = opts.limiter;
    this.retries = opts.retries ?? 10;
    this.retryDelayMs = opts.retryDelayMs ?? 3000;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.open = opts.openConn || net.open;
    this.allowRename = !!opts.allowRename;

    this.size = opts.size ?? -1;
    this.resumable = false;
    this.received = 0;
    this.state = 'queued'; // queued | connecting | downloading | paused | done | error
    this.error = null;
    this.segments = []; // { start, end, pos } half-open [start, end)
    this.active = new Map(); // segIndex -> connection controller
    this.fd = null;
    this._stopping = false;
    this._srcIdx = 0;
    this._lastEmit = 0;
    this._speedSamples = [];
  }

  nextSource() {
    const u = this.sources[this._srcIdx % this.sources.length];
    this._srcIdx++;
    return u;
  }

  async start() {
    if (this.state === 'downloading' || this.state === 'connecting') return;
    this._stopping = false;
    this.state = 'connecting';
    this.emitUpdate(true);
    try {
      await this.prepare();
      if (this._stopping) return;
      this.state = 'downloading';
      await this.run();
    } catch (err) {
      if (this._stopping) return;
      this.fail(err);
    }
  }

  async prepare() {
    fs.mkdirSync(path.dirname(this.savePath), { recursive: true });
    // Resume from an earlier attempt if metadata matches.
    if (this.loadMeta()) {
      this.fd = fs.openSync(this.partPath, 'r+');
      return;
    }
    const info = await this.probePrimary();
    this.size = info.size;
    this.resumable = info.resumable;
    this.applyServerName(info);
    this.fd = fs.openSync(this.partPath, 'w');
    if (this.size > 0) {
      try { fs.ftruncateSync(this.fd, this.size); } catch {}
    }
    if (this.resumable && this.size > MIN_PART * 2) {
      const n = Math.min(this.connections, Math.max(1, Math.floor(this.size / MIN_PART)));
      const chunk = Math.floor(this.size / n);
      for (let i = 0; i < n; i++) {
        const start = i * chunk;
        const end = i === n - 1 ? this.size : start + chunk;
        this.segments.push({ start, end, pos: start });
      }
    } else {
      this.segments.push({ start: 0, end: this.size > 0 ? this.size : Infinity, pos: 0 });
    }
    this.saveMeta();
  }

  async probePrimary() {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (this._stopping) throw new Error('stopped');
      try {
        return await this.probeOnce(this.sources[0]);
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && err.fatal) throw err;
        await this.backoff(attempt);
      }
    }
    throw lastErr;
  }

  // Headers-only probe via a 1-byte range request, using the injected connection opener.
  async probeOnce(url) {
    const conn = await this.open(url, { session: this.session, headers: this.headers, range: 'bytes=0-0', timeoutMs: this.timeoutMs });
    conn.abort();
    if (conn.status >= 400) throw new HttpError(conn.status);
    const h = conn.headers || {};
    const cr = /bytes\s+\d+-\d+\/(\d+)/i.exec(h['content-range'] || '');
    let size = -1;
    let resumable = false;
    if (conn.status === 206 && cr) { size = Number(cr[1]); resumable = true; }
    else if (h['content-length'] && conn.status === 200) size = Number(h['content-length']);
    if (!resumable && /\bbytes\b/i.test(h['accept-ranges'] || '') && size > 0) resumable = true;
    return {
      size, resumable, finalUrl: conn.finalUrl,
      mime: (h['content-type'] || '').split(';')[0].trim().toLowerCase(),
      disposition: h['content-disposition'] || '',
    };
  }

  // When the name was guessed from the URL, prefer the server's filename and add a missing extension.
  applyServerName(info) {
    if (!this.allowRename) return;
    const util = require('../util');
    const dir = path.dirname(this.savePath);
    let name = path.basename(this.savePath);
    const fromServer = util.filenameFromDisposition(info.disposition);
    if (fromServer) name = util.sanitizeFilename(fromServer, name);
    if (!util.extOf(name)) name = util.ensureExt(name, info.mime);
    const target = path.join(dir, name);
    if (target === this.savePath) return;
    this.setSavePath(util.uniquePath(target));
    this.emit('renamed', this.savePath);
  }

  setSavePath(p) {
    this.savePath = p;
    this.partPath = p + '.part';
    this.metaPath = p + '.part.meta';
  }

  async run() {
    const pump = [];
    const launch = () => {
      while (this.active.size < this.connections) {
        const idx = this.pickSegment();
        if (idx < 0) break;
        pump.push(this.downloadSegment(idx));
      }
    };
    launch();
    this._relaunch = launch;
    await Promise.all(pump);
    // Drain any segments added by dynamic splitting after the first wave.
    while (!this._stopping && this.hasUnfinished()) {
      const more = [];
      let idx;
      while (this.active.size < this.connections && (idx = this.pickSegment()) >= 0) more.push(this.downloadSegment(idx));
      if (!more.length) break;
      await Promise.all(more);
    }
    if (this._stopping) return;
    if (this.hasUnfinished()) throw this.error || new Error('Download incomplete');
    this.finish();
  }

  pickSegment() {
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (!this.active.has(i) && s.pos < s.end) return i;
    }
    // All remaining segments are being worked on: split the one with most bytes left.
    if (this.resumable && this.active.size < this.connections) {
      let bestIdx = -1; let bestRem = MIN_PART * 2;
      for (const [i, ctrl] of this.active) {
        const s = this.segments[i];
        const rem = s.end - Math.max(s.pos, ctrl.pos || s.pos);
        if (rem > bestRem) { bestRem = rem; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        const s = this.segments[bestIdx];
        const ctrl = this.active.get(bestIdx);
        const from = Math.max(s.pos, ctrl.pos || s.pos);
        const mid = from + Math.floor((s.end - from) / 2);
        const newSeg = { start: mid, end: s.end, pos: mid };
        s.end = mid;
        ctrl.end = mid;
        this.segments.push(newSeg);
        return this.segments.length - 1;
      }
    }
    return -1;
  }

  async downloadSegment(idx) {
    const seg = this.segments[idx];
    const ctrl = { pos: seg.pos, end: seg.end, abort: null };
    this.active.set(idx, ctrl);
    let attempt = 0;
    try {
      while (seg.pos < seg.end && !this._stopping) {
        try {
          await this.transfer(idx, seg, ctrl);
          attempt = 0;
        } catch (err) {
          if (this._stopping) return;
          if (err instanceof HttpError && err.fatal) throw err;
          if (++attempt > this.retries) throw err;
          await this.backoff(attempt);
        }
      }
    } catch (err) {
      this.error = err;
      this.stopAll(false);
    } finally {
      this.active.delete(idx);
    }
  }

  transfer(idx, seg, ctrl) {
    return new Promise((resolve, reject) => {
      const url = this.nextSource();
      const useRange = this.resumable && seg.end !== Infinity;
      const range = useRange ? `bytes=${seg.pos}-${seg.end - 1}` : (seg.pos > 0 ? `bytes=${seg.pos}-` : undefined);
      let conn;
      let idle;
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { cleanup(); if (conn) conn.abort(); reject(new Error('stalled')); }, this.timeoutMs);
      };
      const cleanup = () => { clearTimeout(idle); ctrl.abort = null; };
      this.open(url, { session: this.session, headers: this.headers, range, timeoutMs: this.timeoutMs })
        .then((c) => {
          conn = c;
          ctrl.abort = () => c.abort();
          if (c.status >= 400) { cleanup(); c.abort(); return reject(new HttpError(c.status)); }
          if (useRange && c.status !== 206) {
            // Server ignored the range: only safe for the first segment from position 0.
            if (seg.start !== 0 || seg.pos !== 0) { cleanup(); c.abort(); return reject(new Error('range not supported')); }
            this.resumable = false;
          }
          resetIdle();
          c.res.on('data', async (chunk) => {
            if (this._stopping) { cleanup(); c.abort(); return; }
            c.res.pause();
            try {
              let off = 0;
              while (off < chunk.length && !this._stopping) {
                const want = chunk.length - off;
                const allow = this.limiter ? await this.limiter.take(Math.min(want, 64 * 1024)) : want;
                const slice = chunk.subarray(off, off + allow);
                let writeLen = slice.length;
                if (seg.end !== Infinity && seg.pos + writeLen > seg.end) writeLen = seg.end - seg.pos;
                if (writeLen <= 0) { cleanup(); c.abort(); return resolve(); }
                await this.writeAt(seg.pos, slice.subarray(0, writeLen));
                seg.pos += writeLen; ctrl.pos = seg.pos;
                this.received += writeLen;
                off += slice.length;
                this.sample(writeLen);
                this.emitUpdate();
                if (seg.pos >= seg.end) { cleanup(); c.abort(); return resolve(); }
              }
              resetIdle();
              if (!this._stopping) c.res.resume();
            } catch (err) {
              cleanup(); c.abort(); reject(err);
            }
          });
          c.res.on('end', () => {
            cleanup();
            if (seg.end === Infinity) { seg.end = seg.pos; this.size = this.received; resolve(); }
            else if (seg.pos >= seg.end) resolve();
            else reject(new Error('connection closed early'));
          });
          c.res.on('error', (err) => { cleanup(); reject(err); });
          c.res.on('aborted', () => { cleanup(); if (seg.pos < seg.end && !this._stopping) reject(new Error('aborted')); else resolve(); });
        })
        .catch((err) => { cleanup(); reject(err); });
    });
  }

  writeAt(pos, buf) {
    return new Promise((resolve, reject) => {
      fs.write(this.fd, buf, 0, buf.length, pos, (err) => (err ? reject(err) : resolve()));
    });
  }

  sample(bytes) {
    const now = Date.now();
    this._speedSamples.push([now, bytes]);
    const cutoff = now - 3000;
    while (this._speedSamples.length && this._speedSamples[0][0] < cutoff) this._speedSamples.shift();
  }

  speed() {
    if (this._speedSamples.length < 2) return 0;
    const span = (Date.now() - this._speedSamples[0][0]) / 1000;
    if (span <= 0) return 0;
    const total = this._speedSamples.reduce((s, x) => s + x[1], 0);
    return Math.round(total / span);
  }

  hasUnfinished() {
    return this.segments.some((s) => s.pos < s.end);
  }

  async backoff(attempt) {
    const ms = Math.min(this.retryDelayMs * Math.pow(1.6, attempt), 30000);
    await new Promise((r) => setTimeout(r, ms));
  }

  pause() {
    if (this.state !== 'downloading' && this.state !== 'connecting') return;
    this.state = 'paused';
    this.stopAll(true);
    this.saveMeta();
    this.emitUpdate(true);
  }

  stopAll(markStopping) {
    if (markStopping) this._stopping = true;
    for (const ctrl of this.active.values()) if (ctrl.abort) try { ctrl.abort(); } catch {}
  }

  cancel() {
    this._stopping = true;
    this.stopAll(true);
    this.closeFd();
    try { fs.rmSync(this.partPath, { force: true }); } catch {}
    try { fs.rmSync(this.metaPath, { force: true }); } catch {}
    this.state = 'queued';
  }

  finish() {
    this.closeFd();
    if (this.size > 0 && this.received < this.size) { this.fail(new Error('Incomplete download')); return; }
    try {
      if (this.size > 0) fs.truncateSync(this.partPath, this.size);
      fs.renameSync(this.partPath, this.savePath);
      fs.rmSync(this.metaPath, { force: true });
    } catch (err) { this.fail(err); return; }
    this.state = 'done';
    this.emit('done');
    this.emitUpdate(true);
  }

  fail(err) {
    this.error = err;
    this.state = 'error';
    this.closeFd();
    this.saveMeta();
    this.emit('error', err);
    this.emitUpdate(true);
  }

  closeFd() {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch {}; this.fd = null; }
  }

  saveMeta() {
    try {
      fs.writeFileSync(this.metaPath, JSON.stringify({
        v: 1, sources: this.sources, size: this.size, resumable: this.resumable,
        received: this.received, segments: this.segments.map((s) => ({ start: s.start, end: s.end === Infinity ? -1 : s.end, pos: s.pos })),
      }));
    } catch {}
  }

  loadMeta() {
    try {
      const m = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      if (m.v !== 1 || !fs.existsSync(this.partPath)) return false;
      if (m.size !== this.size && this.size > 0) return false;
      this.size = m.size; this.resumable = m.resumable; this.received = m.received;
      this.segments = m.segments.map((s) => ({ start: s.start, end: s.end === -1 ? Infinity : s.end, pos: s.pos }));
      return this.segments.length > 0;
    } catch {
      return false;
    }
  }

  emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 300) return;
    this._lastEmit = now;
    this.emit('progress', this.progress());
  }

  progress() {
    return {
      id: this.id, state: this.state, size: this.size, received: this.received,
      percent: this.size > 0 ? Math.min(100, (this.received / this.size) * 100) : 0,
      speed: this.state === 'downloading' ? this.speed() : 0, resumable: this.resumable,
      connections: this.active.size, error: this.error ? String(this.error.message || this.error) : null,
    };
  }
}

module.exports = { HttpDownload, MIN_PART };
