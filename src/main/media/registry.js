'use strict';
// Per-tab registry of detected media. Pure logic: network access is injected (fetchText), so it
// can be unit-tested without Electron.
const { EventEmitter } = require('events');
const hls = require('./hls');
const dash = require('./dash');
const { classify, dedupeKey, mirrorKey } = require('./classify');
const { sanitizeFilename, siteOf, hostOf, uid } = require('../util');

const MAX_ITEMS = 200;
const PLAYING_WINDOW_MS = 20000;
const KIND_ORDER = { hls: 0, video: 0, audio: 1, dash: 2, file: 3, subtitle: 4 };

function dirPrefix(u) {
  try {
    const url = new URL(u);
    return url.origin + url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
  } catch {
    return '';
  }
}

function guessLabelFromUrl(u) {
  const m = /(?:^|[^\d])(2160|1440|1080|720|576|540|480|360|240|144)p?(?:[^\d]|$)/i.exec(u || '');
  return m ? `${m[1]}p` : '';
}

class MediaRegistry extends EventEmitter {
  /**
   * @param {object} deps
   *   fetchText(url, { headers, tabId }) => Promise<{ text, finalUrl }>
   *   getSetting(key) => value
   */
  constructor({ fetchText, getSetting }) {
    super();
    this.fetchText = fetchText;
    this.getSetting = getSetting || (() => undefined);
    this.tabs = new Map();
    this.reqHeaders = new Map(); // requestId -> replayable request headers
    this.notifyTimers = new Map();
  }

  // ---- tab lifecycle -------------------------------------------------------------------------

  tab(tabId) {
    let t = this.tabs.get(tabId);
    if (!t) {
      t = {
        pageUrl: '', pageTitle: '', thumbnail: '', eme: '',
        items: new Map(), byKey: new Map(), children: new Map(), segDirs: new Map(), pending: new Set(),
      };
      this.tabs.set(tabId, t);
    }
    return t;
  }

  resetTab(tabId, pageUrl = '') {
    const t = this.tab(tabId);
    t.items.clear(); t.byKey.clear(); t.children.clear(); t.segDirs.clear(); t.pending.clear();
    t.pageUrl = pageUrl; t.pageTitle = ''; t.thumbnail = ''; t.eme = '';
    this.notify(tabId);
  }

  removeTab(tabId) {
    this.tabs.delete(tabId);
    clearTimeout(this.notifyTimers.get(tabId));
    this.notifyTimers.delete(tabId);
  }

  setPageInfo(tabId, info) {
    const t = this.tab(tabId);
    if (info.url !== undefined) t.pageUrl = info.url;
    if (info.title !== undefined) t.pageTitle = info.title;
    if (info.thumbnail !== undefined) t.thumbnail = info.thumbnail;
    if (t.items.size) this.notify(tabId);
  }

  markEme(tabId, keySystem) {
    const t = this.tab(tabId);
    if (t.eme === keySystem) return;
    t.eme = keySystem;
    this.notify(tabId);
  }

  clear(tabId) {
    const t = this.tab(tabId);
    t.items.clear(); t.byKey.clear(); t.children.clear(); t.segDirs.clear();
    this.notify(tabId);
  }

  remove(tabId, itemId) {
    const t = this.tab(tabId);
    const item = t.items.get(itemId);
    if (!item) return;
    t.items.delete(itemId);
    for (const [k, v] of t.byKey) if (v === itemId) t.byKey.delete(k);
    this.notify(tabId);
  }

  // ---- network events ------------------------------------------------------------------------

  recordRequestHeaders(requestId, headers) {
    this.reqHeaders.set(requestId, headers);
    if (this.reqHeaders.size > 3000) {
      const first = this.reqHeaders.keys().next().value;
      this.reqHeaders.delete(first);
    }
  }

