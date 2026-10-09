'use strict';
// Owns all downloads: creates the right engine, runs the queue (maxActive), persists state so
// unfinished downloads survive a restart, and emits updates for the UI.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');
const { HttpDownload } = require('./http');
const { HlsDownload } = require('./hls-dl');
const { RateLimiter } = require('./limiter');
const { JsonStore } = require('../store');
const util = require('../util');
const post = require('./postprocess');
const { normalizeQueues } = require('../scheduler');

class DownloadManager extends EventEmitter {
  /**
   * opts: { transport, privateSession, scanFile } - transport: direct/browser HTTP for the engines
   * (see transport.js); privateSession: the private tabs' session (their downloads use its
   * cookies); scanFile (tests): replaces the Defender scan.
   */
  constructor(settings, session, opts = {}) {
    super();
    this.settings = settings;
    this.session = session;
    this.privateSession = opts.privateSession || session;
    this.transport = opts.transport || null;
    this.taskLimiters = new Map(); // id -> RateLimiter (per-download speed limit)
    this.natives = new Map(); // id -> Electron DownloadItem (downloads the browser itself handles)
    this.scanFile = opts.scanFile || post.scanFile;
    this.scheduler = null; // set by main: decides whether a queue waits for its time window
    this._finishedSinceIdle = false;
    this.limiter = new RateLimiter((settings.get('speedLimitKBps') || 0) * 1024);
    this.store = new JsonStore(path.join(app.getPath('userData'), 'downloads.json'), { items: [] });
    this.records = new Map(); // id -> record (serialisable)
    this.engines = new Map(); // id -> engine instance
    this.queue = []; // ids waiting to run
    this.load();
    settings.on('change', (c) => {
      if ('speedLimitKBps' in c) this.limiter.setRate((c.speedLimitKBps || 0) * 1024);
      if ('maxActive' in c) this.pump();
    });
  }

  load() {
    for (const rec of this.store.data.items || []) {
      // Downloads that were running or waiting when the app closed come back paused (and are
      // remembered, so "resume unfinished downloads on start" can pick them up).
      if (['downloading', 'connecting', 'queued'].includes(rec.state)) { rec.state = 'paused'; rec.wasRunning = true; }
      // The browser's own downloads (blob:/data: links) can't continue after a restart.
      if (rec.native && rec.state !== 'done') { rec.state = 'error'; rec.error = 'Interrupted when NovaDM closed'; rec.wasRunning = false; }
      rec.speed = 0;
      this.records.set(rec.id, rec);
    }
  }

  persist() {
    // Downloads from private tabs leave no trace in the saved list (the file itself stays).
    this.store.data.items = [...this.records.values()].filter((r) => !r.incognito).map((r) => ({
      id: r.id, kind: r.kind, name: r.name, savePath: r.savePath, sources: r.sources,
      playlistUrl: r.playlistUrl, mirrors: r.mirrors, headers: r.headers, pageUrl: r.pageUrl,
      category: r.category, state: r.state, size: r.size, received: r.received,
      convertTs: r.convertTs, addedAt: r.addedAt, completedAt: r.completedAt, error: r.error,
      allowRename: r.allowRename, resumable: r.resumable, segments: r.segments, doneSegments: r.doneSegments,
      activeMs: r.activeMs || 0, meta: r.meta || null, percent: r.percent || 0,
      wasRunning: !!r.wasRunning, errorCode: r.errorCode || null,
      speedLimitKBps: r.speedLimitKBps || 0, expectedHash: r.expectedHash || '', verify: r.verify || '',
      native: !!r.native, queue: r.queue || 'main', scan: r.scan === 'scanning' ? '' : r.scan || '', scanDetail: r.scanDetail || '',
    }));
    this.store.save();
  }

  // Time spent actually downloading (for "Active time" and "Average speed").
  addActiveTime(rec) {
    if (rec.runStartedAt) {
      rec.activeMs = (rec.activeMs || 0) + (Date.now() - rec.runStartedAt);
      rec.runStartedAt = 0;
    }
  }

