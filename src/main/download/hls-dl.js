'use strict';
// HLS download: fetch the media playlist, download segments in parallel with bounded look-ahead,
// decrypt AES-128, convert TS to MP4 (or concatenate fMP4), and write the result in order.
//  - Parallel segment fetches start small and grow while total speed still rises (up to the
//    connection setting); 429/503 shrink them. On HTTP/1.1 servers more than 6 go through the
//    direct transport (Chromium allows only 6 per server).
//  - Live streams are recorded: the playlist is re-read and new segments are added until the user
//    stops the recording (or the stream ends); the file is finished and playable either way.
//  - Checkpoints: every 10 s / 32 MB the output is synced to disk, then progress is saved to
//    <file>.part.meta (never claims data that isn't on disk). AES keys are saved with it and the
//    media playlist is kept in <file>.part.m3u8, so a resume still works after the stream's
//    playlist or key links expire.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const net = require('../net');
const hls = require('../media/hls');
const { TsToMp4 } = require('../media/transmux');
const { HttpError } = net;

const DEFAULT_WINDOW = 10; // segments downloaded ahead of the writer
const CHECKPOINT_MS = 10000;
const CHECKPOINT_BYTES = 32 * 1024 * 1024;
const START_WORKERS = 3;
const TUNE_MS = 2000; // time to measure each growth step
const BROWSER_H1_CAP = 6;
const LIVE_START_SEGMENTS = 3; // a recording starts this close to the live edge