  /** details: { id, url, method, statusCode, resourceType, headers(lower-case) } */
  onResponse(tabId, details) {
    const headers = this.reqHeaders.get(details.id) || {};
    this.reqHeaders.delete(details.id);
    const c = classify(details, { minMediaKB: this.getSetting('minMediaKB') });
    if (!c) return null;
    const t = this.tab(tabId);
    const now = Date.now();

    if (c.kind === 'segment') {
      const id = t.segDirs.get(dirPrefix(details.url));
      const item = id && t.items.get(id);
      if (item) this.touch(tabId, item, now);
      return null;
    }

    const dk = dedupeKey(details.url);
    const mk = mirrorKey(details.url);

    if (c.kind === 'hls') {
      const child = t.children.get(dk);
      if (child) {
        const item = t.items.get(child.itemId);
        if (item) {
          if (child.variantUrl) item.activeVariant = child.variantUrl;
          this.touch(tabId, item, now);
          if (child.variantUrl) this.registerVariantSegments(tabId, item, child.variantUrl, headers).catch(() => {});
        }
        return item || null;
      }
      const existing = this.findExisting(t, dk, mk, details.url);
      if (existing) {
        this.touch(tabId, existing, now);
        return existing;
      }
      if (t.pending.has(dk)) return null;
      t.pending.add(dk);
      this.analyzeHls(tabId, details.url, headers, now).finally(() => t.pending.delete(dk));
      return null;
    }

    if (c.kind === 'dash') {
      const existing = t.byKey.get(dk) && t.items.get(t.byKey.get(dk));
      if (existing) { this.touch(tabId, existing, now); return existing; }
      if (t.pending.has(dk)) return null;
      t.pending.add(dk);
      this.analyzeDash(tabId, details.url, headers, now).finally(() => t.pending.delete(dk));
      return null;
    }

    const existing = this.findExisting(t, dk, mk, details.url);
    if (existing) {
      if (existing.size < 0 && c.size > 0) existing.size = c.size;
      if (details.resourceType === 'media' || details.resourceType === 'mainFrame') this.touch(tabId, existing, now);
      else this.notify(tabId);
      return existing;
    }
    if (t.items.size >= MAX_ITEMS) return null;
    const item = this.newItem(t, {
      kind: c.kind, url: details.url, mime: c.mime, ext: c.ext, urlName: c.name, size: c.size, headers,
    }, now);
    if (details.resourceType === 'media') item.lastActivity = now;
    t.byKey.set(dk, item.id);
    t.byKey.set('m:' + mk, item.id);
    this.notify(tabId);
    return item;
  }

  findExisting(t, dk, mk, url) {
    let id = t.byKey.get(dk);
    if (id && t.items.has(id)) return t.items.get(id);
    id = t.byKey.get('m:' + mk);
    const item = id && t.items.get(id);
    if (!item) return null;
    // Same path on another host of the same site: a CDN mirror.
    if (hostOf(item.url) !== hostOf(url) && siteOf(item.url) === siteOf(url)) {
      if (!item.mirrors.includes(url)) item.mirrors.push(url);
      return item;
    }
    return null;
  }

  newItem(t, fields, now) {
    const item = {
      id: uid(), kind: fields.kind, url: fields.url, mirrors: [], mime: fields.mime || '', ext: fields.ext || '',
      urlName: fields.urlName || '', size: fields.size ?? -1, sizeEstimate: -1, duration: 0, parts: 0,
      variants: [], activeVariant: '', encryption: 'none', live: false, audioSeparate: false,
      headers: fields.headers || {}, pageUrl: t.pageUrl, detectedAt: now, lastActivity: 0, container: '',
    };
    t.items.set(item.id, item);
    return item;
  }

  touch(tabId, item, now = Date.now()) {
    const wasPlaying = now - item.lastActivity < PLAYING_WINDOW_MS;
    item.lastActivity = now;
    if (!wasPlaying) this.notify(tabId);
  }

  // ---- HLS analysis --------------------------------------------------------------------------

