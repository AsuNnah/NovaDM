'use strict';
// HLS download: fetch the media playlist, download segments in parallel with bounded look-ahead,
// decrypt AES-128, convert TS to MP4 (or concatenate fMP4), and write the result in order.
// Progress is saved to <file>.part.meta, so a paused (or interrupted) download resumes from the
// last segment written instead of starting over.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const net = require('../net');
const hls = require('../media/hls');
const { TsToMp4 } = require('../media/transmux');
const { HttpError } = net;

const DEFAULT_WINDOW = 10; // segments downloaded ahead of the writer
const META_EVERY = 5; // save progress every N segments

class HlsDownload extends EventEmitter {
  /**
   * @param {object} opts
   *   id, savePath, playlistUrl, mirrors[], headers, session, limiter,
   *   concurrency, retries, retryDelayMs, timeoutMs, convertTs (bool),
   *   openConn/fetchText (optional, for tests)
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.savePath = opts.savePath;
    this.partPath = opts.savePath + '.part';
    this.metaPath = opts.savePath + '.part.meta';
    this.playlistUrl = opts.playlistUrl;
    this.mirrors = opts.mirrors || [];
    this.headers = opts.headers || {};
    this.session = opts.session;
    this.limiter = opts.limiter;
    this.concurrency = Math.min(16, Math.max(1, opts.concurrency || 6));
    this.window = Math.max(this.concurrency, opts.window || DEFAULT_WINDOW);
    this.retries = opts.retries ?? 10;
    this.retryDelayMs = opts.retryDelayMs ?? 3000;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.convertTs = opts.convertTs !== false;
    this.open = opts.openConn || net.open;
    this._fetchText = opts.fetchText;

    this.state = 'queued';
    this.error = null;
    this.segments = [];
    this.totalSegments = 0;
    this.doneSegments = 0;
    this.receivedBytes = 0;
    this.writtenBytes = 0;
    this.sizeEstimate = opts.sizeEstimate || -1;
    this.live = false;
    this.resumed = false;
    this._stopping = false;
    this._keyCache = new Map();
    this._ready = new Map(); // index -> Buffer (decrypted segment awaiting write)
    this._nextWrite = 0;
    this._nextFetch = 0;
    this._lastEmit = 0;
    this._speed = [];
    this._out = null;
    this._tx = null;
    this._container = null; // 'ts' (converted) | 'fmp4' | 'raw'
    this._mapWritten = false;
    this._resolveWriter = null;
    this._writing = false;
    this._writerIdle = Promise.resolve();
  }

  srcFor(url) {
    // The same segment path on each known mirror host.
    if (!this.mirrors.length) return [url];
    const urls = [url];
    try {
      const u = new URL(url);
      for (const m of this.mirrors) {
        try { const mu = new URL(m); urls.push(u.protocol + '//' + mu.host + u.pathname + u.search); } catch {}
      }
    } catch {}
    return urls;
  }

  async start() {
    if (this.state === 'downloading') return;
    this._stopping = false;
    this.state = 'downloading';
    this.emitUpdate(true);
    try {
      await this.loadPlaylist();
      if (this._stopping) return;
      fs.mkdirSync(path.dirname(this.savePath), { recursive: true });
      if (!this.tryResume()) {
        this._reset();
        this._out = fs.openSync(this.partPath, 'w');
      }
      this.emitUpdate(true);
      await this.download();
      if (this._stopping) return;
      this.finish();
    } catch (err) {
      if (!this._stopping) this.fail(err);
    }
  }

  async fetchText(url) {
    if (this._fetchText) return this._fetchText(url, { headers: this.headers });
    const r = await net.fetchText(url, { session: this.session, headers: this.headers, timeoutMs: this.timeoutMs });
    return { text: r.body.toString('utf8'), finalUrl: r.finalUrl };
  }

  async loadPlaylist() {
    const r = await this.fetchText(this.playlistUrl);
    let p = hls.parse(r.text, r.finalUrl || this.playlistUrl);
    if (p.type === 'master') {
      if (!p.variants.length) throw new Error('Empty master playlist');
      const best = p.variants[0];
      const r2 = await this.fetchText(best.url);
      p = hls.parse(r2.text, r2.finalUrl || best.url);
    }
    if (p.type !== 'media') throw new Error('Not a media playlist');
    if (p.encryption === 'drm') throw new Error('Stream is DRM-protected and cannot be downloaded');
    this.live = p.live;
    this.segments = p.segments;
    this.totalSegments = p.segments.length;
    if (!this.totalSegments) throw new Error('Playlist has no segments');
  }

  // Continue an earlier attempt: keep the bytes already written for whole segments.
  tryResume() {
    let m;
    try { m = JSON.parse(fs.readFileSync(this.metaPath, 'utf8')); } catch { return false; }
    if (!m || m.v !== 1 || this.live || m.totalSegments !== this.totalSegments || !(m.nextWrite > 0)) return false;
    let size = -1;
    try { size = fs.statSync(this.partPath).size; } catch { return false; }
    if (size < m.writtenBytes) return false;
    fs.truncateSync(this.partPath, m.writtenBytes);
    this._out = fs.openSync(this.partPath, 'a');
    this._nextWrite = this._nextFetch = this.doneSegments = m.nextWrite;
    this.writtenBytes = m.writtenBytes;
    this._container = m.container;
    this._mapWritten = !!m.mapWritten;
    if (this._container === 'ts') {
      const startSeconds = this.segments.slice(0, m.nextWrite).reduce((s, x) => s + (x.duration || 0), 0);
      this._tx = this.makeTx({ initWritten: true, startSeconds });
    }
    this.resumed = true;
    return true;
  }

  saveMeta() {
    if (this.live || !this._container) return;
    try {
      fs.writeFileSync(this.metaPath, JSON.stringify({
        v: 1, nextWrite: this._nextWrite, writtenBytes: this.writtenBytes, container: this._container,
        mapWritten: this._mapWritten, totalSegments: this.totalSegments,
      }));
    } catch {}
  }

  makeTx(opts) {
    return new TsToMp4((b) => { fs.writeSync(this._out, b); this.writtenBytes += b.length; }, opts);
  }

  async download() {
    // Writer promise resolves when all segments are written (or we stop).
    const writerDone = new Promise((res) => { this._resolveWriter = res; });
    if (this._nextWrite >= this.totalSegments) { this._resolveWriter(); this._resolveWriter = null; }
    const workers = [];
    for (let i = 0; i < this.concurrency; i++) workers.push(this.worker());
    await Promise.all(workers);
    if (!this._stopping && this.error) throw this.error;
    await writerDone;
    if (this.error) throw this.error;
  }

  async worker() {
    while (!this._stopping) {
      // Respect the look-ahead window so memory stays bounded.
      if (this._nextFetch - this._nextWrite >= this.window) { await this.sleep(20); continue; }
      const idx = this._nextFetch;
      if (idx >= this.totalSegments) return;
      this._nextFetch++;
      try {
        const buf = await this.fetchSegment(idx);
        if (this._stopping) return;
        this._ready.set(idx, buf);
        this.pumpWriter();
      } catch (err) {
        if (this._stopping) return;
        this.error = err;
        this.stop();
        return;
      }
    }
  }

  async fetchSegment(idx) {
    const seg = this.segments[idx];
    const urls = this.srcFor(seg.url);
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (this._stopping) throw new Error('stopped');
      const url = urls[attempt % urls.length];
      try {
        let data = await this.getBytes(url, seg.range);
        if (seg.key && seg.key.method === 'AES-128') data = await this.decrypt(seg, data);
        return data;
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && err.fatal && attempt >= urls.length - 1) throw err;
        await this.backoff(attempt);
      }
    }
    throw lastErr;
  }

  async getBytes(url, range) {
    const r = range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined;
    const conn = await this.open(url, { session: this.session, headers: { ...this.headers }, range: r, timeoutMs: this.timeoutMs });
    if (conn.status >= 400) { conn.abort(); throw new HttpError(conn.status); }
    return this.readLimited(conn);
  }

  readLimited(conn) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const stall = () => { conn.abort(); reject(new Error('stalled')); };
      let idle = setTimeout(stall, this.timeoutMs);
      conn.res.on('data', async (chunk) => {
        if (this._stopping) { conn.abort(); return; }
        if (this.limiter) {
          conn.res.pause();
          let off = 0;
          while (off < chunk.length) off += await this.limiter.take(Math.min(chunk.length - off, 64 * 1024));
          conn.res.resume();
        }
        clearTimeout(idle); idle = setTimeout(stall, this.timeoutMs);
        chunks.push(chunk);
        this.receivedBytes += chunk.length;
        this.sample(chunk.length);
        this.emitUpdate();
      });
      conn.res.on('end', () => { clearTimeout(idle); resolve(Buffer.concat(chunks)); });
      conn.res.on('error', (e) => { clearTimeout(idle); reject(e); });
      conn.res.on('aborted', () => { clearTimeout(idle); reject(new Error('aborted')); });
    });
  }

  async decrypt(seg, data) {
    let key = this._keyCache.get(seg.key.url);
    if (!key) {
      key = await this.getBytes(seg.key.url);
      if (key.length !== 16) throw new Error('Invalid AES-128 key length');
      this._keyCache.set(seg.key.url, key);
    }
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, hls.ivFor(seg));
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }

  pumpWriter() {
    if (this._writing) return;
    this._writing = true;
    this._writerIdle = new Promise((done) => queueMicrotask(() => this.drainWriter().finally(done)));
  }

  async drainWriter() {
    try {
      while (this._ready.has(this._nextWrite) && !this._stopping) {
        const idx = this._nextWrite;
        const buf = this._ready.get(idx);
        this._ready.delete(idx);
        await this.writeSegment(idx, buf);
        this._nextWrite++;
        this.doneSegments++;
        if (this._nextWrite % META_EVERY === 0) this.saveMeta();
        this.emitUpdate();
      }
    } catch (err) {
      this.error = err;
      this.stop();
    } finally {
      this._writing = false;
    }
    if (this._nextWrite >= this.totalSegments || this._stopping) {
      if (this._resolveWriter) { this._resolveWriter(); this._resolveWriter = null; }
    }
  }

  async writeSegment(idx, buf) {
    const seg = this.segments[idx];
    if (this._container === null) this.initContainer(buf, seg);
    if (this._container === 'ts') {
      this._tx.push(buf);
      this._tx.flushSegment(); // writes this segment's MP4 fragment now
      return;
    }
    // fMP4 or raw: write the init map once, then the segments as they are.
    if (this._container === 'fmp4' && !this._mapWritten && seg.map) {
      await this.writeOut(await this.getMap(seg.map));
      this._mapWritten = true;
    }
    await this.writeOut(buf);
  }

  initContainer(firstBuf, seg) {
    const kind = hls.sniffContainer(firstBuf);
    if (seg.map || kind === 'fmp4') { this._container = 'fmp4'; return; }
    if (kind === 'ts' && this.convertTs) {
      this._container = 'ts';
      this._tx = this.makeTx({});
      return;
    }
    this._container = 'raw'; // TS kept as .ts, or packed audio
  }

  async getMap(map) {
    const cacheKey = 'map:' + map.url + (map.range ? `:${map.range.offset}` : '');
    if (this._keyCache.has(cacheKey)) return this._keyCache.get(cacheKey);
    const bytes = await this.getBytes(map.url, map.range);
    this._keyCache.set(cacheKey, bytes);
    return bytes;
  }

  writeOut(buf) {
    return new Promise((resolve, reject) => {
      fs.write(this._out, buf, 0, buf.length, null, (err) => {
        if (err) return reject(err);
        this.writtenBytes += buf.length;
        resolve();
      });
    });
  }

  sample(bytes) {
    const now = Date.now();
    this._speed.push([now, bytes]);
    const cut = now - 3000;
    while (this._speed.length && this._speed[0][0] < cut) this._speed.shift();
  }

  speed() {
    if (this._speed.length < 2) return 0;
    const span = (Date.now() - this._speed[0][0]) / 1000;
    if (span <= 0) return 0;
    return Math.round(this._speed.reduce((s, x) => s + x[1], 0) / span);
  }

  async backoff(attempt) {
    await this.sleep(Math.min(this.retryDelayMs * Math.pow(1.6, attempt), 30000));
  }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  stop() {
    this._stopping = true;
    if (this._resolveWriter) { this._resolveWriter(); this._resolveWriter = null; }
  }

  /** Pause keeping progress. Resolves once the last write has finished and progress is saved. */
  async pause() {
    if (this.state !== 'downloading') return;
    this.stop();
    this.state = 'paused';
    await this._writerIdle;
    this.saveMeta();
    this.closeOut();
    this.emitUpdate(true);
  }

