'use strict';
// How a new download gets added, whatever started it (a page, "Download link with NovaDM", the
// Downloads page, the clipboard):
//  - Refresh link: if the user is getting a fresh link for a failed download in this tab, the new
//    link continues that download instead of starting another one.
//  - Duplicates: the same link already in the list is pointed out (or resumed when unfinished).
//  - The "New download" dialog (name, folder, speed limit, checksum) unless the user turned it off.
//  - Several links at once (pasted lists, [001-100] patterns, clipboard) get a pick list.
const { dialog } = require('electron');
const util = require('./util');
const net = require('./net');
const { torrentInfo, parseMagnet } = require('./torrent/bencode');

class AddFlow {
  /**
   * ctx: { downloads, settings, browser, sendUI, setPanel, getWindow, notify }
   */
  constructor(ctx) {
    Object.assign(this, ctx);
    this.queue = []; // requests waiting for the dialog
    this.current = null; // { id, kind: 'one'|'many', spec | specs }
    this.armed = new Map(); // tabId -> download id waiting for a fresh link
    this._seq = 0;
  }

  // ---- entry points ------------------------------------------------------------------------------

  /** One download. opts.origin: 'page' | 'menu' | 'manual' | 'clipboard'. Returns { ok, id?, pending? }. */
  request(spec, opts = {}) {
    if (spec.tabId != null && this.armed.has(spec.tabId)) {
      const id = this.armed.get(spec.tabId);
      const rec = this.downloads.get(id);
      if (rec && rec.state !== 'done' && rec.kind === spec.kind) return this.applyRefresh(id, spec);
    }
    const dup = this.downloads.findDuplicate(spec);
    // Clipboard links always ask (nobody clicked anything); the media panel is its own chooser.
    const ask = opts.origin === 'clipboard' || (opts.origin !== 'media' && !this.settings.get('skipEditor'));
    if (!ask) {
      if (dup && dup.state !== 'done') { this.downloads.resume(dup.id); return { ok: true, id: dup.id, resumed: true }; }
      const rec = this.downloads.add(spec);
      return { ok: true, id: rec.id };
    }
    this.enqueue({ kind: 'one', spec, origin: opts.origin || 'manual', dup });
    return { ok: true, pending: true };
  }

  /** Several links (pasted list, pattern, clipboard). One link goes to the normal dialog. */
  requestLinks(urls, opts = {}) {
    const list = [...new Set(urls.filter((u) => /^(https?:\/\/|magnet:\?)/i.test(u)))].slice(0, 5000);
    if (!list.length) return { ok: false, error: 'No links found' };
    const specs = list.map((url) => specFromUrl(url, opts));
    if (specs.length === 1) return this.request(specs[0], opts);
    this.enqueue({ kind: 'many', specs, origin: opts.origin || 'manual' });
    return { ok: true, pending: true, count: specs.length };
  }

  // ---- dialog queue ------------------------------------------------------------------------------

  enqueue(req) {
    req.id = ++this._seq;
    this.queue.push(req);
    if (!this.current) this.showNext();
  }

  showNext() {
    this.current = this.queue.shift() || null;
    if (!this.current) return;
    const req = this.current;
    const win = this.getWindow();
    if (win && win.isMinimized()) win.restore();
    this.setPanel(true);
    if (req.kind === 'many') {
      this.sendUI('links-ask', {
        reqId: req.id, origin: req.origin, folder: this.downloads.settings.get('downloadDir'), queues: this.queueChoices(),
        links: req.specs.map((s) => ({ url: s.url, name: s.name || util.filenameFromUrl(s.url) || s.url })),
      });
      return;
    }
    if (req.kind === 'files') {
      this.sendUI('torrent-files', { reqId: req.id, name: req.name, files: req.files });
      return;
    }
    const s = req.spec;
    const name = util.sanitizeFilename(s.name || util.filenameFromUrl(s.url || s.playlistUrl) || 'download');
    const category = s.category || util.categoryOf(name, s.mime);
    this.sendUI('download-ask', {
      reqId: req.id, origin: req.origin, kind: s.kind, name, url: s.kind === 'hls' || s.kind === 'dash' ? s.playlistUrl : s.url,
      size: s.size > 0 ? s.size : -1, sizeIsEstimate: s.kind === 'hls', folder: s.dir || this.downloads.categoryDir(category),
      pageUrl: s.pageUrl || '', incognito: !!s.incognito,
      duplicate: req.dup ? { id: req.dup.id, name: req.dup.name, state: req.dup.state } : null,
      queues: this.queueChoices(),
      torrent: s.kind === 'torrent' ? { files: s.files || null, magnet: !!s.magnet } : null,
    });
    // Unknown size/name (plain links): ask the server while the dialog is open.
    if (s.kind === 'http' && !(s.size > 0) && !s.native) this.probeFor(req);
  }