  activeMs(rec) {
    return (rec.activeMs || 0) + (rec.runStartedAt ? Date.now() - rec.runStartedAt : 0);
  }

  categoryDir(category) {
    const base = this.settings.get('downloadDir');
    if (this.settings.get('categoryFolders') && category && category !== 'other') {
      return path.join(base, util.CATEGORY_LABELS[category] || 'Other');
    }
    return base;
  }

  reservedPaths() {
    const set = new Set();
    for (const r of this.records.values()) if (r.state !== 'done') set.add(r.savePath.toLowerCase());
    return set;
  }

  /**
   * Add a download.
   * @param {object} spec { kind: 'http'|'hls', name, url|sources|playlistUrl, mirrors, headers,
   *   pageUrl, category, size, convertTs, start (bool) }
   */
  add(spec) {
    const id = util.uid();
    const category = spec.category || util.categoryOf(spec.name || util.filenameFromUrl(spec.url || ''), spec.mime);
    let dir = spec.dir || this.categoryDir(category);
    if (spec.subdir) dir = path.join(dir, util.sanitizeFilename(spec.subdir, 'Page'));
    const name = util.sanitizeFilename(spec.name || util.filenameFromUrl(spec.url || spec.playlistUrl) || 'download');
    const savePath = util.uniquePath(path.join(dir, name), this.reservedPaths());
    const rec = {
      id, kind: spec.kind, name: path.basename(savePath), savePath,
      sources: spec.sources || (spec.url ? [spec.url] : []), playlistUrl: spec.playlistUrl || '',
      mirrors: spec.mirrors || [], headers: spec.headers || {}, pageUrl: spec.pageUrl || '',
      category, state: spec.start === false ? 'paused' : 'queued', size: spec.size ?? -1, received: 0, speed: 0,
      convertTs: spec.convertTs !== false, addedAt: Date.now(), completedAt: 0, error: null,
      // Name guessed from the URL: let the engine use the server's filename / add an extension.
      allowRename: spec.allowRename ?? !spec.name,
      meta: spec.meta || null, // { duration, width, height } for videos, shown in Properties
      activeMs: 0, resumable: null,
      speedLimitKBps: Math.max(0, Number(spec.speedLimitKBps) || 0),
      expectedHash: util.hashKind(spec.expectedHash) ? spec.expectedHash.trim().toLowerCase() : '',
      verify: '', incognito: !!spec.incognito, queue: this.queueIds().includes(spec.queue) ? spec.queue : 'main',
    };
    // A queue with a schedule keeps new downloads until its time window opens.
    if (spec.start !== false && this.scheduler && this.scheduler.waitsForSchedule(rec.queue)) rec.state = 'scheduled';
    this.records.set(id, rec);
    this.persist();
    this.emitList();
    if (rec.state === 'queued') this.enqueue(id);
    return rec;
  }

  enqueue(id) {
    const rec = this.records.get(id);
    if (!rec || rec.state === 'done') return;
    if (rec.native) {
      const item = this.natives.get(id);
      if (item && item.canResume()) { item.resume(); rec.state = 'downloading'; this.emitRecord(rec); return; }
      if (!item) return; // gone with the last session: use "Download again"
    }
    rec.state = 'queued';
    rec.error = null; rec.errorCode = null;
    rec.wasRunning = false;
    if (!this.queue.includes(id)) this.queue.push(id);
    this.emitRecord(rec);
    this.pump();
  }

  activeCount() {
    let n = 0;
    for (const r of this.records.values()) if (r.state === 'downloading' || r.state === 'connecting') n++;
    return n;
  }

  // ---- queues -----------------------------------------------------------------------------------

  queues() { return normalizeQueues(this.settings.get('queues')); }

  queueIds() { return this.queues().map((q) => q.id); }

  queueLimit(qid) {
    const q = this.queues().find((x) => x.id === qid);
    return (q && q.maxActive) || this.settings.get('maxActive') || 3;
  }

  queueActive(qid) {
    let n = 0;
    for (const r of this.records.values()) if ((r.queue || 'main') === qid && (r.state === 'downloading' || r.state === 'connecting')) n++;
    return n;
  }

