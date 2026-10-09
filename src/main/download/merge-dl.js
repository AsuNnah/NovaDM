'use strict';
// Download a video whose picture and sound are separate streams and save them as one MP4:
//  - DASH (.mpd): the chosen video and audio representations (SegmentTemplate/List/Base)
//  - HLS with a separate audio rendition (#EXT-X-MEDIA TYPE=AUDIO with its own playlist)
// Tracks are fragmented MP4 (CMAF) or MPEG-TS (converted per track); AES-128 HLS segments are
// decrypted. Fragments are written interleaved in time order through Mp4Merger, so the file is a
// normal MP4 with one video and one audio track. Checkpoints (synced, then saved) allow resuming;
// the resolved track lists are kept next to the download so a resume works after the links expire.
// Tracks that are not fragmented MP4 (WebM, or plain MP4 files) are saved as separate files and
// joined by FFmpeg at the end ("files" mode); without FFmpeg the user is asked to install it first.
// Live DASH (type="dynamic") is recorded: the manifest is read again and new segments are added
// until the user stops the recording or the stream ends; the file is finished and playable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const net = require('../net');
const hls = require('../media/hls');
const dash = require('../media/dash');
const { Mp4Merger, readBoxes, child, children } = require('../media/mp4');
const { HttpError } = net;

const CHECKPOINT_MS = 10000;
const CHECKPOINT_BYTES = 32 * 1024 * 1024;
const BROWSER_H1_CAP = 6;
const LIVE_START_SECONDS = 3; // a recording starts about this many segments' worth before the live edge

