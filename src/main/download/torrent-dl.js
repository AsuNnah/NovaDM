'use strict';
// One torrent or magnet link in the download list, carried out by aria2 (torrent/aria2.js).
// Magnet links first fetch the torrent info from peers (aria2 pauses the download after that), then
// the user picks the files, then it downloads. When complete it keeps seeding until the ratio or
// time limit; 'done' is emitted when the files are complete, 'seeding' updates follow.
const path = require('path');
const { EventEmitter } = require('events');

const POLL_MS = 1000;
const KEYS = ['gid', 'status', 'totalLength', 'completedLength', 'uploadLength', 'downloadSpeed', 'uploadSpeed', 'connections', 'numSeeders', 'seeder', 'infoHash', 'followedBy', 'errorCode', 'errorMessage', 'bittorrent', 'dir', 'files'];

class TorrentDownload extends EventEmitter {
  /**
   * opts: id, aria2, magnet | torrent (base64), dir, gid (from before), selectFiles ('1,3' or ''),
   *   askFiles(files) => Promise<'1,3' | null (cancel)>  (when the user should choose), pollMs (tests)
   */
  constructor(opts) {
    super();
    Object.assign(this, { id: opts.id, aria2: opts.aria2, magnet: opts.magnet || '', torrent: opts.torrent || '', dir: opts.dir, gid: opts.gid || '', selectFiles: opts.selectFiles || '', askFiles: opts.askFiles || null });
    this.state = 'queued';
    this.phase = ''; // metadata | choosing | downloading | seeding
    this.st = null;
    this.error = null;
    this.timer = null;
    this.doneEmitted = false;
    this.name = '';
    this.pollMs = opts.pollMs || POLL_MS;
  }

  async start() {
    this.state = 'connecting';
    this.error = null;
    this.emitUpdate();
    try {
      await this.aria2.start();
      let st = null;
      if (this.gid) { try { st = await this.aria2.call('tellStatus', this.gid, ['status']); } catch {} }
      if (st && ['paused', 'waiting'].includes(st.status)) await this.aria2.call('unpause', this.gid);
      else if (!st || ['removed', 'error', 'complete'].includes(st.status)) await this.add();
      this.state = 'downloading';
      this.poll();
    } catch (err) {
      this.fail(err);
    }
  }

  async add() {
    const opts = { dir: this.dir };
    if (this.selectFiles) opts['select-file'] = this.selectFiles;
    if (this.magnet) {
      this.gid = await this.aria2.call('addUri', [this.magnet], opts);
      this.phase = 'metadata';
    } else {
      // Paused until the user has chosen the files (unless already chosen).
      if (this.askFiles && !this.selectFiles) opts.pause = 'true';
      this.gid = await this.aria2.call('addTorrent', this.torrent, [], opts);
      this.phase = opts.pause ? 'choosing' : 'downloading';
    }
    this.emit('gid', this.gid);
  }