  /** Scheduler: a queue's window opened. Its unfinished downloads start (errors with a dead link don't). */
  startQueue(qid) {
    for (const r of [...this.records.values()].sort((a, b) => a.addedAt - b.addedAt)) {
      if ((r.queue || 'main') !== qid || r.native) continue;
      if (['scheduled', 'paused'].includes(r.state) || (r.state === 'error' && r.errorCode !== 'LINK_EXPIRED')) this.enqueue(r.id);
    }
  }

  /** Scheduler: a queue's window closed. Its downloads pause and wait for the next window. */
  stopQueue(qid) {
    for (const r of this.records.values()) {
      if ((r.queue || 'main') !== qid) continue;
      if (['downloading', 'connecting', 'queued'].includes(r.state)) this.pause(r.id, 'scheduled');
    }
  }

  setQueue(id, qid) {
    const rec = this.records.get(id);
    if (!rec || !this.queueIds().includes(qid)) return;
    rec.queue = qid;
    if (rec.state === 'scheduled' && !(this.scheduler && this.scheduler.waitsForSchedule(qid))) rec.state = 'paused';
    else if (['paused', 'queued'].includes(rec.state) && this.scheduler && this.scheduler.waitsForSchedule(qid)) this.pause(id, 'scheduled');
    this.persist(); this.emitRecord(rec);
    this.pump();
  }

  // Start queued downloads while there is room, overall and in each download's queue.
  pump() {
    const max = this.settings.get('maxActive') || 3;
    let i = 0;
    while (this.activeCount() < max && i < this.queue.length) {
      const id = this.queue[i];
      const rec = this.records.get(id);
      if (!rec || rec.state === 'done') { this.queue.splice(i, 1); continue; }
      const qid = rec.queue || 'main';
      if (this.queueActive(qid) >= this.queueLimit(qid)) { i++; continue; }
      this.queue.splice(i, 1);
      this.run(rec);
    }
    this.checkAllDone();
  }

  // "When all downloads finish": nothing running or waiting, after at least one finished.
  checkAllDone() {
    if (!this._finishedSinceIdle || this.activeCount() > 0 || this.queue.length) return;
    for (const r of this.records.values()) if (r.state === 'connecting' || r._pausing) return;
    clearTimeout(this._allDoneTimer);
    this._allDoneTimer = setTimeout(() => {
      if (this.activeCount() > 0 || this.queue.length) return;
      this._finishedSinceIdle = false;
      this.emit('all-done');
    }, 1500);
  }

  taskLimiter(rec) {
    let l = this.taskLimiters.get(rec.id);
    if (!l) { l = new RateLimiter(0); this.taskLimiters.set(rec.id, l); }
    l.setRate((rec.speedLimitKBps || 0) * 1024);
    return l;
  }

  /** Per-download speed limit in KB/s (0 = only the global limit). Applies immediately. */
  setSpeedLimit(id, kbps) {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.speedLimitKBps = Math.max(0, Number(kbps) || 0);
    const l = this.taskLimiters.get(id);
    if (l) l.setRate(rec.speedLimitKBps * 1024);
    this.persist(); this.emitRecord(rec);
  }

  makeEngine(rec) {
    const common = {
      id: rec.id, savePath: rec.savePath, headers: rec.headers, session: rec.incognito ? this.privateSession : this.session,
      limiter: this.limiter, taskLimiter: this.taskLimiter(rec), transport: this.transport, retries: this.settings.get('retries'),
      retryDelayMs: (this.settings.get('retryDelaySec') || 3) * 1000,
      timeoutMs: (this.settings.get('timeoutSec') || 30) * 1000,
    };
    if (rec.kind === 'hls') {
      return new HlsDownload({
        ...common, playlistUrl: rec.playlistUrl, mirrors: rec.mirrors,
        concurrency: Math.min(16, this.settings.get('connections') || 6),
        convertTs: rec.convertTs, sizeEstimate: rec.size,
      });
    }
    return new HttpDownload({
      ...common, sources: rec.sources.concat(rec.mirrors), size: rec.size,
      connections: this.settings.get('connections') || 8,
      minSplitBytes: (this.settings.get('minSplitKB') || 512) * 1024,
      allowRename: !!rec.allowRename && rec.received === 0,
    });
  }