class MergeDownload extends EventEmitter {
  /**
   * opts: id, savePath, source, headers, session, transport, limiter, taskLimiter, concurrency,
   *   retries, retryDelayMs, timeoutMs, openConn/fetchText (tests)
   * source: { type: 'dash', url, height, videoId, audioId, lang }
   *       | { type: 'hls', url (master or video playlist), audioUrl, height, lang }
   *       | { type: 'direct', tracks: [{ kind: 'video' | 'audio', url, headers }] }  (e.g. from yt-dlp)
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.savePath = opts.savePath;
    this.partPath = opts.savePath + '.part';
    this.metaPath = opts.savePath + '.part.meta';
    this.tracksPath = opts.savePath + '.part.tracks';
    this.source = opts.source;
    this.headers = opts.headers || {};
    this.session = opts.session;
    this.transport = opts.transport || null;
    this.limiter = opts.limiter;
    this.taskLimiter = opts.taskLimiter || null;
    this.concurrency = Math.min(32, Math.max(1, opts.concurrency || 6));
    this.retries = opts.retries ?? 10;
    this.retryDelayMs = opts.retryDelayMs ?? 3000;
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this._openConn = opts.openConn || null;
    this._fetchText = opts.fetchText || null;
    this.reresolve = !!opts.reresolve; // after Refresh link: read the new manifest, keep progress if it matches
    this.ffmpeg = opts.ffmpeg || null;
    this.mode = 'merge'; // 'merge' (our own MP4 merger) | 'files' (separate files, FFmpeg joins them)
    this.files = []; // files mode: one { path, fd, written } per track
    this.checkpointMs = opts.checkpointMs || CHECKPOINT_MS;
    this.checkpointBytes = opts.checkpointBytes || CHECKPOINT_BYTES;

    this.state = 'queued';
    this.error = null;
    this.tracks = []; // { kind, container, initSpec, segments, init, nextFetch, nextWrite, ready, tx }
    this.merger = null;
    this.shifts = [];
    this.out = null;
    this.writtenBytes = 0;
    this.receivedBytes = 0;
    this.httpMajor = 0;
    this.keys = new Map();
    this._speed = [];
    this._lastEmit = 0;
    this._stopping = false;
    this._workers = 0;
    this._lastCheckpoint = 0;
    this._checkpointWritten = 0;
    this._wake = null;
    this.live = false;
    this.liveEnded = false; // recording stopped by the user, or the stream ended
    this.liveGaps = 0; // segments that left the manifest before they could be fetched
  }

  get totalSegments() { return this.tracks.reduce((s, t) => s + t.segments.length, 0); }
  get doneSegments() { return this.tracks.reduce((s, t) => s + t.nextWrite, 0); }

  // ---- lifecycle --------------------------------------------------------------------------------

  async start() {
    if (this.state === 'downloading') return;
    this._stopping = false;
    this.error = null;
    this.state = 'downloading';
    this.emitUpdate(true);
    try {
      fs.mkdirSync(path.dirname(this.savePath), { recursive: true });
      if (this.reresolve && fs.existsSync(this.metaPath)) await this.refreshTracks();
      const resumed = this.tryResume();
      if (!resumed) {
        await this.resolveTracks();
        if (this._stopping) return;
        await this.prepareFresh();
      }
      if (this._stopping) return;
      if (this.live) this.startLivePolling();
      await this.run();
      if (this._stopping) return;
      await this.finish();
    } catch (err) {
      if (!this._stopping) this.fail(err);
    }
  }

  // ---- what to download --------------------------------------------------------------------------

  async resolveTracks() {
    const src = this.source;
    let defs;
    if (src.type === 'dash') defs = await this.resolveDash(src);
    else if (src.type === 'direct') defs = await this.resolveDirect(src);
    else defs = await this.resolveHls(src);
    defs = defs.filter((d) => d.segments.length);
    if (!defs.length) throw new Error('Nothing to download in this stream');
    this.tracks = defs.map((d) => ({ ...d, init: null, nextFetch: 0, nextWrite: 0, ready: new Map(), tx: null }));
    try { fs.writeFileSync(this.tracksPath, JSON.stringify(defs)); } catch {}
  }

  // Refresh link: the new manifest replaces the saved track list if it has the same segments
  // (new addresses, same video); otherwise the download starts over.
  async refreshTracks() {
    let old = null;
    try { old = JSON.parse(fs.readFileSync(this.tracksPath, 'utf8')); } catch {}
    await this.resolveTracks();
    const fresh = this.tracks;
    const same = Array.isArray(old) && old.length === fresh.length && old.every((o, i) => o.kind === fresh[i].kind && o.segments.length === fresh[i].segments.length);
    if (!same) { try { fs.rmSync(this.metaPath, { force: true }); } catch {} }
  }

  async resolveDash(src) {
    const r = await this.fetchText(src.url);
    const mpd = dash.parse(r.text, r.finalUrl || src.url);
    if (mpd.live) return this.resolveLiveDash(src, mpd, r.finalUrl || src.url);
    const defs = [];
    const want = { height: src.height, videoId: src.videoId, audioId: src.audioId, lang: src.lang };
    // One video and one audio track across all periods (ads/chapters): their segments in a row.
    for (const kind of ['video', 'audio']) {
      let def = null;
      for (const period of mpd.periods) {
        const picked = dash.pick(period, want);
        if (picked.drm) { const e = new Error('This stream is DRM-protected and cannot be downloaded'); e.code = 'DRM'; throw e; }
        const rep = picked[kind];
        if (!rep) continue;
        const s = dash.segmentsFor(rep);
        let segments = s.segments;
        if (s.index) {
          const idx = await this.getBytes(s.index.url, s.index.range);
          segments = dash.segmentsFromSidx(idx, s.index.url, s.index.range.offset);
        }
        let initSpec = s.init;
        let raw = false;
        if (s.whole) {
          // One file for the whole representation: split it by its own index, or into byte ranges.
          const w = await this.splitWholeFile(s.segments[0].url, rep._periodDuration);
          segments = w.segments; initSpec = w.initSpec; raw = w.raw;
        }
        const shifted = segments.map((x) => ({ url: x.url, range: x.range, time: (x.time || 0) + period.start, duration: x.duration || 0 }));
        if (!def) def = { kind, container: 'fmp4', initSpec, raw, segments: [], label: rep.height ? `${rep.height}p` : rep.lang || kind };
        def.segments.push(...shifted);
      }
      if (def) defs.push(def);
    }
    return defs;
  }

  // ---- live DASH ------------------------------------------------------------------------------

  /** The current period of a live manifest: the chosen video and audio, from near the live edge. */
  resolveLiveDash(src, mpd, url) {
    this.live = true;
    const period = mpd.periods[mpd.periods.length - 1];
    if (!period) throw new Error('Nothing to download in this stream');
    const picked = dash.pick(period, { height: src.height, videoId: src.videoId, audioId: src.audioId, lang: src.lang });
    if (picked.drm) { const e = new Error('This stream is DRM-protected and cannot be downloaded'); e.code = 'DRM'; throw e; }
    this.liveSrc = { url, periodId: period.id, ids: {}, minUpdate: mpd.minimumUpdatePeriod || 0 };
    const defs = [];
    for (const kind of ['video', 'audio']) {
      const rep = picked[kind];
      if (!rep) continue;
      const s = dash.segmentsFor(rep);
      if (s.index || s.whole) throw new Error('This live stream type can’t be recorded');
      this.liveSrc.ids[kind] = rep.id;
      defs.push({ kind, container: 'fmp4', initSpec: s.init, raw: false, label: rep.height ? `${rep.height}p` : rep.lang || kind, segments: s.segments.map((x) => ({ url: x.url, range: x.range, time: x.time + period.start, duration: x.duration })) });
    }
    // Start a few seconds before the live edge, at the same moment on every track.
    const edge = Math.min(...defs.filter((d) => d.segments.length).map((d) => { const l = d.segments[d.segments.length - 1]; return l.time + l.duration; }));
    const longest = Math.max(...defs.map((d) => Math.max(0, ...d.segments.map((x) => x.duration))));
    const from = edge - Math.max(LIVE_START_SECONDS, longest) * 1.5;
    for (const d of defs) {
      const i = d.segments.findIndex((x) => x.time + x.duration > from);
      if (i > 0) d.segments = d.segments.slice(i);
    }
    this.liveStartedAt = Date.now();
    return defs;
  }

  isRecording() { return this.live && !this.liveEnded; }