  async cancel() {
    this.stop();
    await this._writerIdle;
    this.closeOut();
    for (const f of [this.partPath, this.metaPath]) { try { fs.rmSync(f, { force: true }); } catch {} }
    this._reset();
    this.state = 'queued';
  }

  _reset() {
    this._ready.clear(); this._nextWrite = 0; this._nextFetch = 0;
    this.doneSegments = 0; this.receivedBytes = 0; this.writtenBytes = 0;
    this._container = null; this._tx = null; this._mapWritten = false;
  }

  finish() {
    try {
      if (this._container === 'ts' && this._tx) this._tx.end();
      this.closeOut();
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
    this.saveMeta();
    this.closeOut();
    this.emit('error', err);
    this.emitUpdate(true);
  }

  closeOut() {
    if (this._out !== null) { try { fs.closeSync(this._out); } catch {} this._out = null; }
  }

  emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 300) return;
    this._lastEmit = now;
    this.emit('progress', this.progress());
  }

  progress() {
    const frac = this.totalSegments ? this.doneSegments / this.totalSegments : 0;
    let size = this.sizeEstimate;
    if (this.doneSegments > 4 && this.writtenBytes > 0) size = Math.round(this.writtenBytes / frac);
    return {
      id: this.id, state: this.state, size, sizeIsEstimate: this.doneSegments < this.totalSegments,
      received: this.writtenBytes, percent: frac * 100, resumable: !this.live,
      segments: this.totalSegments, doneSegments: this.doneSegments,
      speed: this.state === 'downloading' ? this.speed() : 0,
      error: this.error ? String(this.error.message || this.error) : null,
    };
  }
}

module.exports = { HlsDownload };