  async run(rec) {
    rec.state = 'connecting';
    rec.error = null;
    // A pause that is still finishing (last write, saving progress) must complete first.
    if (rec._pausing) await rec._pausing;
    if (rec.state !== 'connecting') return; // paused or removed meanwhile
    const engine = this.makeEngine(rec);
    this.engines.set(rec.id, engine);
    const current = () => this.engines.get(rec.id) === engine;
    rec.runStartedAt = Date.now();
    engine.on('renamed', (p) => {
      rec.savePath = p; rec.name = path.basename(p); rec.allowRename = false;
      this.persist(); this.emitRecord(rec);
    });
    engine.on('progress', (p) => {
      if (!current()) return; // late event from an engine that was paused/cancelled
      rec.state = p.state; rec.size = p.size; rec.received = p.received;
      rec.speed = p.speed; rec.percent = p.percent; rec.error = p.error;
      if (p.resumable !== undefined) rec.resumable = p.resumable;
      if (p.segments) { rec.segments = p.segments; rec.doneSegments = p.doneSegments; }
      rec.connections = p.connections || 0; rec.directConnections = p.directConnections || 0;
      rec.errorCode = p.errorCode || null;
      this.emitRecord(rec);
    });
    engine.on('done', () => {
      this.addActiveTime(rec);
      rec.state = 'done'; rec.completedAt = Date.now(); rec.speed = 0; rec.percent = 100;
      try { rec.size = fs.statSync(rec.savePath).size; rec.received = rec.size; } catch {}
      this.engines.delete(rec.id);
      this.taskLimiters.delete(rec.id);
      this.persist(); this.emitRecord(rec);
      this.finishVerify(rec).then(() => this.postProcess(rec)).catch(() => {}).finally(() => {
        this._finishedSinceIdle = true;
        this.emit('completed', rec);
        this.pump();
      });
    });
    engine.on('error', (err) => {
      if (!current()) return;
      this.addActiveTime(rec);
      rec.state = 'error'; rec.error = String(err.message || err); rec.errorCode = err.code || null; rec.speed = 0;
      rec.connections = 0;
      this.engines.delete(rec.id);
      this.persist(); this.emitRecord(rec);
      this.emit('failed', rec);
      this._finishedSinceIdle = true;
      this.pump();
    });
    engine.start();
  }

  /** Pause, keeping progress. toState 'scheduled' = paused by the scheduler until the next window. */
  pause(id, toState = 'paused') {
    const rec = this.records.get(id);
    if (!rec || rec.state === 'done') return;
    if (rec.native) {
      const item = this.natives.get(id);
      if (item && item.canResume !== undefined) { try { item.pause(); } catch {} }
      rec.state = 'paused'; rec.speed = 0;
      return this.emitRecord(rec);
    }
    this.queue = this.queue.filter((q) => q !== id);
    const engine = this.engines.get(id);
    this.engines.delete(id);
    this.addActiveTime(rec);
    rec.state = toState; rec.speed = 0;
    if (engine) {
      rec._pausing = Promise.resolve(engine.pause())
        .then(() => {
          // Final numbers after the last write (the last progress event may be older).
          const p = engine.progress();
          rec.received = p.received;
          rec.percent = p.percent;
          if (p.size > 0) rec.size = p.size;
          if (p.segments) { rec.segments = p.segments; rec.doneSegments = p.doneSegments; }
        })
        .catch(() => {})
        .finally(() => { rec._pausing = null; this.persist(); this.emitRecord(rec); });
    }
    this.persist(); this.emitRecord(rec);
    this.pump();
  }

  resume(id) { this.enqueue(id); }