  // Queues to choose from in the dialogs (only shown when there is more than Main).
  queueChoices() {
    return this.downloads.queues().map((q) => ({ id: q.id, name: q.name, scheduled: !!(q.schedule && q.schedule.enabled) }));
  }

  async probeFor(req) {
    const s = req.spec;
    try {
      const p = await net.probe(s.url, { session: s.incognito ? this.downloads.privateSession : this.downloads.session, headers: s.headers || {}, timeoutMs: 8000 });
      if (this.current !== req) return;
      let name = util.filenameFromDisposition(p.disposition) || '';
      if (!name && !util.extOf(util.filenameFromUrl(s.url) || '')) name = util.ensureExt(util.filenameFromUrl(s.url) || 'download', p.mime);
      if (p.size > 0) s.size = p.size;
      if (p.mime) s.mime = p.mime;
      this.sendUI('download-ask-update', { reqId: req.id, size: p.size, name: name ? util.sanitizeFilename(name) : '', folder: s.dir ? '' : this.downloads.categoryDir(util.categoryOf(name || s.name || util.filenameFromUrl(s.url), p.mime)) });
    } catch (e) {
      if (this.current === req) this.sendUI('download-ask-update', { reqId: req.id, warning: 'The server did not answer: ' + (e.message || e) });
    }
  }

  /**
   * Answer from the dialog. a: { reqId, action: 'start'|'paused'|'cancel'|'resumeExisting',
   *   name, folder, speedLimitKBps, checksum, dontAsk, selected: [index] }
   */
  respond(a) {
    const req = this.current;
    if (!req || req.id !== a.reqId) return { ok: false };
    this.current = null;
    let result = { ok: true };
    if (a.dontAsk) this.settings.set({ skipEditor: true });
    if (req.kind === 'files') {
      req.resolve(a.action === 'start' ? (a.selected || []).map((i) => i + 1).join(',') || null : null);
    } else if (a.action === 'resumeExisting' && req.dup) {
      this.downloads.resume(req.dup.id);
    } else if (a.action === 'start' || a.action === 'paused') {
      const start = a.action === 'start';
      if (req.kind === 'many') {
        const pick = new Set(a.selected || []);
        let n = 0;
        req.specs.forEach((s, i) => { if (pick.has(i)) { this.downloads.add({ ...s, dir: a.folder || undefined, queue: a.queue, start }); n++; } });
        result.count = n;
      } else {
        const s = req.spec;
        const rec = this.downloads.add({
          ...s, name: a.name ? util.sanitizeFilename(a.name) : s.name, allowRename: a.name ? false : s.allowRename,
          dir: a.folder || s.dir, speedLimitKBps: a.speedLimitKBps, expectedHash: a.checksum, queue: a.queue, start,
          selectFiles: s.kind === 'torrent' && Array.isArray(a.selected) && s.files && a.selected.length < s.files.length ? a.selected.map((i) => i + 1).join(',') : s.selectFiles,
        });
        result.id = rec.id;
      }
    }
    this.setPanel(false);
    this.sendUI('close-panel', {});
    setTimeout(() => this.showNext(), 150);
    return result;
  }

  /** The dialog was closed without an answer (Esc, click outside, another panel). */
  dismiss() {
    if (!this.current) return;
    if (this.current.kind === 'files') this.current.resolve(null);
    this.current = null;
    setTimeout(() => this.showNext(), 150);
  }

