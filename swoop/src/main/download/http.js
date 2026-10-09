'use strict';
// Multi-connection HTTP download, engine v2.
//
//  - The first request (no probe) becomes connection #1; extra connections split work off it.
//  - Slow start: 1 -> 2 -> 4 -> 8 -> ... connections, growing only while total speed still rises; a 403
//    on an extra connection means "server connection limit" (hold), 429/503 back off (Retry-After).
//  - Work stealing by time left (bytes left / speed), minimum split size, 5 s cooldown per victim.
//  - Per-connection write cache (1 MB), positional writes into one preallocated .part file.
//  - Checkpoint every 30 s / 64 MB: flush caches, fdatasync, then save progress atomically. A resume
//    sends If-Range with the saved ETag/Last-Modified and starts over if the file changed.
//  - Extra connections use the direct transport (no 6-per-server cap) when the server is HTTP/1.x.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const net = require('../net');
const util = require('../util');
const { HttpError } = net;

const MIN_PART = 512 * 1024; // smallest piece worth giving to another connection
const WRITE_CHUNK = 1024 * 1024; // write cache per connection
const CHECKPOINT_MS = 30000;
const CHECKPOINT_BYTES = 64 * 1024 * 1024;
const STEAL_SECONDS = 3; // only help connections with more than this much time left
const STEAL_COOLDOWN_MS = 5000;
const TICK_MS = 500;
const BROWSER_H1_CAP = 6; // Chromium's per-server limit for HTTP/1.1