  async analyzeHls(tabId, url, headers, now) {
    const t = this.tab(tabId);
    let res;
    try {
      res = await this.fetchText(url, { headers, tabId });
    } catch {
      return;
    }
    if (!this.tabs.has(tabId)) return;
    let p;
    try { p = hls.parse(res.text, res.finalUrl || url); } catch { return; }
    const dk = dedupeKey(url);

    if (p.type === 'master') {
      if (!p.variants.length) return;
      const item = this.newItem(t, { kind: 'hls', url, headers, urlName: '' }, now);
      item.variants = p.variants.map((v) => ({
        label: hls.variantLabel(v), url: v.url, bandwidth: v.avgBandwidth || v.bandwidth,
        resolution: v.resolution, codecs: v.codecs, audioSeparate: v.audioSeparate,
      }));
      if (p.drm) item.encryption = 'drm';
      t.byKey.set(dk, item.id);
      t.byKey.set('m:' + mirrorKey(url), item.id);
      for (const v of p.variants) {
        const vk = dedupeKey(v.url);
        // A media playlist detected before its master becomes part of this item.
        const prev = t.byKey.get(vk);
        if (prev && prev !== item.id && t.items.get(prev)?.kind === 'hls') {
          const old = t.items.get(prev);
          if (old.lastActivity > item.lastActivity) { item.lastActivity = old.lastActivity; item.activeVariant = v.url; }
          t.items.delete(prev);
        }
        t.children.set(vk, { itemId: item.id, variantUrl: v.url });
      }
      for (const r of p.renditions) if (r.url) t.children.set(dedupeKey(r.url), { itemId: item.id, variantUrl: '' });
      this.notify(tabId);
      // Details (duration, parts, encryption) come from the best variant's media playlist.
      await this.registerVariantSegments(tabId, item, item.variants[0].url, headers).catch(() => {});
      return;
    }

    // Standalone media playlist (no master seen).
    const item = this.newItem(t, { kind: 'hls', url, headers }, now);
    item.variants = [{ label: guessLabelFromUrl(url) || 'Default', url, bandwidth: 0, resolution: null, codecs: '', audioSeparate: false }];
    t.byKey.set(dk, item.id);
    t.byKey.set('m:' + mirrorKey(url), item.id);
    t.children.set(dk, { itemId: item.id, variantUrl: url });
    this.applyMediaInfo(t, item, item.variants[0], p);
    this.notify(tabId);
  }

  async registerVariantSegments(tabId, item, variantUrl, headers) {
    const t = this.tab(tabId);
    const variant = item.variants.find((v) => v.url === variantUrl);
    if (!variant || variant.analyzed) return;
    variant.analyzed = true;
    const res = await this.fetchText(variantUrl, { headers: { ...item.headers, ...headers }, tabId });
    const p = hls.parse(res.text, res.finalUrl || variantUrl);
    if (p.type !== 'media') return;
    this.applyMediaInfo(t, item, variant, p);
    this.notify(tabId);
  }

  applyMediaInfo(t, item, variant, p) {
    variant.duration = p.duration;
    variant.parts = p.segments.length;
    if (variant.bandwidth && p.duration) variant.sizeEstimate = Math.round((variant.bandwidth * p.duration) / 8);
    if (!item.duration) item.duration = p.duration;
    if (!item.parts) item.parts = p.segments.length;
    item.live = item.live || p.live;
    if (p.encryption === 'drm' || item.encryption === 'drm') item.encryption = 'drm';
    else if (p.encryption !== 'none') item.encryption = p.encryption;
    item.container = p.hasMap ? 'fmp4' : '';
    const first = p.segments[0];
    const last = p.segments[p.segments.length - 1];
    for (const s of [first, last]) if (s) t.segDirs.set(dirPrefix(s.url), item.id);
    if (variant === item.variants[0] && variant.sizeEstimate > 0) item.sizeEstimate = variant.sizeEstimate;
  }

  // ---- items from site extensions -----------------------------------------------------------

  /** item: { url, kind: hls|dash|video|audio|file, name, label, size, duration, headers }; source: extension name */
  addExternal(tabId, it, source) {
    const t = this.tab(tabId);
    const dk = dedupeKey(it.url);
    if (t.byKey.has(dk)) return null;
    const kind = it.kind === 'file' ? 'file' : it.kind;
    const item = this.newItem(t, { kind, url: it.url, headers: it.headers || {}, size: it.size, urlName: it.name || '' }, Date.now());
    item.fixedName = it.name || '';
    item.source = source;
    item.duration = it.duration || 0;
    if (kind === 'hls') item.variants = [{ label: it.label || 'Default', url: it.url, bandwidth: 0, resolution: null, codecs: '', audioSeparate: false }];
    if (kind === 'dash') item.variants = [{ label: it.label || 'Best', url: it.url + '#rep=', repId: '', resolution: null, audioSeparate: true }];
    t.byKey.set(dk, item.id);
    this.notify(tabId);
    return item;
  }

  // ---- DASH analysis -------------------------------------------------------------------------

