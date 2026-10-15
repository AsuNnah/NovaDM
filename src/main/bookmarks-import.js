'use strict';
// Reading bookmarks from other browsers on this PC: Chrome, Edge, Brave and Vivaldi keep a JSON file
// ("Bookmarks") in each profile; Firefox keeps places.sqlite (read from a copy, so it works while Firefox
// is open). Everything stays on this PC. Cookies and saved passwords are not touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseHtml } = require('./bookmarks');

const CHROMIUM = [
  ['Chrome', 'LOCALAPPDATA', ['Google', 'Chrome', 'User Data']],
  ['Edge', 'LOCALAPPDATA', ['Microsoft', 'Edge', 'User Data']],
  ['Brave', 'LOCALAPPDATA', ['BraveSoftware', 'Brave-Browser', 'User Data']],
  ['Vivaldi', 'LOCALAPPDATA', ['Vivaldi', 'User Data']],
];

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const listDir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

/** Installed browsers with bookmarks: [{ browser, profile, kind: 'chromium' | 'firefox', file }]. */
function detectBrowsers(env = process.env) {
  const out = [];
  for (const [browser, base, parts] of CHROMIUM) {
    if (!env[base]) continue;
    const root = path.join(env[base], ...parts);
    const names = (readJson(path.join(root, 'Local State')) || {}).profile?.info_cache || {};
    for (const d of listDir(root).filter((x) => x === 'Default' || /^Profile \d+$/.test(x))) {
      const file = path.join(root, d, 'Bookmarks');
      if (fs.existsSync(file)) out.push({ browser, profile: (names[d] && names[d].name) || d, kind: 'chromium', file });
    }
  }
  if (env.APPDATA) {
    const root = path.join(env.APPDATA, 'Mozilla', 'Firefox', 'Profiles');
    for (const d of listDir(root)) {
      const file = path.join(root, d, 'places.sqlite');
      if (fs.existsSync(file)) out.push({ browser: 'Firefox', profile: d.replace(/^[^.]*\./, '') || d, kind: 'firefox', file });
    }
  }
  return out;
}

/** Chrome / Edge / Brave "Bookmarks" file text -> { bar, other }. */
function fromChromiumJson(text) {
  const roots = (JSON.parse(text) || {}).roots || {};
  const conv = (n) => (n.type === 'folder' ? { title: n.name || '', children: (n.children || []).map(conv) } : { title: n.name || '', url: n.url || '' });
  const kids = (r) => ((r && r.children) || []).map(conv);
  const out = { bar: kids(roots.bookmark_bar), other: kids(roots.other) };
  const mobile = kids(roots.synced);
  if (mobile.length) out.other.push({ title: 'Mobile bookmarks', children: mobile });
  return out;
}

/** Firefox places.sqlite -> { bar, other }. Reads a copy, because Firefox may have the file open. */
function fromFirefox(file) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-ff-'));
  try {
    const copy = path.join(tmp, 'places.sqlite');
    fs.copyFileSync(file, copy);
    for (const ext of ['-wal', '-shm']) { try { fs.copyFileSync(file + ext, copy + ext); } catch {} } // not-yet-merged changes
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db.prepare('SELECT b.id, b.type, b.parent, b.title, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position').all();
      const kids = new Map();
      for (const r of rows) { if (!kids.has(r.parent)) kids.set(r.parent, []); kids.get(r.parent).push(r); }
      const conv = (r) => (r.type === 2 ? { title: r.title || '', children: (kids.get(r.id) || []).map(conv).filter(Boolean) } : r.type === 1 && r.url ? { title: r.title || '', url: r.url } : null);
      const under = (guid) => { const root = rows.find((r) => r.guid === guid); return root ? (kids.get(root.id) || []).map(conv).filter(Boolean) : []; };
      const out = { bar: under('toolbar_____'), other: under('unfiled_____') };
      for (const [guid, title] of [['menu________', 'Bookmarks menu'], ['mobile______', 'Mobile bookmarks']]) {
        const c = under(guid);
        if (c.length) out.other.push({ title, children: c });
      }
      return out;
    } finally { db.close(); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** A bookmarks file the user picked: the HTML export of any browser, or a Chromium "Bookmarks" JSON file. */
function fromFileText(text) {
  return /^\s*\{/.test(text) ? fromChromiumJson(text) : parseHtml(text);
}

function readBrowser(entry) {
  return entry.kind === 'firefox' ? fromFirefox(entry.file) : fromChromiumJson(fs.readFileSync(entry.file, 'utf8'));
}

module.exports = { detectBrowsers, fromChromiumJson, fromFirefox, fromFileText, readBrowser };