  livePollMs() {
    const seg = Math.max(1, ...this.tracks.map((t) => (t.segments[t.segments.length - 1] || {}).duration || 2));
    const every = this.liveSrc.minUpdate > 0 ? Math.min(this.liveSrc.minUpdate, seg) : seg;
    return Math.min(10000, Math.max(1000, every * 1000));
  }

  startLivePolling() {
    this._liveNewAt = Date.now();
    const tick = async () => {
      if (!this.isRecording() || this._stopping) return;
      try {
        await this.addLiveSegments();
        this._liveErrors = 0;
      } catch {
        // Short network trouble is ridden out; a stream that stays unreachable ends the recording.
        if (++this._liveErrors >= 5) this.stopRecording();
      }
      if (this.isRecording() && !this._stopping) this._livePoll = setTimeout(tick, this.livePollMs());
    };
    this._liveErrors = 0;
    this._livePoll = setTimeout(tick, this.livePollMs());
  }

  async addLiveSegments() {
    const r = await this.fetchText(this.liveSrc.url);
    const mpd = dash.parse(r.text, r.finalUrl || this.liveSrc.url);
    const period = mpd.periods.find((p) => p.id === this.liveSrc.periodId) || mpd.periods[mpd.periods.length - 1];
    let added = 0;
    if (period) {
      const reps = period.sets.flatMap((x) => x.representations);
      for (const t of this.tracks) {
        const rep = reps.find((x) => x.id === this.liveSrc.ids[t.kind] && x.kind === t.kind);
        if (!rep) continue;
        const last = t.segments[t.segments.length - 1];
        const lastEnd = last ? last.time + last.duration : -Infinity;
        const fresh = dash.segmentsFor(rep).segments
          .map((x) => ({ url: x.url, range: x.range, time: x.time + period.start, duration: x.duration }))
          .filter((x) => !last || x.time > last.time + 1e-3);
        if (fresh.length && last && fresh[0].time > lastEnd + 0.5) this.liveGaps += Math.round((fresh[0].time - lastEnd) / (last.duration || 1));
        t.segments.push(...fresh);
        added += fresh.length;
      }
    }
    if (added) { this._liveNewAt = Date.now(); if (this._wake) this._wake(); }
    // The broadcast ended (the manifest became static, or a new programme period with other
    // tracks began), or nothing new for a long time: finish the file.
    const stalled = Date.now() - this._liveNewAt > Math.max(30000, this.livePollMs() * 6);
    if (!mpd.live || (period && period.id !== this.liveSrc.periodId) || stalled) this.stopRecording();
  }

  /** Stop recording: what has been listed so far is written and the file is finished. */
  stopRecording() {
    if (!this.live || this.liveEnded) return;
    this.liveEnded = true;
    clearTimeout(this._livePoll);
    if (this._wake) this._wake();
  }

  recordedSeconds() {
    return Math.max(0, ...this.tracks.map((t) => t.segments.slice(0, t.nextWrite).reduce((s, x) => s + (x.duration || 0), 0)));
  }

  // Separate video and audio files given directly (yt-dlp's "best video + best audio").
  async resolveDirect(src) {
    const defs = [];
    for (const t of src.tracks || []) {
      const w = await this.splitWholeFile(t.url, t.duration || 0, t.headers);
      defs.push({ kind: t.kind, container: 'fmp4', initSpec: w.initSpec, raw: w.raw, segments: w.segments, headers: t.headers || null });
    }
    return defs;
  }

  /**
   * A whole media file as segments, without reading it into memory at once:
   *  - fragmented MP4 with an index (sidx) at the start: its fragments, mergeable without FFmpeg
   *  - anything else: 4 MB byte ranges, saved as they are (FFmpeg joins the tracks at the end)
   */
  async splitWholeFile(url, duration = 0, headers = null) {
    const head = await this.getBytes(url, { offset: 0, length: 512 * 1024 }, false, headers);
    const boxes = readBoxes(head);
    const moov = boxes.find((b) => b.type === 'moov');
    const sidx = boxes.find((b) => b.type === 'sidx');
    if (moov && sidx) {
      const segs = dash.segmentsFromSidx(head.subarray(0, sidx.end), url, 0);
      if (segs.length) return { initSpec: { url, range: { offset: 0, length: moov.end } }, segments: segs, raw: false };
    }
    const size = this._lastTotal;
    if (!(size > 0)) throw new Error('The server did not say how big the file is, so it can’t be split');
    const CHUNK = 4 * 1024 * 1024;
    const segments = [];
    for (let off = 0; off < size; off += CHUNK) {
      segments.push({ url, range: { offset: off, length: Math.min(CHUNK, size - off) }, time: duration ? (off / size) * duration : off / CHUNK, duration: 0 });
    }
    return { initSpec: null, segments, raw: true };
  }