  poll() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick().catch((err) => this.fail(err)), this.pollMs);
  }

  async tick() {
    if (this.state === 'paused' || this.state === 'cancelled' || this.state === 'error') return;
    const st = await this.aria2.call('tellStatus', this.gid, KEYS);
    this.st = st;
    const name = st.bittorrent && st.bittorrent.info && st.bittorrent.info.name;
    if (name && name !== this.name) {
      this.name = name;
      this.emit('renamed', path.join(this.dir, name));
    }
    if (st.status === 'error') throw Object.assign(new Error(st.errorMessage || `aria2 error ${st.errorCode}`), { code: 'TORRENT_' + st.errorCode });
    if (st.status === 'removed') { this.state = 'cancelled'; return; }

    // Magnet: torrent info has arrived and the real download waits (paused) for the file choice.
    if (this.phase === 'metadata' && st.followedBy && st.followedBy.length) {
      try { await this.aria2.call('removeDownloadResult', this.gid); } catch {}
      this.gid = st.followedBy[0];
      this.emit('gid', this.gid);
      this.phase = this.selectFiles ? 'downloading' : 'choosing';
      if (this.selectFiles) await this.aria2.call('unpause', this.gid).catch(() => {});
      return this.poll();
    }
    if (this.phase === 'choosing') {
      const files = await this.files();
      this.emit('files', files);
      const choice = this.askFiles ? await this.askFiles(files) : files.map((f) => f.index).join(',');
      if (choice === null) { await this.cancel(); this.emit('error', Object.assign(new Error('Cancelled'), { code: 'CANCELLED' })); return; }
      this.selectFiles = choice;
      await this.aria2.call('changeOption', this.gid, { 'select-file': choice });
      await this.aria2.call('unpause', this.gid);
      this.phase = 'downloading';
      this.emit('selected', choice);
      return this.poll();
    }

    const complete = st.status === 'complete' || (Number(st.totalLength) > 0 && st.completedLength === st.totalLength && st.seeder === 'true');
    if (complete && !this.doneEmitted && this.phase !== 'metadata') {
      this.doneEmitted = true;
      this.state = 'done';
      this.phase = st.status === 'complete' ? '' : 'seeding';
      this.emit('progress', this.progress());
      this.emit('done');
    } else if (this.doneEmitted) {
      this.phase = st.status === 'complete' ? '' : 'seeding';
      this.emit('seeding', this.seedInfo());
      if (st.status === 'complete') return; // seeding finished (ratio / time limit)
    } else {
      this.emitUpdate();
    }
    this.poll();
  }

  async files() {
    const list = await this.aria2.call('getFiles', this.gid);
    const base = this.st && this.st.dir ? this.st.dir : this.dir;
    // Paths inside the torrent (without its top folder, which is the torrent's name).
    const root = this.name ? path.join(base, this.name) : base;
    const rel = (p) => { const r = path.relative(root, p); return r && !r.startsWith('..') ? r : path.relative(base, p) || p; };
    return list.map((f) => ({ index: Number(f.index), path: rel(f.path), length: Number(f.length), done: Number(f.completedLength), selected: f.selected === 'true' }));
  }

  async pause() {
    if (this.state !== 'downloading' && this.state !== 'connecting') return;
    this.state = 'paused';
    clearTimeout(this.timer);
    if (this.gid) await this.aria2.call('forcePause', this.gid).catch(() => {});
    this.emitUpdate();
  }

  async stopSeeding() {
    clearTimeout(this.timer);
    if (this.gid) await this.aria2.call('forceRemove', this.gid).catch(() => {});
    this.phase = '';
    this.emit('seeding', { ...this.seedInfo(), seeding: false });
  }

  async cancel() {
    this.state = 'cancelled';
    clearTimeout(this.timer);
    if (this.gid) {
      await this.aria2.call('forceRemove', this.gid).catch(() => {});
      await sleep(300);
      await this.aria2.call('removeDownloadResult', this.gid).catch(() => {});
    }
  }

  fail(err) {
    clearTimeout(this.timer);
    this.state = 'error';
    this.error = err;
    this.emit('error', err);
  }

  seedInfo() {
    const st = this.st || {};
    const total = Number(st.totalLength) || 0;
    return { seeding: this.phase === 'seeding', uploadSpeed: Number(st.uploadSpeed) || 0, uploaded: Number(st.uploadLength) || 0, ratio: total ? (Number(st.uploadLength) || 0) / total : 0, peers: Number(st.connections) || 0 };
  }

  progress() {
    const st = this.st || {};
    const size = Number(st.totalLength) || -1;
    const received = Number(st.completedLength) || 0;
    return {
      id: this.id, state: this.state, size: size > 0 ? size : -1, received, percent: size > 0 ? (received / size) * 100 : 0,
      speed: this.state === 'downloading' ? Number(st.downloadSpeed) || 0 : 0, connections: Number(st.connections) || 0,
      seeders: Number(st.numSeeders) || 0, phase: this.phase, resumable: true, infoHash: st.infoHash || '',
      error: this.error ? String(this.error.message || this.error) : null, errorCode: this.error && this.error.code ? this.error.code : null,
      ...this.seedInfo(),
    };
  }

  emitUpdate() { this.emit('progress', this.progress()); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { TorrentDownload };
