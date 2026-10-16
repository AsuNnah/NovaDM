'use strict';
// Bookmarks as a tree (1.7): two roots, 'bar' (Bookmarks bar) and 'other' (Other bookmarks), and folders
// that hold bookmarks and other folders. Stored flat in bookmarks.json: { v: 2, seq, nodes: [...] }, each
// node { id, type: 'url' | 'folder', title, url?, parent: 'bar' | 'other' | <folder id>, added, icon? };
// the order of the array is the display order among the nodes with the same parent.
// 1.6 and earlier kept { seq, items: [{ url, title, folder }] }; that file is copied to bookmarks.v1.json
// the first time and converted.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { JsonStore } = require('./store');

const ROOTS = ['bar', 'other'];
const URL_OK = /^(https?|file|novadm):/i;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', hellip: '\u2026', ndash: '\u2013', mdash: '\u2014', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d' };
function decodeEntities(s) {
  return String(s).replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]+));/gi, (m, dec, hex, name) => {
    if (name) return NAMED[name.toLowerCase()] || m;
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

/** Bookmarks HTML ("Netscape" format, what every browser exports) -> { bar: [], other: [] } of
 *  { title, url } | { title, children }. */
function parseHtml(html) {
  const root = { children: [] };
  const stack = [root];
  let pending = null;
  const re = /<(\/?)(DL|H3|A)\b([^>]*)>([^<]*)/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const [, close, tag, attrs, text] = m;
    const t = tag.toUpperCase();
    const top = stack[stack.length - 1];
    if (t === 'H3' && !close) {
      pending = { title: decodeEntities(text.trim()), children: [], toolbar: /PERSONAL_TOOLBAR_FOLDER\s*=\s*["']?true/i.test(attrs), unfiled: /UNFILED_BOOKMARKS_FOLDER\s*=\s*["']?true/i.test(attrs) };
      top.children.push(pending);
    } else if (t === 'DL' && !close) {
      stack.push(pending || top); // a list with no folder name is the file's own top level
      pending = null;
    } else if (t === 'DL' && close) {
      if (stack.length > 1) stack.pop();
    } else if (t === 'A' && !close) {
      const href = /\bHREF\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const target = href && (href[1] ?? href[2] ?? href[3]);
      if (target) top.children.push({ title: decodeEntities(text.trim()), url: decodeEntities(target) });
    }
  }
  const out = { bar: [], other: [] };
  for (const n of root.children) {
    if (n.children && (n.toolbar || /^(bookmarks bar|bookmarks toolbar|favorites bar)$/i.test(n.title))) out.bar.push(...n.children);
    else if (n.children && (n.unfiled || /^other (bookmarks|favorites)$/i.test(n.title))) out.other.push(...n.children);
    else out.other.push(n);
  }
  return out;
}

class Bookmarks extends EventEmitter {
  constructor(dir, now = () => Date.now()) {
    super();
    this.now = now;
    this.store = new JsonStore(path.join(dir, 'bookmarks.json'), { v: 2, seq: 0, nodes: [] });
    if (!Array.isArray(this.store.data.nodes)) this.migrate(dir);
  }

  /** 1.6 and earlier: plain bookmarks go to the bar, each old folder becomes a folder on the bar. */
  migrate(dir) {
    const old = this.store.data && Array.isArray(this.store.data.items) ? this.store.data.items : [];
    try { fs.copyFileSync(this.store.file, path.join(dir, 'bookmarks.v1.json')); } catch {}
    let seq = Number(this.store.data && this.store.data.seq) || 0;
    const nodes = [];
    const url = (b, parent) => ({ id: b.id, type: 'url', title: b.title || '', url: b.url, parent, added: b.added || 0, ...(b.icon ? { icon: b.icon } : {}) });
    for (const b of old) if (!b.folder) nodes.push(url(b, 'bar'));
    const folders = new Map();
    for (const b of old) {
      if (!b.folder) continue;
      if (!folders.has(b.folder)) { const f = { id: ++seq, type: 'folder', title: b.folder, parent: 'bar', added: b.added || 0 }; folders.set(b.folder, f); nodes.push(f); }
      nodes.push(url(b, folders.get(b.folder).id));
    }
    this.store.data = { v: 2, seq, nodes };
    this.store.flush();
  }

  get nodes() { return this.store.data.nodes; }
  /** The bookmarks themselves, in any folder (not the folders). */
  get items() { return this.nodes.filter((n) => n.type === 'url'); }
  list() { return this.items.slice(); }
  node(id) { return this.nodes.find((n) => n.id === id) || null; }
  find(url) { return this.items.find((b) => b.url === url) || null; }
  has(url) { return !!this.find(url); }
  children(parent) { return this.nodes.filter((n) => n.parent === parent); }
  isContainer(id) { return ROOTS.includes(id) || (this.node(id) || {}).type === 'folder'; }
  /** A folder's bookmarks and all folders below it, flattened (for "open all"). */
  urlsIn(parent) { return this.children(parent).flatMap((n) => (n.type === 'url' ? [n] : this.urlsIn(n.id))); }

  /** Where the star puts a new bookmark: the folder last chosen in the bookmark popup, else the bar. */
  lastParent() { const l = this.store.data.last; return l != null && this.isContainer(l) ? l : 'bar'; }
  /** The folders last chosen (newest first, at most 3), for the popup's folder list. */
  recentFolders() { return (this.store.data.recent || []).map((id) => this.node(id)).filter((n) => n && n.type === 'folder'); }
  useFolder(id) {
    if (!this.isContainer(id)) return;
    this.store.data.last = id;
    if (typeof id === 'number') this.store.data.recent = [id, ...(this.store.data.recent || []).filter((x) => x !== id)].slice(0, 3);
    this.store.save(500);
  }
  add({ url, title = '', parent = this.lastParent() }) {
    if (!URL_OK.test(url || '')) return null;
    const old = this.find(url);
    if (old) return old;
    if (!this.isContainer(parent)) parent = 'bar';
    const b = { id: ++this.store.data.seq, type: 'url', title: String(title || hostOf(url) || url).slice(0, 300), url, parent, added: this.now() };
    this.nodes.push(b);
    this.changed();
    return b;
  }

  addFolder(title, parent = 'bar') {
    if (!this.isContainer(parent)) parent = 'bar';
    const f = { id: ++this.store.data.seq, type: 'folder', title: String(title || 'New folder').slice(0, 100), parent, added: this.now() };
    this.nodes.push(f);
    this.changed();
    return f;
  }

  /** Star button: bookmark the page, or remove it if it's already bookmarked. Returns the new state. */
  toggle(url, title) {
    const old = this.find(url);
    if (old) { this.remove(old.id); return false; }
    return !!this.add({ url, title });
  }

  update(id, patch) {
    const b = this.node(id);
    if (!b) return null;
    if (typeof patch.title === 'string') b.title = patch.title.slice(0, b.type === 'folder' ? 100 : 300);
    if (b.type === 'url' && typeof patch.url === 'string' && /^(https?|file):/i.test(patch.url)) b.url = patch.url;
    this.changed();
    return b;
  }

  /** Put a node under `parent` ('bar', 'other' or a folder) at position `index` among that parent's children. */
  move(id, parent, index) {
    const n = this.node(id);
    if (!n || !this.isContainer(parent) || parent === id) return false;
    for (let p = this.node(parent); p; p = this.node(p.parent)) if (p.id === id) return false; // into itself
    this.store.data.nodes = this.nodes.filter((x) => x !== n);
    n.parent = parent;
    const sibs = this.children(parent);
    const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : sibs.length, sibs.length));
    if (at < sibs.length) this.nodes.splice(this.nodes.indexOf(sibs[at]), 0, n); else this.nodes.push(n);
    this.changed();
    return true;
  }

  /** Several at once. A node whose folder is also in the list moves with that folder. Returns how many moved. */
  moveMany(ids, parent) {
    const set = new Set(ids);
    const under = (n) => { for (let p = this.node(n.parent); p; p = this.node(p.parent)) if (set.has(p.id)) return true; return false; };
    let moved = 0;
    for (const id of ids) { const n = this.node(id); if (n && !under(n) && this.move(id, parent, 1e9)) moved++; }
    return moved;
  }

  removeMany(ids) { for (const id of ids) this.remove(id); }

  /** The bookmarks in these nodes (folders count with everything inside), without repeats. */
  urlsOf(ids) {
    const out = new Map();
    for (const id of ids) { const n = this.node(id); if (!n) continue; for (const b of n.type === 'url' ? [n] : this.urlsIn(n.id)) out.set(b.id, b); }
    return [...out.values()];
  }

  remove(id) {
    const gone = new Set([id]);
    for (let grew = true; grew;) { grew = false; for (const n of this.nodes) if (!gone.has(n.id) && gone.has(n.parent)) { gone.add(n.id); grew = true; } }
    const before = this.nodes.length;
    this.store.data.nodes = this.nodes.filter((n) => !gone.has(n.id));
    if (this.nodes.length !== before) this.changed();
  }

  /** Add { bar: [], other: [] } (nodes: { title, url } or { title, children }). Folders with the same name
   *  are merged, bookmarks already here are skipped. Returns { added, skipped }. */
  importTree(tree) {
    let added = 0;
    let skipped = 0;
    const walk = (list, parent) => {
      for (const n of list || []) {
        if (Array.isArray(n.children)) {
          const same = this.children(parent).find((c) => c.type === 'folder' && c.title === n.title);
          const f = same || this.addFolder(n.title || 'Folder', parent);
          walk(n.children, f.id);
        } else if (this.has(n.url) || !/^https?:/i.test(n.url || '')) skipped++;
        else { this.add({ url: n.url, title: n.title, parent }); added++; }
      }
    };
    walk(tree.bar, 'bar');
    walk(tree.other, 'other');
    return { added, skipped };
  }

  importHtml(html) { return this.importTree(parseHtml(html)); }

  exportHtml() {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const walk = (parent, pad) => this.children(parent).map((n) => (n.type === 'url'
      ? `${pad}<DT><A HREF="${esc(n.url)}" ADD_DATE="${Math.floor((n.added || 0) / 1000)}">${esc(n.title)}</A>\n`
      : `${pad}<DT><H3>${esc(n.title)}</H3>\n${pad}<DL><p>\n${walk(n.id, pad + '    ')}${pad}</DL><p>\n`)).join('');
    return '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n'
      + `    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>\n    <DL><p>\n${walk('bar', '        ')}    </DL><p>\n`
      + `    <DT><H3 UNFILED_BOOKMARKS_FOLDER="true">Other bookmarks</H3>\n    <DL><p>\n${walk('other', '        ')}    </DL><p>\n`
      + '</DL><p>\n';
  }

  changed() { this.store.save(500); this.emit('changed'); }
  flush() { this.store.flush(); }
}

module.exports = { Bookmarks, parseHtml };