  async resolveHls(src) {
    let videoUrl = src.url;
    let audioUrl = src.audioUrl || '';
    const r = await this.fetchText(src.url);
    let p = hls.parse(r.text, r.finalUrl || src.url);
    if (p.type === 'master') {
      if (p.drm) { const e = new Error('This stream is DRM-protected and cannot be downloaded'); e.code = 'DRM'; throw e; }
      const variants = p.variants;
      const v = (src.height && variants.find((x) => x.resolution && x.resolution.height <= src.height)) || variants[0];
      if (!v) throw new Error('Empty master playlist');
      videoUrl = v.url;
      if (!audioUrl && v.audioGroup) {
        const group = p.renditions.filter((x) => x.type === 'AUDIO' && x.groupId === v.audioGroup && x.url);
        const lang = (src.lang || '').toLowerCase();
        const a = (lang && group.find((x) => x.language.toLowerCase().startsWith(lang))) || group.find((x) => x.isDefault) || group[0];
        if (a) audioUrl = a.url;
      }
      p = null;
    }
    const defs = [];
    for (const [kind, url] of [['video', videoUrl], ['audio', audioUrl]]) {
      if (!url) continue;
      let media = p && kind === 'video' ? p : null;
      if (!media) { const t = await this.fetchText(url); media = hls.parse(t.text, t.finalUrl || url); }
      if (media.type !== 'media') throw new Error('Not a media playlist');
      if (media.encryption === 'drm') { const e = new Error('This stream is DRM-protected and cannot be downloaded'); e.code = 'DRM'; throw e; }
      if (media.live) throw new Error('Live streams with separate audio can’t be recorded yet');
      let t = 0;
      const segments = media.segments.map((s) => {
        const seg = { url: s.url, range: s.range, time: t, duration: s.duration || 0, key: s.key, seq: s.seq, discontinuity: s.discontinuity };
        t += s.duration || 0;
        return seg;
      });
      const map = media.segments[0] && media.segments[0].map;
      defs.push({ kind, container: map ? 'fmp4' : 'sniff', initSpec: map ? { url: map.url, range: map.range } : null, segments });
    }
    return defs;
  }

  // First segment of every track: inits (from the stream or from converting TS), the common timeline.
  async prepareFresh() {
    for (const t of this.tracks) {
      if (t.initSpec) t.init = await this.getBytes(t.initSpec.url, t.initSpec.range, false, t.headers);
      const first = await this.fetchSegment(t, 0);
      if (t.container === 'sniff') {
        const kind = hls.sniffContainer(first);
        t.container = kind === 'fmp4' ? 'fmp4' : 'ts';
      }
      if (t.raw || (t.container !== 'ts' && needsFfmpeg(t, first))) {
        t.raw = true;
        t.webm = isWebm(t.init) || isWebm(first);
        t.ready.set(0, first);
        t.nextFetch = 1;
        continue;
      }
      if (t.container === 'ts') {
        t.tx = new TrackTransmuxer(t.kind);
        const frags = t.tx.convert(first);
        if (!t.tx.init) throw new Error(`No ${t.kind} found in the ${t.kind} stream`);
        t.init = t.tx.init;
        t.ready.set(0, frags);
      } else {
        if (!t.init) {
          // A whole-file or self-initialising track: the first segment carries ftyp+moov itself.
          if (readBoxes(first).some((b) => b.type === 'moov')) t.init = first;
          else throw new Error('The stream has no MP4 header');
        }
        t.ready.set(0, first);
      }
      t.nextFetch = 1;
    }
    if (this.tracks.some((t) => t.raw)) return this.prepareFiles();
    this.merger = new Mp4Merger(this.tracks.map((t) => t.init));
    // Common timeline: the earliest track starts at 0, the others keep their offset (A/V sync).
    const starts = this.tracks.map((t, i) => firstDecodeTime(t.ready.get(0), this.merger.tracks.find((x) => x.input === i)));
    const min = Math.min(...starts.map((s) => s.seconds));
    this.shifts = this.tracks.map((t, i) => -Math.round(min * this.merger.tracks.find((x) => x.input === i).timescale));
    this.merger.timeShift = this.shifts.slice();
    this.out = fs.openSync(this.partPath, 'w');
    await this.writeOut(this.merger.init);
    this._lastCheckpoint = Date.now();
    this.saveMeta();
  }

  // WebM or plain MP4 tracks: each to its own file (init + segments as they are), FFmpeg joins them.
  async prepareFiles() {
    if (!this.ffmpeg || !this.ffmpeg.available()) {
      const e = new Error('Picture and sound of this video come as separate WebM/MP4 files; joining them needs FFmpeg. Install it in Settings → Video tools, then retry.');
      e.code = 'NEEDS_FFMPEG';
      throw e;
    }
    this.mode = 'files';
    this.files = this.tracks.map((t) => ({ path: `${this.savePath}.${t.kind}.part`, fd: null, written: 0 }));
    for (const [i, t] of this.tracks.entries()) {
      const f = this.files[i];
      f.fd = fs.openSync(f.path, 'w');
      if (t.init && t.ready.get(0) !== t.init) await this.writeTrack(i, t.init);
    }
    this._lastCheckpoint = Date.now();
    this.saveMeta();
  }

  writeTrack(i, buf) {
    const f = this.files[i];
    return new Promise((resolve, reject) => fs.write(f.fd, buf, 0, buf.length, null, (err) => {
      if (err) return reject(err);
      f.written += buf.length;
      this.writtenBytes += buf.length;
      resolve();
    }));
  }

