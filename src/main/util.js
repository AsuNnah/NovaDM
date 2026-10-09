'use strict';
const path = require('path');
const fs = require('fs');

const CATEGORIES = {
  video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'ogv'],
  music: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'alac', 'aiff'],
  images: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'tif', 'tiff', 'ico'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp', 'epub', 'csv', 'md', 'srt', 'vtt'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'iso', 'cab'],
  programs: ['exe', 'msi', 'msix', 'appx', 'apk', 'xapk', 'bat', 'cmd', 'dmg', 'deb', 'rpm', 'appimage'],
};
const CATEGORY_LABELS = {
  video: 'Video', music: 'Music', images: 'Images', documents: 'Documents',
  archives: 'Archives', programs: 'Programs', other: 'Other',
};

const MIME_EXT = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/quicktime': 'mov',
  'video/x-msvideo': 'avi', 'video/x-flv': 'flv', 'video/mp2t': 'ts', 'video/3gpp': '3gp', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/webm': 'weba',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
  'application/x-rar-compressed': 'rar', 'application/vnd.rar': 'rar', 'application/x-7z-compressed': '7z',
  'application/gzip': 'gz', 'application/x-msdownload': 'exe', 'application/x-msi': 'msi',
  'application/vnd.android.package-archive': 'apk', 'text/vtt': 'vtt', 'application/x-subrip': 'srt',
  'application/msword': 'doc', 'text/plain': 'txt', 'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

function categoryOf(name, mime) {
  const ext = extOf(name);
  for (const [cat, list] of Object.entries(CATEGORIES)) if (list.includes(ext)) return cat;
  if (mime) {
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'music';
    if (mime.startsWith('image/')) return 'images';
  }
  return 'other';
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
function sanitizeFilename(name, fallback = 'download') {
  let n = String(name || '').replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(/[. ]+$/, '');
  if (!n) n = fallback;
  const ext = extOf(n);
  const base = ext ? n.slice(0, -(ext.length + 1)) : n;
  if (RESERVED.test(base)) n = '_' + n;
  // Keep full path under Windows MAX_PATH comfortably.
  if (n.length > 180) {
    n = ext ? base.slice(0, 175 - ext.length) + '.' + ext : n.slice(0, 180);
  }
  return n;
}

function filenameFromDisposition(cd) {
  if (!cd) return '';
  let m = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(cd);
  if (m) {
    try { return decodeURIComponent(m[2].trim().replace(/^"|"$/g, '')); } catch {}
  }
  m = /filename\s*=\s*"([^"]*)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  if (m) {
    const raw = m[1].trim();
    try { return decodeURIComponent(escape(raw)); } catch { return raw; } // fix UTF-8 sent as latin1
  }
  return '';
}

function filenameFromUrl(u) {
  try {
    const url = new URL(u);
    let last = url.pathname.split('/').filter(Boolean).pop() || '';
    try { last = decodeURIComponent(last); } catch {}
    return last || url.hostname;
  } catch {
    return '';
  }
}

function ensureExt(name, mime) {
  if (extOf(name)) return name;
  const base = (mime || '').split(';')[0].trim().toLowerCase();
  const ext = MIME_EXT[base];
  return ext ? `${name}.${ext}` : name;
}

function uniquePath(p, reserved = new Set()) {
  if (!fs.existsSync(p) && !fs.existsSync(p + '.part') && !reserved.has(p.toLowerCase())) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 1; i < 10000; i++) {
    const cand = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(cand) && !fs.existsSync(cand + '.part') && !reserved.has(cand.toLowerCase())) return cand;
  }
  return path.join(dir, `${base} ${Date.now()}${ext}`);
}

function headerValue(headers, name) {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  if (!key) return '';
  const v = headers[key];
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
}

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ''; }
}

// Registrable-ish site key: last two labels (three for common second-level TLDs).
function siteOf(u) {
  const host = hostOf(u);
  if (!host) return '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === 'localhost') return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const sld = parts[parts.length - 2];
  const twoLevel = ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'or', 'ne', 'go', 'my', 'web', 'sch'];
  if (twoLevel.includes(sld) && parts[parts.length - 1].length === 2) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// http(s) links in a piece of text (clipboard, pasted lists), in order, without duplicates.
function extractLinks(text, max = 1000) {
  const out = [];
  const seen = new Set();
  const re = /magnet:\?[^\s"'<>]+|https?:\/\/[^\s"'<>()\[\]{}]+(?:\[[^\s\]]*\][^\s"'<>()\[\]{}]*)*/gi;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < max) {
    const u = m[0].replace(/[.,;:!?]+$/, '');
    if (!seen.has(u)) { seen.add(u); out.push(u); }
  }
  return out;
}

/**
 * Batch pattern: "https://site/img[001-120].jpg" or "file[a-f].zip" expands to every link in the
 * range (zero-padding kept). Several ranges multiply. Returns [url] unchanged when there is none.
 */
function expandPattern(url, max = 10000) {
  const m = /\[(\d+)-(\d+)\]|\[([a-z])-([a-z])\]/i.exec(url);
  if (!m) return [url];
  const before = url.slice(0, m.index);
  const after = url.slice(m.index + m[0].length);
  const items = [];
  if (m[1] !== undefined) {
    const a = Number(m[1]); const b = Number(m[2]);
    const width = m[1].length === m[2].length && m[1].startsWith('0') ? m[1].length : 0;
    const step = a <= b ? 1 : -1;
    for (let i = a; step > 0 ? i <= b : i >= b; i += step) {
      items.push(width ? String(i).padStart(width, '0') : String(i));
      if (items.length > max) break;
    }
  } else {
    const a = m[3].charCodeAt(0); const b = m[4].charCodeAt(0);
    const step = a <= b ? 1 : -1;
    for (let c = a; step > 0 ? c <= b : c >= b; c += step) items.push(String.fromCharCode(c));
  }
  const out = [];
  for (const it of items) {
    for (const rest of expandPattern(before + it + after, max)) {
      out.push(rest);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Which hash a checksum string is (by length): 'md5' | 'sha1' | 'sha256' | 'sha512' | ''. */
function hashKind(hex) {
  const h = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(h)) return '';
  return { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' }[h.length] || '';
}

module.exports = {
  CATEGORIES, CATEGORY_LABELS, MIME_EXT, extOf, categoryOf, sanitizeFilename, filenameFromDisposition,
  filenameFromUrl, ensureExt, uniquePath, headerValue, hostOf, siteOf, delay, uid,
  extractLinks, expandPattern, hashKind,
};