class HlsDownload extends EventEmitter {
  /**
   * @param {object} opts
   *   id, savePath, playlistUrl, mirrors[], headers, session, limiter, taskLimiter, transport,
   *   concurrency (max parallel segments), retries, retryDelayMs, timeoutMs, convertTs (bool),
   *   openConn/fetchText (optional, for tests), checkpointMs, checkpointBytes
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.savePath = opts.savePath;
    this.partPath = opts.savePath + '.part';
    this.metaPath = opts.savePath + '.part.meta';
    this.playlistCopyPath = opts.savePath + '.part.m3u8';
    this.playlistUrl = opts.playlistUrl;
    this.mirrors = opts.mirrors || [];
    this.headers = opts.headers || {};
    this.session = opts.session;
    this.limiter = opts.limiter;
    this.taskLimiter = opts.taskLimiter || null;
    this.transport = opts.transport || null;
    this.concurrency = Math.min(32, Math.max(1, opts.concurrency || 6));
    this.minWindow = opts.window || DEFAULT_WINDOW;
    this.target = Math.min(this.concurrency, START_WORKERS); // parallel fetches right now
    this.steady = this.target >= this.concurrency;
    this.flatSteps = 0;
    this.lastStepSpeed = 0;
    this.stepStartedAt = 0;
    this.holdUntil = 0;
    this.httpMajor = 0; // learned from the first segment response
    this.checkpointMs = opts.checkpointMs || CHECKPOINT_MS;
    this.checkpointBytes = opts.checkpointBytes || CHECKPOINT_BYTES;
    this._lastCheckpoint = 0;
    this._checkpointWritten = 0;
    this._workers = 0;
    this.retries = opts.retries ?? 10;
    this.retryDelayMs = opts.retryDelayMs ?? 3000;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.convertTs = opts.convertTs !== false;
    this._openConn = opts.openConn || null;
    this._fetchText = opts.fetchText;
    this.mediaPlaylist = null; // { text, url } of the media playlist being downloaded

    this.state = 'queued';
    this.error = null;
    this.segments = [];
    this.totalSegments = 0;
    this.doneSegments = 0;
    this.receivedBytes = 0;
    this.writtenBytes = 0;
    this.sizeEstimate = opts.sizeEstimate || -1;
    this.live = false;
    this.liveEnded = false; // recording stopped by the user, or the stream ended
    this.liveSeq = -1; // media sequence number of the last segment added
    this.liveGaps = 0; // segments that left the playlist before they could be fetched
    this.recordedSeconds = 0;
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
      this.savePlaylistCopy();
      this._lastCheckpoint = Date.now();
      this.emitUpdate(true);
      if (this.live) this.startLivePolling();
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
    let p;
    try {
      const r = await this.fetchText(this.playlistUrl);
      p = hls.parse(r.text, r.finalUrl || this.playlistUrl);
      let media = { text: r.text, url: r.finalUrl || this.playlistUrl };
      if (p.type === 'master') {
        if (!p.variants.length) throw new Error('Empty master playlist');
        const best = p.variants[0];
        if (best.audioSeparate) {
          const e = new Error('The sound is a separate stream');
          e.code = 'NEEDS_MERGE';
          throw e;
        }
        const r2 = await this.fetchText(best.url);
        p = hls.parse(r2.text, r2.finalUrl || best.url);
        media = { text: r2.text, url: r2.finalUrl || best.url };
      }
      this.mediaPlaylist = media;
    } catch (err) {
      if (err.code === 'NEEDS_MERGE') throw err;
      // The playlist link may have expired since the download started: continue from the saved copy.
      const saved = this.loadPlaylistCopy();
      if (!saved) throw err;
      p = hls.parse(saved.text, saved.url);
      this.mediaPlaylist = saved;
    }
    if (p.type !== 'media') throw new Error('Not a media playlist');
    if (p.encryption === 'drm') throw new Error('Stream is DRM-protected and cannot be downloaded');
    this.live = p.live;
    this.segments = p.segments;
    if (this.live) {
      // Record from (almost) now, like a player joining the stream.
      this.segments = p.segments.slice(-LIVE_START_SEGMENTS);
      this.liveSeq = this.segments.length ? this.segments[this.segments.length - 1].seq : -1;
      this.targetDuration = p.targetDuration || 6;
      this.concurrency = Math.min(this.concurrency, 3);
      this.target = Math.min(this.target, this.concurrency);
      this.steady = true;
    }
    this.totalSegments = this.segments.length;
    if (!this.totalSegments) throw new Error('Playlist has no segments');
  }

  // ---- live recording ------------------------------------------------------------------------

  isRecording() { return this.live && !this.liveEnded; }

  startLivePolling() {
    const poll = async () => {
      if (!this.isRecording() || this._stopping) return;
      try {
        const r = await this.fetchText(this.mediaPlaylist.url);
        const p = hls.parse(r.text, r.finalUrl || this.mediaPlaylist.url);
        if (p.type === 'media') this.addLiveSegments(p);
      } catch {
        // A missed refresh is fine; the next one catches up while the segments are still listed.
      }
      if (this.isRecording() && !this._stopping) this._livePoll = setTimeout(poll, Math.max(1000, (this.targetDuration || 6) * 500));
    };
    this._livePoll = setTimeout(poll, Math.max(1000, (this.targetDuration || 6) * 500));
  }

  addLiveSegments(p) {
    const fresh = p.segments.filter((x) => x.seq > this.liveSeq);
    if (fresh.length && this.liveSeq >= 0 && fresh[0].seq > this.liveSeq + 1) this.liveGaps += fresh[0].seq - this.liveSeq - 1;
    for (const x of fresh) this.segments.push(x);
    if (fresh.length) {
      this.liveSeq = fresh[fresh.length - 1].seq;
      this.totalSegments = this.segments.length;
      this.fillWorkers();
    }
    if (p.endList) this.stopRecording(); // the broadcast ended
  }

  /** Stop recording: what has been fetched is written and the file is finished. */
  stopRecording() {
    if (!this.live || this.liveEnded) return;
    this.liveEnded = true;
    clearTimeout(this._livePoll);
    // Nothing more will be added: everything listed so far is the whole recording.
    this.totalSegments = this.segments.length;
    if (this._wakeLive) this._wakeLive();
    this.pumpWriter();
    if (this._workers === 0 && this._resolveWorkers) { this._resolveWorkers(); this._resolveWorkers = null; }
  }