  tryResume() {
    let m; let defs;
    try {
      m = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
      defs = JSON.parse(fs.readFileSync(this.tracksPath, 'utf8'));
    } catch { return false; }
    if (!m || m.v !== 1 || m.kind !== 'merge' || !Array.isArray(defs) || defs.length !== m.next.length) return false;
    if (m.mode === 'files') return this.resumeFiles(m, defs);
    let size = -1;
    try { size = fs.statSync(this.partPath).size; } catch { return false; }
    if (size < m.written) return false;
    fs.truncateSync(this.partPath, m.written);
    this.tracks = defs.map((d, i) => ({
      ...d, container: m.containers[i], init: Buffer.from(m.inits[i], 'base64'), nextFetch: m.next[i], nextWrite: m.next[i], ready: new Map(),
      tx: m.containers[i] === 'ts' ? new TrackTransmuxer(d.kind, Buffer.from(m.inits[i], 'base64')) : null,
    }));
    for (const [url, hex] of Object.entries(m.keys || {})) this.keys.set(url, Buffer.from(hex, 'hex'));
    this.merger = new Mp4Merger(this.tracks.map((t) => t.init));
    this.merger.restore(m.merger);
    this.shifts = m.shifts;
    this.merger.timeShift = this.shifts.slice();
    if (m.lastEnd) this.merger.lastEnd = m.lastEnd;
    this.out = fs.openSync(this.partPath, 'a');
    this.writtenBytes = m.written;
    this._checkpointWritten = m.written;
    this._lastCheckpoint = Date.now();
    this.resumed = true;
    return true;
  }

  resumeFiles(m, defs) {
    if (!this.ffmpeg || !this.ffmpeg.available()) return false;
    const files = defs.map((d, i) => ({ path: `${this.savePath}.${d.kind}.part`, fd: null, written: m.files[i] }));
    for (const f of files) {
      let size = -1;
      try { size = fs.statSync(f.path).size; } catch { return false; }
      if (size < f.written) return false;
    }
    for (const f of files) { fs.truncateSync(f.path, f.written); f.fd = fs.openSync(f.path, 'a'); }
    this.mode = 'files';
    this.files = files;
    this.tracks = defs.map((d, i) => ({ ...d, raw: true, webm: !!(m.webm && m.webm[i]), nextFetch: m.next[i], nextWrite: m.next[i], ready: new Map() }));
    this.writtenBytes = files.reduce((a, f) => a + f.written, 0);
    this._checkpointWritten = this.writtenBytes;
    this._lastCheckpoint = Date.now();
    this.resumed = true;
    return true;
  }

  // ---- downloading ---------------------------------------------------------------------------------

  async run() {
    const done = new Promise((resolve) => { this._allDone = resolve; });
    const workers = [];
    for (let i = 0; i < this.concurrency; i++) workers.push(this.worker());
    this.writer().then(() => this._allDone(), (err) => { this.error = err; this.stop(); this._allDone(); });
    await done;
    this._stopping = this._stopping || false;
    await Promise.allSettled(workers);
    if (this.error) throw this.error;
  }

  // Next segment to fetch: the earliest (by time) among tracks that are not too far ahead.
  pickFetch() {
    let best = null;
    for (const t of this.tracks) {
      if (t.nextFetch >= t.segments.length) continue;
      if (t.nextFetch - t.nextWrite >= Math.max(6, this.concurrency * 2)) continue;
      if (!best || t.segments[t.nextFetch].time < best.segments[best.nextFetch].time) best = t;
    }
    return best;
  }

  async worker() {
    while (!this._stopping) {
      const t = this.pickFetch();
      if (!t) {
        if (this.tracks.every((x) => x.nextFetch >= x.segments.length) && !this.isRecording()) return;
        await sleep(this.isRecording() ? 200 : 30);
        continue;
      }
      const idx = t.nextFetch++;
      try {
        const buf = await this.fetchSegment(t, idx);
        if (this._stopping) return;
        t.ready.set(idx, buf);
        if (this._wake) this._wake();
      } catch (err) {
        if (this._stopping) return;
        this.error = err;
        this.stop();
        return;
      }
    }
  }

  // Write fragments in time order (deterministic, so resuming continues at the same place). A pause
  // waits for the segment being written, so progress never records half a segment.
  async writer() {
    while (!this._stopping) {
      let release;
      this._writing = new Promise((r) => { release = r; });
      try {
        if ((await this.writeNext()) === 'done') return;
      } finally {
        release();
      }
    }
  }