  /** Pause every running download and wait (up to timeoutMs) until their progress is saved. */
  async shutdown(timeoutMs = 4000) {
    for (const r of this.records.values()) {
      if (['downloading', 'connecting', 'queued'].includes(r.state)) r.wasRunning = true;
    }
    this.queue = [];
    const running = [...this.records.values()].filter((r) => this.engines.has(r.id));
    for (const r of running) this.pause(r.id);
    const waits = running.map((r) => r._pausing).filter(Boolean);
    await Promise.race([Promise.allSettled(waits), new Promise((res) => setTimeout(res, timeoutMs))]);
    this.persist();
  }

  pauseAll() { for (const r of this.records.values()) if (['downloading', 'connecting', 'queued'].includes(r.state)) this.pause(r.id); }

  resumeAll() { for (const r of this.records.values()) if (['paused', 'error'].includes(r.state)) this.enqueue(r.id); }

  async cancel(id, deleteFile = true) {
    const rec = this.records.get(id);
    if (!rec) return;
    this.queue = this.queue.filter((q) => q !== id);
    const engine = this.engines.get(id);
    this.engines.delete(id);
    this.records.delete(id);
    this.taskLimiters.delete(id);
    const item = this.natives.get(id);
    if (item) { this.natives.delete(id); try { item.cancel(); } catch {} }
    this.persist(); this.emitList();
    if (engine) { try { await engine.cancel(); } catch {} }
    if (rec._pausing) await rec._pausing;
    if (deleteFile) {
      for (const f of [rec.savePath, rec.savePath + '.part', rec.savePath + '.part.meta', rec.savePath + '.part.m3u8']) {
        try { fs.rmSync(f, { force: true }); } catch {}
      }
    }
    this.pump();
  }

  remove(id) {
    // Remove from the list only; the file stays on disk.
    const rec = this.records.get(id);
    if (!rec) return;
    if (rec.state !== 'done') return this.cancel(id, true);
    this.records.delete(id);
    this.persist(); this.emitList();
  }

  // Start the same download again as a new entry (new file name if the old file still exists).
  redownload(id) {
    const r = this.records.get(id);
    if (!r) return null;
    return this.add({
      kind: r.kind, name: r.name, url: r.sources[0], sources: r.sources, playlistUrl: r.playlistUrl,
      mirrors: r.mirrors, headers: r.headers, pageUrl: r.pageUrl, category: r.category,
      convertTs: r.convertTs, meta: r.meta, allowRename: false, size: r.kind === 'hls' ? r.size : -1,
    });
  }

  clearCompleted() {
    for (const [id, r] of [...this.records]) if (r.state === 'done') this.records.delete(id);
    this.persist(); this.emitList();
  }

  get(id) { return this.records.get(id); }

  // Mark of the Web, then (for programs and archives by default) a Microsoft Defender scan.
  async postProcess(rec) {
    if (this.settings.get('markOfTheWeb') !== false && !rec.native) {
      post.markOfTheWeb(rec.savePath, { url: rec.kind === 'hls' ? rec.playlistUrl : rec.sources[0], referrer: rec.pageUrl, incognito: rec.incognito });
    }
    if (!post.wantsScan(this.settings.get('scanDownloads'), rec.category)) return;
    rec.scan = 'scanning'; this.emitRecord(rec);
    const r = await this.scanFile(rec.savePath);
    rec.scan = r.result; rec.scanDetail = r.detail || '';
    if (r.result === 'threat') this.emit('threat', rec);
    this.persist(); this.emitRecord(rec);
  }

  // Compare the finished file with the checksum given when it was added.
  async finishVerify(rec) {
    if (!rec.expectedHash) return;
    const kind = util.hashKind(rec.expectedHash);
    rec.verify = 'checking'; this.emitRecord(rec);
    try {
      const got = await this.checksum(rec.id, kind);
      rec.verify = got === rec.expectedHash ? 'ok' : 'mismatch';
    } catch {
      rec.verify = 'error';
    }
    this.persist(); this.emitRecord(rec);
  }