  loadPlaylistCopy() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.playlistCopyPath, 'utf8'));
      return saved && saved.text && saved.url ? saved : null;
    } catch {
      return null;
    }
  }

  savePlaylistCopy() {
    if (this.live || !this.mediaPlaylist) return;
    try { fs.writeFileSync(this.playlistCopyPath, JSON.stringify(this.mediaPlaylist)); } catch {}
  }

  // Continue an earlier attempt: keep the bytes already written for whole segments.
  tryResume() {
    let m;
    try { m = JSON.parse(fs.readFileSync(this.metaPath, 'utf8')); } catch { return false; }
    if (!m || m.v !== 1 || this.live || m.totalSegments !== this.totalSegments || !(m.nextWrite > 0)) return false;
    // Keys saved earlier: the key link may have expired (or now needs a login) since then.
    for (const [url, hex] of Object.entries(m.keys || {})) {
      if (/^[0-9a-f]{32}$/i.test(hex)) this._keyCache.set(url, Buffer.from(hex, 'hex'));
    }
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
    this._checkpointWritten = this.writtenBytes;
    return true;
  }

  // Atomic progress file. Called only after the output was synced to disk (see checkpoint()).
  saveMeta() {
    if (this.live || !this._container) return;
    const keys = {};
    for (const [url, buf] of this._keyCache) if (!url.startsWith('map:') && buf.length === 16) keys[url] = buf.toString('hex');
    try {
      const tmp = this.metaPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        v: 1, nextWrite: this._nextWrite, writtenBytes: this.writtenBytes, container: this._container,
        mapWritten: this._mapWritten, totalSegments: this.totalSegments, keys,
      }));
      fs.renameSync(tmp, this.metaPath);
    } catch {}
  }

  // Sync written data to disk, then record it as progress.
  async checkpoint() {
    if (this._out === null || this.live) return;
    await new Promise((r) => fs.fdatasync(this._out, () => r()));
    this.saveMeta();
    this._lastCheckpoint = Date.now();
    this._checkpointWritten = this.writtenBytes;
  }

  makeTx(opts) {
    return new TsToMp4((b) => { fs.writeSync(this._out, b); this.writtenBytes += b.length; }, opts);
  }

  async download() {
    // Writer promise resolves when all segments are written (or we stop).
    const writerDone = new Promise((res) => { this._resolveWriter = res; });
    if (this._nextWrite >= this.totalSegments) { this._resolveWriter(); this._resolveWriter = null; }
    const workersDone = new Promise((res) => { this._resolveWorkers = res; });
    this.stepStartedAt = Date.now();
    this.fillWorkers();
    if (!this._workers && this._resolveWorkers) { this._resolveWorkers(); this._resolveWorkers = null; }
    this._tune = setInterval(() => this.tune(), 250);
    try {
      await workersDone;
    } finally {
      clearInterval(this._tune); this._tune = null;
    }
    if (!this._stopping && this.error) throw this.error;
    await writerDone;
    if (this.error) throw this.error;
  }

  // Look-ahead grows with the number of parallel fetches, so memory stays bounded.
  get window() { return Math.max(this.minWindow, this.target * 2); }

  maxTarget() {
    let max = this.concurrency;
    // Through the browser stack an HTTP/1.1 server gets at most 6 connections anyway.
    if (this.httpMajor === 1 && !this.canGoDirect()) max = Math.min(max, BROWSER_H1_CAP);
    return max;
  }

  canGoDirect() {
    if (this._openConn) return true;
    const t = this.transport;
    if (!t || t.mode() === 'browser' || !this.segments.length) return false;
    return t.useDirect(this.segments[Math.min(this._nextFetch, this.segments.length - 1)].url);
  }

  fillWorkers() {
    while (!this._stopping && this._workers < this.target && (this._nextFetch < this.totalSegments || (this.isRecording() && this._workers === 0)) && Date.now() >= this.holdUntil) {
      this._workers++;
      this.worker().finally(() => {
        this._workers--;
        if (this._workers === 0 && this._resolveWorkers && (this._stopping || (this._nextFetch >= this.totalSegments && !this.isRecording()))) {
          this._resolveWorkers(); this._resolveWorkers = null;
        }
      });
    }
  }

  // Slow start for segments: double the parallel fetches while the total speed still rises.
  tune() {
    if (this._stopping) return;
    const now = Date.now();
    const limit = this.maxTarget();
    if (this.target > limit) this.target = limit;
    if (!this.steady && now >= this.holdUntil && this._workers >= this.target && now - this.stepStartedAt >= TUNE_MS) {
      const speed = this.recentSpeed(TUNE_MS);
      if (this.target >= limit) this.steady = true;
      else if (this.lastStepSpeed === 0 || speed > this.lastStepSpeed * 1.1) {
        this.lastStepSpeed = speed; this.flatSteps = 0;
        this.target = Math.min(limit, this.target * 2);
        this.stepStartedAt = now;
      } else if (++this.flatSteps >= 2) {
        this.steady = true;
      } else {
        this.stepStartedAt = now;
      }
    }
    this.fillWorkers();
  }

  // 429/503: the server wants fewer requests. Shrink and pause new fetches for a while.
  throttled(retryAfter) {
    this.target = Math.max(1, Math.min(this.target, this._workers) - 1);
    this.steady = true;
    this.holdUntil = Date.now() + (retryAfter || 5000);
  }

  async worker() {
    while (!this._stopping) {
      if (this._workers > this.target) return; // shrinking after 429/503
      // Respect the look-ahead window so memory stays bounded.
      if (this._nextFetch - this._nextWrite >= this.window) { await this.sleep(20); continue; }
      const idx = this._nextFetch;
      if (idx >= this.totalSegments) {
        if (!this.isRecording()) return;
        await new Promise((r) => { this._wakeLive = r; setTimeout(r, 500); });
        continue;
      }
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
        if (err instanceof HttpError && (err.status === 429 || err.status === 503)) {
          this.throttled(err.retryAfter);
          await this.sleep(err.retryAfter || this.backoffMs(attempt));
          continue;
        }
        await this.backoff(attempt);
      }
    }
    throw lastErr;
  }

  async getBytes(url, range) {
    const r = range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined;
    const conn = await this.open(url, { session: this.session, headers: { ...this.headers }, range: r, timeoutMs: this.timeoutMs });
    if (!this.httpMajor) {
      const v = conn.res && (conn.res.httpVersionMajor || Number(String(conn.res.httpVersion || conn.httpVersion || '1').split('.')[0]));
      this.httpMajor = v || 1;
    }
    if (conn.status >= 400) {
      conn.abort();
      const err = new HttpError(conn.status);
      err.retryAfter = retryAfterMs(conn.headers && conn.headers['retry-after']);
      throw err;
    }
    return this.readLimited(conn);
  }

  // Browser stack by default; the direct transport once more than 6 parallel fetches are wanted from
  // an HTTP/1.1 server (or always, if the user chose that).
  open(url, opts) {
    if (this._openConn) return this._openConn(url, opts);
    const t = this.transport;
    if (!t) return net.open(url, opts);
    const direct = t.useDirect(url) && (t.mode() === 'direct' || (this.httpMajor === 1 && this.target > BROWSER_H1_CAP));
    return t.open(url, { ...opts, direct });
  }

  // Read a whole response. Chunks are taken in order and the speed limit may make them wait; 'end'
  // can arrive while the last one is still waiting, so it is handled after it (no truncated segments).
  readLimited(conn) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let finished = false;
      const finish = (err, value) => { if (finished) return; finished = true; clearTimeout(idle); if (err) reject(err); else resolve(value); };
      const stall = () => { conn.abort(); finish(new Error('stalled')); };
      let idle = setTimeout(stall, this.timeoutMs);
      let chain = Promise.resolve();
      const limited = !!(this.limiter || this.taskLimiter);
      const take = async (chunk) => {
        let off = 0;
        while (off < chunk.length) {
          let n = Math.min(chunk.length - off, 64 * 1024);
          if (this.limiter) n = await this.limiter.take(n);
          if (this.taskLimiter) n = await this.taskLimiter.take(n);
          off += n;
        }
      };
      const keep = (chunk) => {
        clearTimeout(idle); idle = setTimeout(stall, this.timeoutMs);
        chunks.push(chunk);
        this.receivedBytes += chunk.length;
        this.sample(chunk.length);
        this.emitUpdate();
      };
      conn.res.on('data', (chunk) => {
        if (finished) return;
        if (this._stopping) { conn.abort(); return; }
        if (!limited) return keep(chunk);
        conn.res.pause();
        chain = chain.then(() => take(chunk)).then(() => { if (finished) return; keep(chunk); conn.res.resume(); }, (e) => finish(e));
      });
      const after = (fn) => { chain = chain.then(fn, fn); };
      conn.res.on('end', () => after(() => finish(null, Buffer.concat(chunks))));
      conn.res.on('error', (e) => after(() => finish(e)));
      conn.res.on('aborted', () => after(() => finish(new Error('aborted'))));
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
        this.recordedSeconds += this.segments[idx].duration || 0;
        if (Date.now() - this._lastCheckpoint >= this.checkpointMs || this.writtenBytes - this._checkpointWritten >= this.checkpointBytes) {
          await this.checkpoint();
        }
        this.emitUpdate();
      }
    } catch (err) {
      this.error = err;
      this.stop();
    } finally {
      this._writing = false;
    }
    if ((this._nextWrite >= this.totalSegments && !this.isRecording()) || this._stopping) {
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
    const cut = now - Math.max(3000, TUNE_MS);
    while (this._speed.length && this._speed[0][0] < cut) this._speed.shift();
  }

  recentSpeed(ms) {
    const cut = Date.now() - ms;
    let total = 0;
    for (const [t, b] of this._speed) if (t >= cut) total += b;
    return total / (ms / 1000);
  }

  speed() {
    if (this._speed.length < 2) return 0;
    const span = (Date.now() - this._speed[0][0]) / 1000;
    if (span <= 0) return 0;
    return Math.round(this._speed.reduce((s, x) => s + x[1], 0) / span);
  }

  backoffMs(attempt) { return Math.min(this.retryDelayMs * Math.pow(1.6, attempt), 30000); }

  async backoff(attempt) { await this.sleep(this.backoffMs(attempt)); }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  stop() {
    this._stopping = true;
    clearTimeout(this._livePoll);
    if (this._resolveWriter) { this._resolveWriter(); this._resolveWriter = null; }
    if (this._resolveWorkers && this._workers === 0) { this._resolveWorkers(); this._resolveWorkers = null; }
  }

  /** Pause keeping progress. Resolves once the last write has finished and progress is saved. */
  async pause() {
    if (this.state !== 'downloading') return;
    if (this.live) {
      // A live recording can't continue later: finish it, so the file is complete and playable.
      const done = new Promise((r) => { this.once('done', r); this.once('error', r); });
      this.stopRecording();
      await Promise.race([done, this.sleep(8000)]);
      return;
    }
    this.stop();
    this.state = 'paused';
    await this._writerIdle;
    await this.checkpoint().catch(() => {});
    this.closeOut();
    this.emitUpdate(true);
  }

  async cancel() {
    this.stop();
    await this._writerIdle;
    this.closeOut();
    for (const f of [this.partPath, this.metaPath, this.playlistCopyPath]) { try { fs.rmSync(f, { force: true }); } catch {} }
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
      fs.rmSync(this.playlistCopyPath, { force: true });
    } catch (err) { this.fail(err); return; }
    this.state = 'done';
    this.emit('done');
    this.emitUpdate(true);
  }

  fail(err) {
    this.error = err;
    this.state = 'error';
    this.stop();
    // Keep what was written: let the last write finish, sync, then save progress.
    this._writerIdle.then(() => this.checkpoint()).catch(() => {}).finally(() => this.closeOut());
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
      received: this.writtenBytes, percent: this.live ? 0 : frac * 100, resumable: !this.live,
      live: this.live, recording: this.isRecording(), recordedSeconds: Math.round(this.recordedSeconds), liveGaps: this.liveGaps,
      segments: this.totalSegments, doneSegments: this.doneSegments, connections: this.state === 'downloading' ? this._workers : 0,
      speed: this.state === 'downloading' ? this.speed() : 0,
      error: this.error ? String(this.error.message || this.error) : null,
    };
  }
}

function retryAfterMs(v) {
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(120000, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.min(120000, Math.max(0, t - Date.now())) : 0;
}

module.exports = { HlsDownload };