  async writeNext() {
    let t = null;
    // While recording, a track only goes ahead when the others have their next segment listed too,
    // so picture and sound stay interleaved in time order.
    const waitAll = this.isRecording() && this.tracks.some((x) => x.nextWrite >= x.segments.length);
    for (const x of this.tracks) {
      if (waitAll || x.nextWrite >= x.segments.length) continue;
      if (!t || x.segments[x.nextWrite].time < t.segments[t.nextWrite].time) t = x;
    }
    if (!t && this.isRecording()) {
      await new Promise((resolve) => { this._wake = resolve; setTimeout(resolve, 300); });
      this._wake = null;
      return 'wait';
    }
    if (!t) return 'done'; // all written
    const i = this.tracks.indexOf(t);
    const idx = t.nextWrite;
    if (!t.ready.has(idx)) {
      await new Promise((resolve) => { this._wake = resolve; setTimeout(resolve, 200); });
      this._wake = null;
      return 'wait';
    }
    const raw = t.ready.get(idx);
    t.ready.delete(idx);
    if (this.mode === 'files') {
      await this.writeTrack(i, raw);
      t.nextWrite++;
      if (Date.now() - this._lastCheckpoint >= this.checkpointMs || this.writtenBytes - this._checkpointWritten >= this.checkpointBytes) await this.checkpoint();
      this.emitUpdate();
      return 'wrote';
    }
    const frags = t.container === 'ts' && !Array.isArray(raw) ? t.tx.convert(raw) : raw;
    for (const piece of Array.isArray(frags) ? frags : [frags]) {
      const f = this.merger.fragment(i, piece, { absOffset: t.segments[idx].range ? t.segments[idx].range.offset : 0, durationHint: t.segments[idx].duration });
      if (f) await this.writeOut(f.data);
    }
    t.nextWrite++;
    if (Date.now() - this._lastCheckpoint >= this.checkpointMs || this.writtenBytes - this._checkpointWritten >= this.checkpointBytes) await this.checkpoint();
    this.emitUpdate();
    return 'wrote';
  }

