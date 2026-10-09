'use strict';
// History, bookmarks and the saved tab session (Restore tabs). Plain JSON files in the profile;
// private tabs are never recorded.
const path = require('path');
const { EventEmitter } = require('events');
const { JsonStore } = require('./store');

const MAX_HISTORY = 20000;
const HISTORY_DAYS = 90;
const MERGE_MS = 60 * 1000; // the same address again within a minute updates the last visit

function recordable(url) { return /^https?:\/\//i.test(url || '') && url.length <= 4096; }
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

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

class Bookmarks extends EventEmitter {
  constructor(dir, now = () => Date.now()) {
    super();
    this.now = now;
    this.store = new JsonStore(path.join(dir, 'bookmarks.json'), { seq: 0, items: [] });
    if (!Array.isArray(this.store.data.items)) this.store.data = { seq: 0, items: [] };
  }

  get items() { return this.store.data.items; }
  list() { return this.items.slice(); }
  find(url) { return this.items.find((b) => b.url === url) || null; }
  has(url) { return !!this.find(url); }
  folders() { return [...new Set(this.items.map((b) => b.folder).filter(Boolean))]; }

  add({ url, title = '', folder = '' }) {
    if (!/^(https?|file|novadm):/i.test(url || '')) return null;
    const old = this.find(url);
    if (old) return old;
    const b = { id: ++this.store.data.seq, url, title: String(title || hostOf(url) || url).slice(0, 300), folder: String(folder || '').slice(0, 100), added: this.now() };
    this.items.push(b);
    this.changed();
    return b;
  }

  /** Star button: bookmark the page, or remove it if it's already bookmarked. Returns the new state. */
  toggle(url, title) {
    const old = this.find(url);
    if (old) { this.remove(old.id); return false; }
    return !!this.add({ url, title });
  }

  update(id, patch) {
    const b = this.items.find((x) => x.id === id);
    if (!b) return null;
    if (typeof patch.title === 'string') b.title = patch.title.slice(0, 300);
    if (typeof patch.url === 'string' && /^(https?|file):/i.test(patch.url)) b.url = patch.url;
    if (typeof patch.folder === 'string') b.folder = patch.folder.slice(0, 100);
    this.changed();
    return b;
  }

  remove(id) {
    const before = this.items.length;
    this.store.data.items = this.items.filter((b) => b.id !== id);
    if (this.items.length !== before) this.changed();
  }

  /** Bookmarks file from Chrome / Brave / Edge / Firefox ("Export bookmarks" -> HTML). */
  importHtml(html) {
    let added = 0;
    let skipped = 0;
    const stack = [];
    const re = /<(\/?)(DL|H3|A)\b([^>]*)>([^<]*)/gi;
    let m;
    let pendingFolder = null;
    while ((m = re.exec(String(html || '')))) {
      const [, close, tag, attrs, text] = m;
      const t = tag.toUpperCase();
      if (t === 'H3' && !close) pendingFolder = decodeEntities(text.trim());
      else if (t === 'DL' && !close) { stack.push(pendingFolder); pendingFolder = null; }
      else if (t === 'DL' && close) stack.pop();
      else if (t === 'A' && !close) {
        const href = /\bHREF\s*=\s*"([^"]*)"/i.exec(attrs);
        if (!href) continue;
        const url = decodeEntities(href[1]);
        // The browser's own bar is the top level here; other folders keep their (innermost) name.
        const folder = [...stack].reverse().find((f) => f && !/^(bookmarks bar|bookmarks toolbar|favorites bar)$/i.test(f)) || '';
        if (this.has(url) || !/^https?:/i.test(url)) { skipped++; continue; }
        this.add({ url, title: decodeEntities(text.trim()), folder });
        added++;
      }
    }
    return { added, skipped };
  }

  exportHtml() {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const line = (b) => `        <DT><A HREF="${esc(b.url)}" ADD_DATE="${Math.floor((b.added || 0) / 1000)}">${esc(b.title)}</A>\n`;
    let out = '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n';
    out += '    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>\n    <DL><p>\n';
    for (const b of this.items.filter((x) => !x.folder)) out += line(b);
    for (const f of this.folders()) {
      out += `        <DT><H3>${esc(f)}</H3>\n        <DL><p>\n`;
      for (const b of this.items.filter((x) => x.folder === f)) out += '    ' + line(b);
      out += '        </DL><p>\n';
    }
    return out + '    </DL><p>\n</DL><p>\n';
  }

  changed() { this.store.save(500); this.emit('changed'); }
  flush() { this.store.flush(); }
}

function decodeEntities(s) {
  return String(s).replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" }[e]));
}

/** Open tabs (not private ones), saved often so a crash or power cut can restore them too. */
class TabSession {
  constructor(dir) {
    this.store = new JsonStore(path.join(dir, 'session.json'), { tabs: [], active: 0 });
  }

  load() {
    const d = this.store.data || {};
    const tabs = (Array.isArray(d.tabs) ? d.tabs : []).filter((t) => t && /^(https?|novadm):/i.test(t.url || ''));
    return { tabs, active: Math.max(0, Math.min(Number(d.active) || 0, tabs.length - 1)) };
  }

  save(tabs, activeIndex) {
    this.store.data = { tabs: tabs.map((t) => ({ url: t.url, title: t.title || '' })), active: activeIndex };
    this.store.save(1500);
  }

  clear() { this.store.data = { tabs: [], active: 0 }; this.store.save(0); }
  flush() { this.store.flush(); }
}

module.exports = { History, Bookmarks, TabSession, recordable };
