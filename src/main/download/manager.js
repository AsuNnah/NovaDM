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

class DownloadManager extends EventEmitter {
  /** opts: { transport } - the direct/browser transport for HTTP and HLS engines (see transport.js). */
  constructor(settings, session, opts = {}) {
    super();
    this.settings = settings;
    this.session = session;
    this.transport = opts.transport || null;
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
      rec.speed = 0;
      this.records.set(rec.id, rec);
    }
  }

  persist() {
    this.store.data.items = [...this.records.values()].map((r) => ({
      id: r.id, kind: r.kind, name: r.name, savePath: r.savePath, sources: r.sources,
      playlistUrl: r.playlistUrl, mirrors: r.mirrors, headers: r.headers, pageUrl: r.pageUrl,
      category: r.category, state: r.state, size: r.size, received: r.received,
      convertTs: r.convertTs, addedAt: r.addedAt, completedAt: r.completedAt, error: r.error,
      allowRename: r.allowRename, resumable: r.resumable, segments: r.segments, doneSegments: r.doneSegments,
      activeMs: r.activeMs || 0, meta: r.meta || null, percent: r.percent || 0,
      wasRunning: !!r.wasRunning, errorCode: r.errorCode || null,
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
    let dir = this.categoryDir(category);
    if (spec.subdir) dir = path.join(dir, util.sanitizeFilename(spec.subdir, 'Page'));
    const name = util.sanitizeFilename(spec.name || util.filenameFromUrl(spec.url || spec.playlistUrl) || 'download');
    const savePath = util.uniquePath(path.join(dir, name), this.reservedPaths());
    const rec = {
      id, kind: spec.kind, name: path.basename(savePath), savePath,
      sources: spec.sources || (spec.url ? [spec.url] : []), playlistUrl: spec.playlistUrl || '',
      mirrors: spec.mirrors || [], headers: spec.headers || {}, pageUrl: spec.pageUrl || '',
      category, state: 'queued', size: spec.size ?? -1, received: 0, speed: 0,
      convertTs: spec.convertTs !== false, addedAt: Date.now(), completedAt: 0, error: null,
      // Name guessed from the URL: let the engine use the server's filename / add an extension.
      allowRename: spec.allowRename ?? !spec.name,
      meta: spec.meta || null, // { duration, width, height } for videos, shown in Properties
      activeMs: 0, resumable: null,
    };
    this.records.set(id, rec);
    this.persist();
    this.emitList();
    if (spec.start !== false) this.enqueue(id);
    return rec;
  }

  enqueue(id) {
    const rec = this.records.get(id);
    if (!rec || rec.state === 'done') return;
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

  pump() {
    const max = this.settings.get('maxActive') || 3;
    while (this.activeCount() < max && this.queue.length) {
      const id = this.queue.shift();
      const rec = this.records.get(id);
      if (!rec || rec.state === 'done') continue;
      this.run(rec);
    }
  }

  makeEngine(rec) {
    const common = {
      id: rec.id, savePath: rec.savePath, headers: rec.headers, session: this.session,
      limiter: this.limiter, transport: this.transport, retries: this.settings.get('retries'),
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
      this.persist(); this.emitRecord(rec);
      this.emit('completed', rec);
      this.pump();
    });
    engine.on('error', (err) => {
      if (!current()) return;
      this.addActiveTime(rec);
      rec.state = 'error'; rec.error = String(err.message || err); rec.errorCode = err.code || null; rec.speed = 0;
      rec.connections = 0;
      this.engines.delete(rec.id);
      this.persist(); this.emitRecord(rec);
      this.pump();
    });
    engine.start();
  }

  pause(id) {
    const rec = this.records.get(id);
    if (!rec || rec.state === 'done') return;
    this.queue = this.queue.filter((q) => q !== id);
    const engine = this.engines.get(id);
    this.engines.delete(id);
    this.addActiveTime(rec);
    rec.state = 'paused'; rec.speed = 0;
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
    this.persist(); this.emitList();
    if (engine) { try { await engine.cancel(); } catch {} }
    if (rec._pausing) await rec._pausing;
    if (deleteFile) {
      for (const f of [rec.savePath, rec.savePath + '.part', rec.savePath + '.part.meta']) {
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

  /** File hash for the Properties dialog. algo: 'md5' | 'sha256'. */
  checksum(id, algo) {
    const r = this.records.get(id);
    if (!r || r.state !== 'done') return Promise.reject(new Error('Only finished downloads can be checked'));
    const crypto = require('crypto');
    return new Promise((resolve, reject) => {
      const h = crypto.createHash(algo === 'md5' ? 'md5' : 'sha256');
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