class HttpDownload extends EventEmitter {
  /**
   * @param {object} opts
   *   id, savePath, sources [url, ...] (first is primary, rest mirrors), headers, session, transport,
   *   connections (max), limiter (global), taskLimiter (per download), retries, retryDelayMs, timeoutMs,
   *   size (known size, optional), allowRename, minSplitBytes,
   *   openConn (tests): replaces both transports
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.setSavePath(opts.savePath);
    this.sources = opts.sources && opts.sources.length ? opts.sources.slice() : [opts.url];
    this.headers = opts.headers || {};
    this.session = opts.session;
    this.transport = opts.transport || null;
    this.maxConnections = Math.min(32, Math.max(1, opts.connections || 8));
    this.limiter = opts.limiter;
    this.taskLimiter = opts.taskLimiter || null;
    this.retries = opts.retries ?? 10;
    this.retryDelayMs = opts.retryDelayMs ?? 3000;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.openConn = opts.openConn || null;
    this.allowRename = !!opts.allowRename;
    this.minPart = opts.minSplitBytes || MIN_PART;

    this.size = opts.size ?? -1;
    this.resumable = false;
    this.validator = null; // { etag, lastModified }
    this.httpMajor = 1;
    this.state = 'queued';
    this.error = null;
    this.segments = []; // { start, end (exclusive, Infinity = unknown), done (written), got (received), conn, lastSteal }
    this.conns = new Set();
    this.fd = null;
    this.cap = 1; // current connection target (slow start)
    this.steady = false;
    this.lastStepSpeed = 0;
    this.stepStartedAt = 0;
    this.holdUntil = 0; // after 429/503: don't open new connections before this time
    this.connectMs = 0;
    this._srcIdx = 0;
    this._stopping = false;
    this._lastEmit = 0;
    this._speedSamples = [];
    this._sinceCheckpoint = 0;
    this._lastCheckpoint = 0;
    this._tick = null;
    this._finishing = false;
    this._doneResolve = null;
  }

  setSavePath(p) {
    this.savePath = p;
    this.partPath = p + '.part';
    this.metaPath = p + '.part.meta';
  }

  get received() { return this.segments.reduce((s, x) => s + x.got, 0); }

  // ---- lifecycle ---------------------------------------------------------------------------------

  async start() {
    if (this.state === 'downloading' || this.state === 'connecting') return;
    this._stopping = false;
    this.error = null;
    this.state = 'connecting';
    this.emitUpdate(true);
    try {
      const first = await this.prepare();
      if (this._stopping) { if (first) first.conn.abort(); return; }
      this.state = 'downloading';
      await this.run(first);
      if (this._stopping) return;
      await this.finish();
    } catch (err) {
      if (!this._stopping) this.fail(err);
    }
  }

  async prepare() {
    fs.mkdirSync(path.dirname(this.savePath), { recursive: true });
    const meta = this.loadMeta();
    if (meta) {
      const resumed = await this.tryResume(meta);
      if (resumed) return resumed;
    }
    return this.freshStart();
  }

  // Fresh download: the first response (Range: bytes=0-) is kept and streams as connection #1.
  async freshStart() {
    this.segments = [];
    const url = this.sources[0];
    const conn = await this.requestWithRetry(url, { range: 'bytes=0-', first: true });
    const h = conn.headers;
    const cr = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(h['content-range'] || '');
    if (conn.status === 206 && cr) {
      this.size = cr[3] === '*' ? -1 : Number(cr[3]);
      this.resumable = this.size > 0 && Number(cr[1]) === 0;
    } else {
      const cl = Number(h['content-length']);
      this.size = cl > 0 ? cl : -1;
      this.resumable = this.size > 0 && /\bbytes\b/i.test(h['accept-ranges'] || '');
    }
    if (conn.status === 206 && cr && Number(cr[1]) !== 0) { conn.abort(); throw new Error('Server sent the wrong part of the file'); }
    this.validator = { etag: h.etag || '', lastModified: h['last-modified'] || '' };
    this.applyServerName({ mime: (h['content-type'] || '').split(';')[0].trim().toLowerCase(), disposition: h['content-disposition'] || '' });
    this.checkFreeSpace();
    this.fd = fs.openSync(this.partPath, 'w');
    if (this.size > 0) { try { fs.ftruncateSync(this.fd, this.size); } catch {} }
    const seg = this.newSegment(0, this.size > 0 ? this.size : Infinity);
    this.saveMeta(); // progress file exists from the start
    return { conn, seg };
  }

  // Resume: request the first unfinished part with If-Range; a full (200) answer means the file changed.
  async tryResume(meta) {
    let st;
    try { st = fs.statSync(this.partPath); } catch { return null; }
    if (meta.size > 0 && st.size !== meta.size) return null;
    const segs = meta.segments.map((s) => ({ start: s.start, end: s.end === -1 ? Infinity : s.end, done: s.done, got: s.done, conn: null, lastSteal: 0 }));
    if (!segs.length || !meta.resumable) return null;
    const covered = segs.slice().sort((a, b) => a.start - b.start);
    for (let i = 1; i < covered.length; i++) if (covered[i].start !== covered[i - 1].end) return null; // gaps: start over
    this.size = meta.size; this.resumable = true; this.validator = meta.validator || null;
    this.segments = covered;
    const first = this.segments.find((s) => s.start + s.done < s.end);
    if (!first) { this.fd = fs.openSync(this.partPath, 'r+'); return { conn: null, seg: null }; }
    const headers = {};
    if (this.validator && (this.validator.etag || this.validator.lastModified)) headers['if-range'] = this.validator.etag || this.validator.lastModified;
    const from = first.start + first.done;
    const conn = await this.requestWithRetry(this.sources[0], { range: `bytes=${from}-${first.end - 1}`, first: true, extraHeaders: headers });
    if (conn.status === 200) {
      // File changed on the server (or ranges dropped): start over with this full response.
      conn.abort();
      try { fs.rmSync(this.partPath, { force: true }); } catch {}
      return null;
    }
    this.fd = fs.openSync(this.partPath, 'r+');
    this.resumedFrom = this.received;
    return { conn, seg: first };
  }

  newSegment(start, end) {
    const s = { start, end, done: 0, got: 0, conn: null, lastSteal: 0 };
    this.segments.push(s);
    return s;
  }

  // ---- connections ------------------------------------------------------------------------------

  nextSource() {
    const u = this.sources[this._srcIdx % this.sources.length];
    this._srcIdx++;
    return u;
  }

  /** Open one request, choosing the transport. */
  async request(url, { range, first = false, extraHeaders = {}, direct = null }) {
    const headers = { ...this.headers, ...extraHeaders };
    const timeoutMs = this.connectMs ? Math.min(this.timeoutMs, Math.max(8000, this.connectMs * 5)) : this.timeoutMs;
    if (this.openConn) return this.openConn(url, { session: this.session, headers, range, timeoutMs });
    const useDirect = direct != null ? direct
      : this.transport && (first ? this.transport.mode() === 'direct' : this.transport.useDirect(url) && (this.transport.mode() === 'direct' || this.httpMajor < 2));
    if (this.transport) return this.transport.open(url, { session: this.session, headers, range, timeoutMs, direct: useDirect, firstConnection: first });
    return net.open(url, { session: this.session, headers, range, timeoutMs });
  }

