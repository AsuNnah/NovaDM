'use strict';
// History, bookmarks and the saved tab session (Restore tabs). Plain JSON files in the profile;
// private tabs are never recorded.
const path = require('path');
const { EventEmitter } = require('events');
const { JsonStore } = require('./store');
const { Bookmarks } = require('./bookmarks');

const MAX_HISTORY = 20000;
const HISTORY_DAYS = 90;
const MERGE_MS = 60 * 1000; // the same address again within a minute updates the last visit

function recordable(url) { return /^https?:\/\//i.test(url || '') && url.length <= 4096; }

class History extends EventEmitter {
  constructor(dir, now = () => Date.now()) {
    super();
    this.now = now;
    this.store = new JsonStore(path.join(dir, 'history.json'), { seq: 0, visits: [] });
    if (!Array.isArray(this.store.data.visits)) this.store.data = { seq: 0, visits: [] };
    this.prune();
  }

  get visits() { return this.store.data.visits; }

  /** A page was opened. Returns the visit. */
  add(url, title = '') {
    if (!recordable(url)) return null;
    const t = this.now();
    const last = this.visits[this.visits.length - 1];
    if (last && last.url === url && t - last.t < MERGE_MS) {
      last.t = t;
      if (title) last.title = title;
    } else {
      this.visits.push({ id: ++this.store.data.seq, url, title: String(title || '').slice(0, 300), t });
      if (this.visits.length > MAX_HISTORY) this.visits.splice(0, this.visits.length - MAX_HISTORY);
    }
    this.changed();
    return this.visits[this.visits.length - 1];
  }

  /** The page's title arrived after the visit was recorded. */
  setTitle(url, title) {
    if (!title) return;
    for (let i = this.visits.length - 1, n = 0; i >= 0 && n < 20; i--, n++) {
      if (this.visits[i].url === url) { if (this.visits[i].title !== title) { this.visits[i].title = String(title).slice(0, 300); this.changed(); } return; }
    }
  }

  /** Newest first; `q` matches title or address; `before` pages through older visits. */
  search({ q = '', limit = 100, before = Infinity } = {}) {
    const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    for (let i = this.visits.length - 1; i >= 0 && out.length < limit; i--) {
      const v = this.visits[i];
      if (v.t >= before) continue;
      if (words.length) {
        const hay = (v.title + ' ' + v.url).toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      out.push(v);
    }
    return out;
  }

  /** Addresses for the address bar: often and recently visited pages that match what was typed. */
  suggest(q, limit = 6) {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return [];
    const score = new Map();
    const now = this.now();
    for (let i = this.visits.length - 1, n = 0; i >= 0 && n < 5000; i--, n++) {
      const v = this.visits[i];
      const bare = v.url.replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
      const prefix = bare.startsWith(s);
      if (!prefix && !v.title.toLowerCase().includes(s) && !bare.includes(s)) continue;
      const days = (now - v.t) / 86400000;
      const e = score.get(v.url) || { url: v.url, title: v.title, score: 0 };
      e.score += (prefix ? 3 : 1) / (1 + days / 7);
      if (!e.title && v.title) e.title = v.title;
      score.set(v.url, e);
    }
    return [...score.values()].sort((a, b) => b.score - a.score).slice(0, limit).map(({ url, title }) => ({ url, title }));
  }

  remove(ids) {
    const set = new Set(ids);
    const before = this.visits.length;
    this.store.data.visits = this.visits.filter((v) => !set.has(v.id));
    if (this.visits.length !== before) this.changed();
  }

  /** Clear everything visited in the last `ms` milliseconds (Infinity: all). */
  clear(ms = Infinity) {
    const from = ms === Infinity ? -Infinity : this.now() - ms;
    this.store.data.visits = this.visits.filter((v) => v.t < from);
    this.changed();
  }

  prune() {
    const from = this.now() - HISTORY_DAYS * 86400000;
    const i = this.visits.findIndex((v) => v.t >= from);
    if (i > 0) { this.visits.splice(0, i); this.store.save(); }
    else if (i < 0 && this.visits.length) { this.store.data.visits = []; this.store.save(); }
  }

  changed() { this.store.save(2000); this.emit('changed'); }
  flush() { this.store.flush(); }
}

/** Open tabs (not private ones), saved often so a crash or power cut can restore them too. */
class TabSession {
  constructor(dir) {
    this.store = new JsonStore(path.join(dir, 'session.json'), { tabs: [], active: 0 });
  }

  /** { tabs: [{ url, title, pinned?, group? }], groups: [{ id, title, color, collapsed }], active } */
  /**
   * { tabs, groups, active, windows: [{ tabs, groups, active, bounds }] }. `windows` (1.6) has every
   * normal window; a session saved by an older NovaDM is one window without a position.
   */
  load() {
    const d = this.store.data || {};
    const one = (w) => {
      const tabs = (Array.isArray(w.tabs) ? w.tabs : []).filter((t) => t && /^(https?|novadm):/i.test(t.url || ''));
      const groups = (Array.isArray(w.groups) ? w.groups : []).filter((g) => g && typeof g.id === 'string');
      const b = w.bounds;
      const bounds = b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(b[k])) ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
      return { tabs, groups, active: Math.max(0, Math.min(Number(w.active) || 0, tabs.length - 1)), bounds };
    };
    const windows = (Array.isArray(d.windows) && d.windows.length ? d.windows : [d]).map(one).filter((w) => w.tabs.length);
    const first = windows[0] || one({});
    return { tabs: first.tabs, groups: first.groups, active: first.active, windows };
  }

  /**
   * windows: [{ tabs (Browser tabs: pinned, groupId), active (index), groups, bounds }], the first is
   * the main window. Its tabs are also kept at the top level, which older NovaDM versions read.
   */
  save(windows) {
    const one = (w) => ({
      tabs: w.tabs.map((t) => ({ url: t.url, title: t.title || '', ...(t.pinned ? { pinned: true } : {}), ...(t.groupId != null ? { group: t.groupId } : {}) })),
      groups: (w.groups || []).map((g) => ({ id: g.id, title: g.title, color: g.color, collapsed: !!g.collapsed })),
      active: w.active || 0,
      ...(w.bounds ? { bounds: w.bounds } : {}),
    });
    const list = windows.map(one);
    this.store.data = { ...(list[0] || { tabs: [], groups: [], active: 0 }), windows: list };
    this.store.save(1500);
  }

  clear() { this.store.data = { tabs: [], active: 0 }; this.store.save(0); }
  flush() { this.store.flush(); }
}

module.exports = { History, Bookmarks, TabSession, recordable };