  async fetchSegment(t, idx) {
    const seg = t.segments[idx];
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (this._stopping) throw new Error('stopped');
      try {
        let data = await this.getBytes(seg.url, seg.range, true, t.headers);
        if (seg.key && seg.key.method === 'AES-128') data = await this.decrypt(seg, data);
        else if (seg.key && seg.key.method !== 'NONE') { const e = new Error('This stream is DRM-protected and cannot be downloaded'); e.code = 'DRM'; throw e; }
        return data;
      } catch (err) {
        lastErr = err;
        if (err.code === 'DRM') throw err;
        if (err instanceof HttpError && err.fatal) throw err;
        await sleep(Math.min(this.retryDelayMs * Math.pow(1.6, attempt), 30000));
      }
    }
    throw lastErr;
  }

  async decrypt(seg, data) {
    let key = this.keys.get(seg.key.url);
    if (!key) {
      key = await this.getBytes(seg.key.url, null);
      if (key.length !== 16) throw new Error('Invalid AES-128 key length');
      this.keys.set(seg.key.url, key);
    }
    const d = crypto.createDecipheriv('aes-128-cbc', key, hls.ivFor(seg));
    return Buffer.concat([d.update(data), d.final()]);
  }

  // ---- network ------------------------------------------------------------------------------------

  async fetchText(url) {
    if (this._fetchText) return this._fetchText(url, { headers: this.headers });
    const r = await net.fetchText(url, { session: this.session, headers: this.headers, timeoutMs: this.timeoutMs });
    return { text: r.body.toString('utf8'), finalUrl: r.finalUrl };
  }

  open(url, opts) {
    if (this._openConn) return this._openConn(url, opts);
    const t = this.transport;
    if (!t) return net.open(url, opts);
    const direct = t.useDirect(url) && (t.mode() === 'direct' || (this.httpMajor === 1 && this.concurrency > BROWSER_H1_CAP));
    return t.open(url, { ...opts, direct });
  }

  async getBytes(url, range, count = false, headers = null) {
    const r = range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined;
    const conn = await this.open(url, { session: this.session, headers: { ...this.headers, ...(headers || {}) }, range: r, timeoutMs: this.timeoutMs });
    const cr = /\/(\d+)\s*$/.exec((conn.headers && conn.headers['content-range']) || '');
    this._lastTotal = cr ? Number(cr[1]) : Number((conn.headers && conn.headers['content-length']) || 0);
    if (!this.httpMajor) {
      const v = conn.res && (conn.res.httpVersionMajor || Number(String(conn.res.httpVersion || conn.httpVersion || '1').split('.')[0]));
      this.httpMajor = v || 1;
    }
    if (conn.status >= 400) { conn.abort(); throw new HttpError(conn.status); }
    // Asked for a part but got the whole (big) file: don't read it all into memory.
    if (range && conn.status === 200 && Number(conn.headers['content-length'] || 0) > range.length * 2) {
      conn.abort();
      throw new Error('The server does not send parts of files, so this stream can’t be downloaded in pieces');
    }
    return readAll(conn, {
      limiter: this.limiter, taskLimiter: this.taskLimiter, timeoutMs: this.timeoutMs, stopping: () => this._stopping,
      onBytes: count ? (n) => { this.receivedBytes += n; this.sample(n); this.emitUpdate(); } : null,
    });
  }

  // ---- output ------------------------------------------------------------------------------------

  writeOut(buf) {
    return new Promise((resolve, reject) => {
      fs.write(this.out, buf, 0, buf.length, null, (err) => {
        if (err) return reject(err);
        this.writtenBytes += buf.length;
        resolve();
      });
    });
  }

  async checkpoint() {
    if (this.mode === 'files') {
      for (const f of this.files) if (f.fd !== null) await new Promise((r) => fs.fdatasync(f.fd, () => r()));
      this.saveMeta();
      this._lastCheckpoint = Date.now();
      this._checkpointWritten = this.writtenBytes;
      return;
    }
    if (this.out === null || !this.merger) return;
    await new Promise((r) => fs.fdatasync(this.out, () => r()));
    this.saveMeta();
    this._lastCheckpoint = Date.now();
    this._checkpointWritten = this.writtenBytes;
  }

  saveMeta() {
    const keys = {};
    for (const [u, k] of this.keys) keys[u] = k.toString('hex');
    try {
      const tmp = this.metaPath + '.tmp';
      if (this.mode === 'files') {
        fs.writeFileSync(tmp, JSON.stringify({ v: 1, kind: 'merge', mode: 'files', next: this.tracks.map((t) => t.nextWrite), files: this.files.map((f) => f.written), webm: this.tracks.map((t) => !!t.webm) }));
        fs.renameSync(tmp, this.metaPath);
        return;
      }
      fs.writeFileSync(tmp, JSON.stringify({
        v: 1, kind: 'merge', next: this.tracks.map((t) => t.nextWrite), written: this.writtenBytes,
        containers: this.tracks.map((t) => t.container), inits: this.tracks.map((t) => t.init.toString('base64')),
        merger: this.merger.state(), shifts: this.merger.timeShift, lastEnd: this.merger.lastEnd, keys,
      }));
      fs.renameSync(tmp, this.metaPath);
    } catch {}
  }

  async finish() {
    if (this.mode === 'files') return this.finishFiles();
    await new Promise((r) => fs.fdatasync(this.out, () => r()));
    this.closeOut();
    fs.renameSync(this.partPath, this.savePath);
    for (const f of [this.metaPath, this.tracksPath]) { try { fs.rmSync(f, { force: true }); } catch {} }
    this.state = 'done';
    this.emit('done');
    this.emitUpdate(true);
  }

  // Files mode: FFmpeg joins picture and sound (WebM goes into .mkv, which takes any codec).
  async finishFiles() {
    this.closeOut();
    const video = this.files[this.tracks.findIndex((t) => t.kind === 'video')];
    const audio = this.files[this.tracks.findIndex((t) => t.kind === 'audio')];
    const webm = this.tracks.some((t) => t.webm || (t.init && isWebm(t.init)));
    if (webm && /\.mp4$/i.test(this.savePath)) {
      this.savePath = this.savePath.replace(/\.mp4$/i, '.mkv');
      this.emit('renamed', this.savePath);
    }
    this.state = 'downloading';
    this.emit('progress', { ...this.progress(), joining: true });
    if (video && audio) await this.ffmpeg.merge(video.path, audio.path, this.savePath);
    else fs.copyFileSync((video || audio).path, this.savePath);
    for (const f of [...this.files.map((x) => x.path), this.metaPath, this.tracksPath]) { try { fs.rmSync(f, { force: true }); } catch {} }
    this.state = 'done';
    this.emit('done');
    this.emitUpdate(true);
  }

  stop() {
    this._stopping = true;
    clearTimeout(this._livePoll);
    if (this._wake) this._wake();
  }

  async pause() {
    if (this.state !== 'downloading') return;
    if (this.live) {
      // A live recording can't continue later: finish it, so the file is complete and playable.
      const done = new Promise((r) => { this.once('done', r); this.once('error', r); });
      this.stopRecording();
      await Promise.race([done, sleep(15000)]);
      return;
    }
    this.stop();
    this.state = 'paused';
    await this._writerIdle();
    if ((this.merger && this.out !== null) || this.mode === 'files') await this.checkpoint().catch(() => {});
    this.closeOut();
    this.emitUpdate(true);
  }

  // The writer finishes the segment it is writing before stopping.
  async _writerIdle() { if (this._writing) await this._writing; }

  async cancel() {
    this.stop();
    await this._writerIdle();
    this.closeOut();
    for (const f of [this.partPath, this.metaPath, this.tracksPath, ...this.files.map((x) => x.path)]) { try { fs.rmSync(f, { force: true }); } catch {} }
    this.state = 'queued';
  }

  fail(err) {
    this.error = err;
    this.state = 'error';
    this.stop();
    if (this.merger && this.out !== null) this.checkpoint().catch(() => {}).finally(() => this.closeOut());
    else this.closeOut();
    this.emit('error', err);
    this.emitUpdate(true);
  }

  closeOut() {
    if (this.out !== null) { try { fs.closeSync(this.out); } catch {} this.out = null; }
    for (const f of this.files) if (f.fd !== null) { try { fs.closeSync(f.fd); } catch {} f.fd = null; }
  }

  // ---- progress ----------------------------------------------------------------------------------

  sample(n) {
    const now = Date.now();
    this._speed.push([now, n]);
    while (this._speed.length && this._speed[0][0] < now - 3000) this._speed.shift();
  }

  speed() {
    if (this._speed.length < 2) return 0;
    const span = (Date.now() - this._speed[0][0]) / 1000;
    return span > 0 ? Math.round(this._speed.reduce((s, x) => s + x[1], 0) / span) : 0;
  }

  emitUpdate(force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < 300) return;
    this._lastEmit = now;
    this.emit('progress', this.progress());
  }

  progress() {
    const total = this.totalSegments;
    const done = this.doneSegments;
    const frac = total ? done / total : 0;
    const p = {
      id: this.id, state: this.state, size: done > 4 && frac > 0 ? Math.round(this.writtenBytes / frac) : -1, sizeIsEstimate: done < total,
      received: this.writtenBytes, percent: frac * 100, resumable: true, segments: total, doneSegments: done,
      speed: this.state === 'downloading' ? this.speed() : 0, connections: this.state === 'downloading' ? this.concurrency : 0,
      error: this.error ? String(this.error.message || this.error) : null, errorCode: this.error && this.error.code ? this.error.code : null,
    };
    // A live recording has no known end: its size is what's written so far.
    if (this.live) {
      Object.assign(p, {
        size: this.writtenBytes, sizeIsEstimate: this.isRecording(), percent: 0, resumable: false, live: true,
        recording: this.isRecording() && this.state === 'downloading', recordedSeconds: Math.round(this.recordedSeconds()), liveGaps: this.liveGaps,
      });
    }
    return p;
  }
}