  async requestWithRetry(url, opts) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (this._stopping) throw new Error('stopped');
      const t0 = Date.now();
      try {
        const conn = await this.request(url, opts);
        if (conn.status >= 400) {
          conn.abort();
          const err = new HttpError(conn.status);
          err.retryAfter = retryAfterMs(conn.headers['retry-after']);
          throw err;
        }
        if (opts.first) {
          this.connectMs = Date.now() - t0;
          const v = conn.res && (conn.res.httpVersionMajor || Number(String(conn.res.httpVersion || conn.httpVersion || '1').split('.')[0]));
          this.httpMajor = v || 1;
        }
        return conn;
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && err.fatal) throw classifyFatal(err, this.received);
        await this.sleep(err.retryAfter || this.backoffMs(attempt));
      }
    }
    throw lastErr;
  }

  activeConns() { return [...this.conns].filter((c) => !c.closed).length; }

  capLimit() {
    let cap = this.resumable && this.size > 0 ? this.maxConnections : 1;
    // Extra connections through the browser stack on HTTP/1.1 can't exceed Chromium's per-server limit.
    const directOk = this.openConn || (this.transport && this.transport.useDirect(this.sources[0]) && (this.transport.mode() === 'direct' || this.httpMajor < 2));
    if (!directOk && this.httpMajor < 2) cap = Math.min(cap, BROWSER_H1_CAP);
    return cap;
  }

  async run(first) {
    this._lastCheckpoint = Date.now();
    this.stepStartedAt = Date.now();
    const finished = new Promise((r) => { this._doneResolve = r; });
    this._tick = setInterval(() => this.tick(), TICK_MS);
    if (first && first.conn) this.startConnection(first.seg, first.conn);
    // On resume, other unfinished parts are picked up as the slow start opens connections.
    this.cap = Math.max(1, Math.min(this.capLimit(), first && first.conn ? 1 : 2));
    this.fillConnections();
    this.checkDone();
    await finished;
    clearInterval(this._tick); this._tick = null;
  }

  // Controller: speed sampling, slow-start growth, checkpoints, progress.
  tick() {
    if (this._stopping || this._finishing) return;
    const now = Date.now();
    const speed = this.speed();
    const limit = this.capLimit();
    if (!this.steady && this.resumable && now >= this.holdUntil && now - this.stepStartedAt >= 1500) {
      const grew = this.lastStepSpeed === 0 || speed > this.lastStepSpeed * 1.1;
      if (this.cap >= limit) this.steady = true;
      else if (grew || this.cap < 2) {
        this.lastStepSpeed = speed;
        this.cap = Math.min(limit, this.cap * 2);
        this.stepStartedAt = now;
      } else {
        this.steady = true; // more connections stopped helping: stay here
        this.cap = Math.max(1, this.activeConns());
      }
    }
    this.fillConnections();
    if (now - this._lastCheckpoint >= CHECKPOINT_MS || this._sinceCheckpoint >= CHECKPOINT_BYTES) this.checkpoint().catch(() => {});
    this.emitUpdate();
  }

  // Open connections up to the current target: unassigned parts first, then split the slowest.
  fillConnections() {
    if (this._stopping || this._finishing) return;
    while (this.activeConns() < this.cap && Date.now() >= this.holdUntil) {
      const seg = this.pickWork();
      if (!seg) break;
      this.startConnection(seg, null);
    }
  }

  pickWork() {
    const free = this.segments.find((s) => !s.conn && s.start + s.got < s.end);
    if (free) return free;
    if (!this.resumable) return null;
    return this.stealFrom();
  }

  // Take half of the remaining work of the part with the most time left.
  stealFrom() {
    const now = Date.now();
    let victim = null; let worst = STEAL_SECONDS;
    for (const s of this.segments) {
      if (!s.conn || s.end === Infinity || now - s.lastSteal < STEAL_COOLDOWN_MS) continue;
      const remain = s.end - (s.start + s.got);
      if (remain < this.minPart * 2) continue;
      const sp = s.conn.speed || 0;
      const secs = sp > 0 ? remain / sp : STEAL_SECONDS + 1 + remain / 1e9;
      if (secs > worst) { worst = secs; victim = s; }
    }
    if (!victim) return null;
    const from = victim.start + victim.got;
    const mid = from + Math.floor((victim.end - from) / 2);
    const fresh = this.newSegment(mid, victim.end);
    victim.end = mid;
    victim.lastSteal = now;
    fresh.lastSteal = now;
    return fresh;
  }

  startConnection(seg, initial) {
    const c = { seg, speed: 0, samples: [], buf: [], bufLen: 0, bufStart: 0, writeChain: Promise.resolve(), closed: false, abort: null, retries: 0 };
    seg.conn = c;
    this.conns.add(c);
    this.runConnection(c, initial).finally(() => {
      c.closed = true;
      this.conns.delete(c);
      if (c.seg && c.seg.conn === c) c.seg.conn = null;
      if (!this._stopping) { this.fillConnections(); this.checkDone(); }
    });
  }

  async runConnection(c, initial) {
    let conn = initial;
    while (!this._stopping) {
      const seg = c.seg;
      if (seg.start + seg.got >= seg.end) {
        await this.flushConn(c);
        // Done with this part: help the slowest connection, or stop.
        const next = this.pickWork();
        if (!next || this.activeConns() > this.cap) return;
        if (c.seg.conn === c) c.seg.conn = null;
        c.seg = next; next.conn = c;
        conn = null;
        continue;
      }
      try {
        if (!conn) {
          const from = seg.start + seg.got;
          const range = this.resumable && seg.end !== Infinity ? `bytes=${from}-${seg.end - 1}` : (from > 0 ? `bytes=${from}-` : undefined);
          conn = await this.request(this.nextSource(), { range });
          if (conn.status >= 400) {
            conn.abort();
            const err = new HttpError(conn.status);
            err.retryAfter = retryAfterMs(conn.headers['retry-after']);
            throw err;
          }
          if (range && conn.status !== 206) {
            conn.abort();
            if (from > 0 || seg !== this.segments[0]) {
              // Server ignores ranges for extra connections: continue with one connection only.
              this.resumable = false; this.cap = 1; this.steady = true;
              seg.conn = null;
              return;
            }
          }
        }
        await this.pump(c, conn);
        conn = null;
        c.retries = 0;
      } catch (err) {
        conn = null;
        await this.flushConn(c).catch(() => {});
        if (this._stopping) return;
        const status = err instanceof HttpError ? err.status : 0;
        const others = this.activeConns() - 1;
        if ((status === 403 || status === 429 || status === 503) && others > 0) {
          // Too many connections for this server: hold at the current count and let others take this part.
          this.cap = Math.max(1, others);
          this.steady = true;
          if (status !== 403) this.holdUntil = Date.now() + (err.retryAfter || 5000);
          return;
        }
        if (status === 429 || status === 503) this.holdUntil = Date.now() + (err.retryAfter || 5000);
        if (err instanceof HttpError && err.fatal) throw classifyFatal(err, this.received);
        if (!this.resumable && seg.got > 0) {
          // No ranges: the only way to retry is from the beginning.
          seg.got = 0; seg.done = 0; c.bufLen = 0; c.buf = [];
        }
        if (++c.retries > this.retries) throw err;
        await this.sleep(err.retryAfter || this.backoffMs(c.retries));
      }
    }
  }

  // Stream one response into its part, honouring the part's (possibly shrinking) end.
  pump(c, conn) {
    return new Promise((resolve, reject) => {
      const seg = c.seg;
      let idle;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        c.abort = null;
        if (err) reject(err); else resolve();
      };
      const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => { conn.abort(); done(new Error('Connection stalled')); }, this.timeoutMs); };
      c.abort = () => { conn.abort(); done(); };
      c.bufStart = seg.start + seg.got;
      armIdle();
      const res = conn.res;
      res.on('data', async (chunk) => {
        if (settled) return;
        if (this._stopping) { conn.abort(); return done(); }
        res.pause();
        try {
          let off = 0;
          while (off < chunk.length && !settled) {
            let n = chunk.length - off;
            if (this.limiter) n = await this.limiter.take(Math.min(n, 64 * 1024));
            if (this.taskLimiter) n = await this.taskLimiter.take(Math.min(n, 64 * 1024));
            let piece = chunk.subarray(off, off + n);
            off += n;
            const room = seg.end === Infinity ? piece.length : seg.end - (seg.start + seg.got);
            if (room <= 0) { conn.abort(); return done(); }
            if (piece.length > room) piece = piece.subarray(0, room);
            c.buf.push(piece); c.bufLen += piece.length;
            seg.got += piece.length;
            this._sinceCheckpoint += piece.length;
            this.sample(c, piece.length);
            if (c.bufLen >= WRITE_CHUNK) this.flushConn(c);
            if (seg.end !== Infinity && seg.start + seg.got >= seg.end) { conn.abort(); return done(); }
          }
          this.emitUpdate();
          armIdle();
          if (!settled) res.resume();
        } catch (err) {
          conn.abort(); done(err);
        }
      });
      res.on('end', () => {
        if (seg.end === Infinity) { seg.end = seg.start + seg.got; this.size = seg.end; return done(); }
        if (seg.start + seg.got >= seg.end) return done();
        done(new Error('Connection closed early'));
      });
      res.on('error', (e) => done(seg.start + seg.got >= seg.end ? null : e));
      res.on('aborted', () => done(seg.start + seg.got >= seg.end || this._stopping ? null : new Error('Connection aborted')));
    });
  }

  // Write this connection's cache at its file position. Returns when written.
  flushConn(c) {
    if (!c.bufLen) return c.writeChain;
    const buf = c.buf.length === 1 ? c.buf[0] : Buffer.concat(c.buf, c.bufLen);
    const pos = c.bufStart;
    const seg = c.seg;
    c.buf = []; c.bufStart += buf.length; c.bufLen = 0;
    c.writeChain = c.writeChain.then(() => this.writeAt(pos, buf)).then(() => {
      // Only bytes that reached the file count as done (used for checkpoints/resume).
      seg.done = Math.max(seg.done, pos + buf.length - seg.start);
    });
    return c.writeChain;
  }

  writeAt(pos, buf) {
    return new Promise((resolve, reject) => {
      let written = 0;
      const step = () => fs.write(this.fd, buf, written, buf.length - written, pos + written, (err, n) => {
        if (err) return reject(err);
        written += n;
        if (written < buf.length) step(); else resolve();
      });
      step();
    });
  }

  // Flush caches, force data to disk, then record progress. Progress never claims unwritten data.
  async checkpoint() {
    if (this._checkpointing || this.fd === null) return;
    this._checkpointing = true;
    try {
      await Promise.all([...this.conns].map((c) => this.flushConn(c)));
      await new Promise((r) => fs.fdatasync(this.fd, () => r()));
      this.saveMeta();
      this._sinceCheckpoint = 0;
      this._lastCheckpoint = Date.now();
    } finally {
      this._checkpointing = false;
    }
  }

  checkDone() {
    if (this._finishing || this._stopping) return;
    const unfinished = this.segments.some((s) => s.start + s.done < s.end || s.end === Infinity);
    const working = this.activeConns() > 0;
    if (!unfinished && !working && this._doneResolve) { this._finishing = true; this._doneResolve(); }
    else if (!working && unfinished && this._doneResolve && !this.pickWorkPossible()) {
      // Nothing running and nothing can start: report instead of waiting forever.
      this._finishing = true;
      this.error = this.error || new Error('Download stopped before finishing');
      this._doneResolve();
    }
  }

  pickWorkPossible() {
    return Date.now() < this.holdUntil || this.segments.some((s) => !s.conn && s.start + s.got < s.end);
  }

  // ---- finishing / stopping --------------------------------------------------------------------

  async finish() {
    if (this.error) throw this.error;
    await Promise.all([...this.conns].map((c) => this.flushConn(c)));
    if (this.fd !== null) await new Promise((r) => fs.fdatasync(this.fd, () => r()));
    this.closeFd();
    const total = this.segments.reduce((s, x) => s + x.done, 0);
    if (this.size > 0 && total < this.size) throw new Error('Incomplete download');
    if (this.size < 0) this.size = total;
    try { fs.truncateSync(this.partPath, this.size); } catch {}
    fs.renameSync(this.partPath, this.savePath);
    try { fs.rmSync(this.metaPath, { force: true }); } catch {}
    this.state = 'done';
    this.emit('done');
    this.emitUpdate(true);
  }

  /** Stop and keep progress. Resolves after caches are written and progress saved. */
  async pause() {
    if (this.state !== 'downloading' && this.state !== 'connecting') return;
    this.state = 'paused';
    await this.stopAll();
    this.emitUpdate(true);
  }

  async stopAll() {
    this._stopping = true;
    for (const c of this.conns) if (c.abort) try { c.abort(); } catch {}
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    if (this._doneResolve) this._doneResolve();
    await Promise.all([...this.conns].map((c) => this.flushConn(c).catch(() => {})));
    if (this.fd !== null) {
      await new Promise((r) => fs.fdatasync(this.fd, () => r()));
      if (this.resumable) this.saveMeta();
      this.closeFd();
    }
  }

  async cancel() {
    await this.stopAll();
    for (const f of [this.partPath, this.metaPath]) { try { fs.rmSync(f, { force: true }); } catch {} }
    this.state = 'queued';
  }

  fail(err) {
    this.error = err;
    this.state = 'error';
    this._stopping = true;
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    for (const c of this.conns) if (c.abort) try { c.abort(); } catch {}
    Promise.all([...this.conns].map((c) => this.flushConn(c).catch(() => {}))).then(() => {
      if (this.fd !== null && this.resumable) this.saveMeta();
      this.closeFd();
    });
    this.emit('error', err);
    this.emitUpdate(true);
  }

  closeFd() {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch {} this.fd = null; }
  }

  // ---- naming, space, meta ---------------------------------------------------------------------

  // When the name was guessed from the URL, prefer the server's filename and add a missing extension.
  applyServerName(info) {
    if (!this.allowRename) return;
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

  checkFreeSpace() {
    if (!(this.size > 0)) return;
    try {
      const st = fs.statfsSync(path.dirname(this.savePath));
      const free = Number(st.bavail) * Number(st.bsize);
      if (free > 0 && free < this.size + 16 * 1024 * 1024) {
        const err = new Error(`Not enough disk space (${util.formatBytes ? util.formatBytes(this.size) : this.size + ' bytes'} needed)`);
        err.code = 'NO_SPACE';
        throw err;
      }
    } catch (err) {
      if (err.code === 'NO_SPACE') throw err;
    }
  }

  saveMeta() {
    try {
      const tmp = this.metaPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({
        v: 2, sources: this.sources, size: this.size, resumable: this.resumable, validator: this.validator,
        segments: this.segments.map((s) => ({ start: s.start, end: s.end === Infinity ? -1 : s.end, done: s.done })),
      }));
      fs.renameSync(tmp, this.metaPath);
    } catch {}
  }

  loadMeta() {
    try {
      const m = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      if (m.v !== 2 || !Array.isArray(m.segments)) return null;
      return m;
    } catch {
      return null;
    }
  }

  // ---- speed / progress ------------------------------------------------------------------------

  sample(c, bytes) {
    const now = Date.now();
    this._speedSamples.push([now, bytes]);
    c.samples.push([now, bytes]);
    const cut = now - 3000;
    while (this._speedSamples.length && this._speedSamples[0][0] < cut) this._speedSamples.shift();
    while (c.samples.length && c.samples[0][0] < cut) c.samples.shift();
    const span = c.samples.length > 1 ? (now - c.samples[0][0]) / 1000 : 0;
    c.speed = span > 0.4 ? c.samples.reduce((s, x) => s + x[1], 0) / span : 0;
  }

  speed() {
    if (this._speedSamples.length < 2) return 0;
    const span = (Date.now() - this._speedSamples[0][0]) / 1000;
    if (span <= 0) return 0;
    return Math.round(this._speedSamples.reduce((s, x) => s + x[1], 0) / span);
  }

  backoffMs(attempt) { return Math.min(this.retryDelayMs * Math.pow(1.6, attempt), 30000); }

  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 300) return;
    this._lastEmit = now;
    this.emit('progress', this.progress());
  }

  progress() {
    const received = this.received;
    return {
      id: this.id, state: this.state, size: this.size, received,
      percent: this.size > 0 ? Math.min(100, (received / this.size) * 100) : 0,
      speed: this.state === 'downloading' ? this.speed() : 0, resumable: this.resumable,
      connections: this.activeConns(), error: this.error ? String(this.error.message || this.error) : null,
      errorCode: this.error && this.error.code ? this.error.code : null,
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

// 401/403/404/410 after data was received usually means the download link expired.
function classifyFatal(err, received) {
  if ([401, 403, 404, 410].includes(err.status) && received > 0) {
    const e = new Error(`The download link expired (HTTP ${err.status}). Use “Refresh link” to continue.`);
    e.code = 'LINK_EXPIRED'; e.status = err.status;
    return e;
  }
  return err;
}

module.exports = { HttpDownload, MIN_PART, retryAfterMs };