  /** Same link already in the list? Returns that record (unfinished ones first) or null. */
  findDuplicate(spec) {
    const norm = (u) => String(u || '').replace(/#.*$/, '');
    const want = norm(spec.kind === 'hls' ? spec.playlistUrl : (spec.url || (spec.sources || [])[0]));
    if (!want) return null;
    let found = null;
    for (const r of this.records.values()) {
      const have = norm(r.kind === 'hls' ? r.playlistUrl : r.sources[0]);
      if (have !== want) continue;
      if (r.state !== 'done') return r;
      if (!found && fs.existsSync(r.savePath)) found = r;
    }
    return found;
  }

  /** Resume downloads that were running or waiting when NovaDM last closed. */
  resumeInterrupted() {
    let n = 0;
    for (const r of this.records.values()) if (r.wasRunning && r.state === 'paused' && !r.native) { this.enqueue(r.id); n++; }
    return n;
  }

  /**
   * Refresh link: continue an unfinished download from a new address (for links that expired).
   * HTTP: the new link must be the same file (same size when known). Progress is kept.
   */
  async refreshLink(id, newUrl, info = {}) {
    const rec = this.records.get(id);
    if (!rec || rec.state === 'done') throw new Error('Nothing to refresh');
    if (!/^https?:\/\//i.test(newUrl || '')) throw new Error('Not a web address');
    const wasActive = this.engines.has(id);
    if (wasActive) { this.pause(id); if (rec._pausing) await rec._pausing; }
    if (rec.kind === 'hls') {
      rec.playlistUrl = newUrl;
      if (info.headers) rec.headers = info.headers;
      try { fs.rmSync(rec.savePath + '.part.m3u8', { force: true }); } catch {}
    } else {
      let size = info.size;
      if (!(size > 0)) {
        try {
          const net = require('../net');
          const p = await net.probe(newUrl, { session: rec.incognito ? this.privateSession : this.session, headers: info.headers || rec.headers, timeoutMs: 15000 });
          size = p.size; newUrl = p.finalUrl || newUrl;
        } catch (e) {
          throw new Error('The new link does not work: ' + (e.message || e));
        }
      }
      if (rec.size > 0 && size > 0 && size !== rec.size) throw new Error('The new link is a different file (size does not match)');
      rec.sources = [newUrl];
      if (info.headers) rec.headers = info.headers;
      // Saved validators belong to the old link (another server may send other ETags): drop them.
      try {
        const metaPath = rec.savePath + '.part.meta';
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        m.sources = [newUrl]; m.validator = null;
        fs.writeFileSync(metaPath, JSON.stringify(m));
      } catch {}
    }
    rec.error = null; rec.errorCode = null;
    this.persist();
    this.enqueue(id);
    return rec;
  }

  /**
   * Track a download the browser handles itself (blob:/data: links, or when NovaDM can't
   * re-request the link). item: Electron DownloadItem, already given its save path.
   */
  addNative(item, spec) {
    const id = util.uid();
    const savePath = item.getSavePath();
    const rec = {
      id, kind: 'http', native: true, name: path.basename(savePath), savePath,
      sources: [item.getURL().slice(0, 2000)], playlistUrl: '', mirrors: [], headers: {}, pageUrl: spec.pageUrl || '',
      category: util.categoryOf(path.basename(savePath), item.getMimeType()), state: 'downloading',
      size: item.getTotalBytes() || -1, received: 0, speed: 0, convertTs: false, addedAt: Date.now(),
      completedAt: 0, error: null, allowRename: false, meta: null, activeMs: 0, resumable: false,
      speedLimitKBps: 0, expectedHash: '', verify: '', incognito: !!spec.incognito, runStartedAt: Date.now(),
    };
    this.records.set(id, rec);
    this.natives.set(id, item);
    let last = { t: Date.now(), b: 0 };
    item.on('updated', (_e, state) => {
      const now = Date.now();
      const b = item.getReceivedBytes();
      if (now - last.t >= 500) { rec.speed = Math.max(0, Math.round((b - last.b) / ((now - last.t) / 1000))); last = { t: now, b }; }
      rec.received = b;
      rec.size = item.getTotalBytes() || rec.size;
      rec.state = state === 'interrupted' ? 'paused' : item.isPaused() ? 'paused' : 'downloading';
      this.emitRecord(rec);
    });
    item.once('done', (_e, state) => {
      this.natives.delete(id);
      this.addActiveTime(rec);
      rec.speed = 0;
      if (state === 'completed') {
        rec.state = 'done'; rec.completedAt = Date.now(); rec.received = item.getReceivedBytes(); rec.size = rec.received;
        this.persist(); this.emitRecord(rec);
        this.emit('completed', rec);
      } else if (this.records.has(id)) {
        rec.state = 'error'; rec.error = state === 'cancelled' ? 'Cancelled' : 'Download interrupted';
        this.persist(); this.emitRecord(rec);
        if (state !== 'cancelled') this.emit('failed', rec);
      }
    });
    this.persist();
    this.emitList();
    return rec;
  }

  /** File hash for the Properties dialog. algo: 'md5' | 'sha1' | 'sha256' | 'sha512'. */
  checksum(id, algo) {
    const r = this.records.get(id);
    if (!r || r.state !== 'done') return Promise.reject(new Error('Only finished downloads can be checked'));
    const crypto = require('crypto');
    return new Promise((resolve, reject) => {
      const h = crypto.createHash(['md5', 'sha1', 'sha256', 'sha512'].includes(algo) ? algo : 'sha256');
      fs.createReadStream(r.savePath).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
  }

  properties(id) {
    const r = this.records.get(id);
    if (!r) return null;
    let modifiedAt = 0;
    let fileExists = false;
    try { const st = fs.statSync(r.state === 'done' ? r.savePath : r.savePath + '.part'); modifiedAt = st.mtimeMs; fileExists = true; } catch {}
    const activeMs = this.activeMs(r);
    return {
      ...this.summary(r),
      folder: path.dirname(r.savePath), sourceUrl: r.kind === 'hls' ? r.playlistUrl : (r.sources[0] || ''),
      mirrors: r.mirrors || [], activeMs, modifiedAt, fileExists,
      avgSpeed: activeMs > 1000 ? Math.round(r.received / (activeMs / 1000)) : 0,
      meta: r.meta || null, convertTs: r.convertTs,
      connections: r.state === 'downloading' ? r.connections || 0 : 0, directConnections: r.directConnections || 0,
      speedLimitKBps: r.speedLimitKBps || 0, expectedHash: r.expectedHash || '', verify: r.verify || '',
      native: !!r.native, incognito: !!r.incognito, scanDetail: r.scanDetail || '',
    };
  }

  summary(r) {
    const hls = r.kind === 'hls';
    return {
      id: r.id, kind: r.kind, name: r.name, savePath: r.savePath, category: r.category,
      state: r.state, size: r.size, received: r.received, speed: r.speed || 0,
      percent: r.state === 'done' ? 100 : hls ? (r.percent || 0) : r.size > 0 ? Math.min(100, (r.received / r.size) * 100) : (r.percent || 0),
      sizeIsEstimate: hls && r.state !== 'done', resumable: r.resumable,
      pageUrl: r.pageUrl, addedAt: r.addedAt, completedAt: r.completedAt, error: r.error,
      segments: r.segments, doneSegments: r.doneSegments, activeMs: this.activeMs(r),
      errorCode: r.errorCode || null, verify: r.verify || '', native: !!r.native, incognito: !!r.incognito,
      queue: r.queue || 'main', scan: r.scan || '',
    };
  }

  list() {
    return [...this.records.values()].sort((a, b) => b.addedAt - a.addedAt).map((r) => this.summary(r));
  }

  activeSummary() {
    let active = 0; let speed = 0;
    for (const r of this.records.values()) {
      if (r.state === 'downloading' || r.state === 'connecting') { active++; speed += r.speed || 0; }
    }
    return { active, speed, total: this.records.size };
  }

  emitRecord(rec) { this.emit('updated', rec.id); this.emitList(); }

  emitList() {
    clearTimeout(this._listTimer);
    this._listTimer = setTimeout(() => this.emit('changed'), 120);
  }
}

module.exports = { DownloadManager };