  async analyzeDash(tabId, url, headers, now) {
    const t = this.tab(tabId);
    let res;
    try { res = await this.fetchText(url, { headers, tabId }); } catch { return; }
    if (!this.tabs.has(tabId)) return;
    let mpd;
    try { mpd = dash.parse(res.text, res.finalUrl || url); } catch { return; }
    const period = mpd.periods.find((p) => p.sets.length) || mpd.periods[0];
    if (!period) return;
    const reps = period.sets.flatMap((s) => s.representations);
    const videos = reps.filter((r) => r.kind === 'video').sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    const audios = reps.filter((r) => r.kind === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);
    const main = videos.length ? videos : audios;
    if (!main.length) return;
    const item = this.newItem(t, { kind: 'dash', url, headers, urlName: '' }, now);
    const audioBw = audios[0] ? audios[0].bandwidth : 0;
    item.variants = main.map((r) => ({
      label: r.height ? `${r.height}p` : `${Math.round(r.bandwidth / 1000)} kbps`,
      url: `${url}#rep=${encodeURIComponent(r.id)}`, repId: r.id, bandwidth: r.bandwidth,
      resolution: r.height ? { width: r.width, height: r.height } : null, codecs: r.codecs,
      audioSeparate: videos.length > 0 && audios.length > 0, duration: mpd.duration,
      sizeEstimate: mpd.duration ? Math.round(((r.bandwidth + (videos.length ? audioBw : 0)) * mpd.duration) / 8) : -1,
    }));
    item.duration = mpd.duration;
    item.live = mpd.live;
    item.container = 'fmp4';
    item.audioSeparate = videos.length > 0 && audios.length > 0;
    if (reps.some((r) => r.drm)) item.encryption = 'drm';
    if (item.variants[0].sizeEstimate > 0) item.sizeEstimate = item.variants[0].sizeEstimate;
    t.byKey.set(dedupeKey(url), item.id);
    // Segment folders, so the item shows as playing while its segments load.
    for (const r of [videos[0], audios[0]].filter(Boolean)) {
      try {
        const s = dash.segmentsFor(r);
        for (const seg of [s.segments[0], s.segments[s.segments.length - 1]]) if (seg) t.segDirs.set(dirPrefix(seg.url), item.id);
      } catch {}
    }
    this.notify(tabId);
  }

  // ---- output --------------------------------------------------------------------------------

  displayName(t, item, variant) {
    if (item.fixedName) return sanitizeFilename(item.fixedName, 'download');
    const usePage = this.getSetting('pageTitleNames') !== false && t.pageTitle;
    let ext = item.kind === 'hls' || item.kind === 'dash' ? 'mp4' : (item.ext || (item.kind === 'audio' ? 'mp3' : item.kind === 'subtitle' ? 'vtt' : 'mp4'));
    if (item.kind === 'hls' && item.container !== 'fmp4' && this.getSetting('convertTsToMp4') === false) ext = 'ts';
    let base;
    if (usePage && item.kind !== 'subtitle') base = t.pageTitle;
    else base = (item.urlName || '').replace(/\.[a-z0-9]{1,5}$/i, '') || t.pageTitle || 'video';
    const label = variant && variant.label && variant.label !== 'Default' ? ` [${variant.label}]` : '';
    return sanitizeFilename(`${base}${label}.${ext}`, 'video.' + ext);
  }

  list(tabId) {
    const t = this.tabs.get(tabId);
    if (!t) return { items: [], eme: '', pageUrl: '', pageTitle: '' };
    const now = Date.now();
    const items = [...t.items.values()].map((item) => {
      const best = item.variants[0];
      return {
        ...item,
        headers: undefined,
        name: this.displayName(t, item, best),
        playing: now - item.lastActivity < PLAYING_WINDOW_MS,
        variants: item.variants.map((v) => ({ ...v, name: this.displayName(t, item, v) })),
        thumbnail: t.thumbnail,
      };
    });
    items.sort((a, b) => (Number(b.playing) - Number(a.playing))
      || ((KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9))
      || ((b.size > 0 ? b.size : b.sizeEstimate) - (a.size > 0 ? a.size : a.sizeEstimate))
      || (a.detectedAt - b.detectedAt));
    return { items, eme: t.eme, pageUrl: t.pageUrl, pageTitle: t.pageTitle };
  }

  get(tabId, itemId) {
    const t = this.tabs.get(tabId);
    return t ? t.items.get(itemId) : null;
  }

  count(tabId) {
    const t = this.tabs.get(tabId);
    if (!t) return 0;
    let n = 0;
    for (const item of t.items.values()) if (item.kind !== 'subtitle') n++;
    return n;
  }

  notify(tabId) {
    if (this.notifyTimers.has(tabId)) return;
    this.notifyTimers.set(tabId, setTimeout(() => {
      this.notifyTimers.delete(tabId);
      this.emit('changed', tabId);
    }, 150));
  }
}

module.exports = { MediaRegistry, dirPrefix };