  async chooseFolder(current) {
    const r = await dialog.showOpenDialog(this.getWindow(), {
      properties: ['openDirectory', 'createDirectory'], defaultPath: current || this.settings.get('downloadDir'),
    });
    return r.canceled ? '' : r.filePaths[0] || '';
  }

  /** Torrent from a magnet link: the files are known now; ask which to download. */
  askTorrentFiles(rec, files) {
    if (this.settings.get('torrentAskFiles') === false || files.length < 2) return Promise.resolve(files.map((f) => f.index).join(','));
    return new Promise((resolve) => this.enqueue({ kind: 'files', name: rec.name, files: files.map((f) => ({ path: f.path, length: f.length })), resolve }));
  }

  /** A .torrent file's bytes (from a page, a link or the disk): read it and ask. */
  requestTorrentFile(buf, opts = {}) {
    let info;
    try { info = torrentInfo(buf); } catch (e) { return { ok: false, error: e.message }; }
    return this.request({
      kind: 'torrent', torrentData: buf.toString('base64'), name: info.name, size: info.length, infoHash: info.infoHash,
      files: info.files, pageUrl: opts.pageUrl || '', tabId: opts.tabId, incognito: !!opts.incognito, category: torrentCategory(info.files),
    }, { origin: opts.origin || 'manual' });
  }

  // ---- Refresh link ------------------------------------------------------------------------------

  /** Open the download's page; the next matching download or stream in that tab refreshes it. */
  refreshFromPage(id) {
    const rec = this.downloads.get(id);
    if (!rec || !/^https?:/i.test(rec.pageUrl || '')) return { ok: false, error: 'This download has no page to get a new link from. Paste a new link instead.' };
    const tabId = this.browser.createTab({ url: rec.pageUrl, incognito: !!rec.incognito });
    for (const [t, d] of this.armed) if (d === id) this.armed.delete(t);
    this.armed.set(tabId, id);
    return { ok: true, tabId };
  }

  armedFor(tabId) { return this.armed.get(tabId); }

  async applyRefresh(id, spec) {
    for (const [t, d] of this.armed) if (d === id) this.armed.delete(t);
    const rec = this.downloads.get(id);
    try {
      await this.downloads.refreshLink(id, spec.kind === 'hls' || spec.kind === 'dash' ? spec.playlistUrl : spec.url, { size: spec.size, headers: spec.headers });
      this.notify({ title: 'Link refreshed', body: `Continuing ${rec.name}` });
      return { ok: true, id, refreshed: true };
    } catch (e) {
      this.notify({ title: 'Could not refresh the link', body: `${rec.name}: ${e.message || e}` });
      return { ok: false, error: e.message };
    }
  }
}

/** The kind of a torrent: what most of its bytes are. */
function torrentCategory(files) {
  const big = (files || []).slice().sort((a, b) => b.length - a.length)[0];
  return big ? util.categoryOf(big.path) : 'other';
}

/** A download spec for a plain link (a stream when it is an .m3u8 playlist or .mpd manifest). */
function specFromUrl(url, opts = {}) {
  const magnet = parseMagnet(url);
  if (magnet) {
    return { kind: 'torrent', magnet: url, name: util.sanitizeFilename(magnet.name || '', 'Torrent ' + magnet.infoHash.slice(0, 8)), infoHash: magnet.infoHash, pageUrl: opts.pageUrl || '', incognito: !!opts.incognito };
  }
  const hls = /\.m3u8(\?|#|$)/i.test(url);
  const isDash = /\.mpd(\?|#|$)/i.test(url);
  const stream = hls || isDash;
  return {
    kind: hls ? 'hls' : isDash ? 'dash' : 'http', url: stream ? undefined : url, sources: stream ? undefined : [url],
    playlistUrl: stream ? url : '', name: '', pageUrl: opts.pageUrl || '',
    headers: opts.pageUrl ? { referer: opts.pageUrl } : {}, incognito: !!opts.incognito,
    category: stream ? 'video' : undefined,
  };
}

module.exports = { AddFlow, specFromUrl, torrentCategory };