// MPEG-TS of one track (video or audio) to fragmented MP4, keeping the stream's own timestamps so
// separate tracks stay in sync (the merger moves the common start to 0).
class TrackTransmuxer {
  constructor(kind, init = null) {
    const mux = require('mux.js');
    this.kind = kind;
    this.init = init;
    this.out = [];
    this.tx = new mux.mp4.Transmuxer({ remux: false, keepOriginalTimestamps: true });
    this.tx.on('data', (s) => {
      if (s.type !== kind) return;
      if (!this.init) this.init = Buffer.from(s.initSegment.buffer, s.initSegment.byteOffset, s.initSegment.byteLength);
      this.out.push(Buffer.from(s.data.buffer, s.data.byteOffset, s.data.byteLength));
    });
  }

  /** One segment in, its MP4 fragment(s) out. */
  convert(buf) {
    this.out = [];
    this.tx.push(new Uint8Array(buf));
    this.tx.flush();
    return this.out;
  }
}

function isWebm(buf) { return !!buf && buf.length > 4 && buf.readUInt32BE(0) === 0x1a45dfa3; }

// Not something the MP4 merger can join: WebM, or a plain (non-fragmented) MP4 file.
function needsFfmpeg(t, first) {
  if (isWebm(t.init) || isWebm(first)) return true;
  const head = t.init || first;
  const moov = readBoxes(head).find((b) => b.type === 'moov');
  const fragmented = readBoxes(first).some((b) => b.type === 'moof') || (moov && children(head, moov).some((c) => c.type === 'mvex'));
  return !!moov && !fragmented;
}

function firstDecodeTime(frags, track) {
  const list = Array.isArray(frags) ? frags : [frags];
  for (const buf of list) {
    for (const b of readBoxes(buf)) {
      if (b.type !== 'moof') continue;
      for (const c of children(buf, b)) {
        if (c.type !== 'traf') continue;
        const tfdt = child(buf, c, 'tfdt');
        if (!tfdt) continue;
        const t = buf[tfdt.start + 8] === 1 ? Number(buf.readBigUInt64BE(tfdt.start + 12)) : buf.readUInt32BE(tfdt.start + 12);
        return { seconds: t / ((track && track.timescale) || 90000) };
      }
    }
  }
  return { seconds: 0 };
}

/** Read a whole response; chunks in order (speed limits may make them wait), end handled after them. */
function readAll(conn, { limiter, taskLimiter, timeoutMs = 30000, stopping = () => false, onBytes = null } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let finished = false;
    const finish = (err, v) => { if (finished) return; finished = true; clearTimeout(idle); if (err) reject(err); else resolve(v); };
    const stall = () => { conn.abort(); finish(new Error('Connection stalled')); };
    let idle = setTimeout(stall, timeoutMs);
    let chain = Promise.resolve();
    const limited = !!(limiter || taskLimiter);
    const keep = (chunk) => {
      clearTimeout(idle); idle = setTimeout(stall, timeoutMs);
      chunks.push(chunk);
      if (onBytes) onBytes(chunk.length);
    };
    conn.res.on('data', (chunk) => {
      if (finished) return;
      if (stopping()) { conn.abort(); return finish(new Error('stopped')); }
      if (!limited) return keep(chunk);
      conn.res.pause();
      chain = chain.then(async () => {
        let off = 0;
        while (off < chunk.length) {
          let n = Math.min(chunk.length - off, 64 * 1024);
          if (limiter) n = await limiter.take(n);
          if (taskLimiter) n = await taskLimiter.take(n);
          off += n;
        }
      }).then(() => { if (finished) return; keep(chunk); conn.res.resume(); }, (e) => finish(e));
    });
    const after = (fn) => { chain = chain.then(fn, fn); };
    conn.res.on('end', () => after(() => finish(null, Buffer.concat(chunks))));
    conn.res.on('error', (e) => after(() => finish(e)));
    conn.res.on('aborted', () => after(() => finish(new Error('Connection aborted'))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { MergeDownload, TrackTransmuxer, readAll };
