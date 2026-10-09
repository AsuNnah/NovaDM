'use strict';
// Bencode (the .torrent file format) and torrent metadata: name, files, total size, info hash.
const crypto = require('crypto');

/** Decode bencoded data. Byte strings stay Buffers; dictionary keys become strings. */
function decode(buf) {
  let p = 0;
  const end = buf.length;
  const fail = (m) => { throw new Error('Not a valid torrent file: ' + m); };
  function next() {
    if (p >= end) fail('unexpected end');
    const c = buf[p];
    if (c === 0x69) { // i<int>e
      const e = buf.indexOf(0x65, p);
      if (e < 0) fail('bad integer');
      const n = Number(buf.toString('latin1', p + 1, e));
      if (!Number.isFinite(n)) fail('bad integer');
      p = e + 1;
      return n;
    }
    if (c === 0x6c) { // l...e
      p++;
      const list = [];
      while (buf[p] !== 0x65) { if (p >= end) fail('unterminated list'); list.push(next()); }
      p++;
      return list;
    }
    if (c === 0x64) { // d...e
      p++;
      const dict = {};
      const spans = {};
      while (buf[p] !== 0x65) {
        if (p >= end) fail('unterminated dictionary');
        const key = next().toString('utf8');
        const start = p;
        dict[key] = next();
        spans[key] = [start, p];
      }
      p++;
      Object.defineProperty(dict, '__spans', { value: spans, enumerable: false });
      return dict;
    }
    if (c >= 0x30 && c <= 0x39) { // <len>:<bytes>
      const colon = buf.indexOf(0x3a, p);
      const len = Number(buf.toString('latin1', p, colon));
      if (colon < 0 || !Number.isFinite(len) || colon + 1 + len > end) fail('bad string');
      const s = buf.subarray(colon + 1, colon + 1 + len);
      p = colon + 1 + len;
      return s;
    }
    return fail('unexpected byte');
  }
  const v = next();
  return v;
}

function encode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(v.length + ':'), v]);
  if (typeof v === 'string') return encode(Buffer.from(v, 'utf8'));
  if (typeof v === 'number') return Buffer.from(`i${Math.trunc(v)}e`);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(encode), Buffer.from('e')]);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [encode(k), encode(v[k])]), Buffer.from('e')]);
  }
  throw new Error('Cannot bencode ' + typeof v);
}

/** What a .torrent contains: { name, infoHash, files: [{ path, length }], length, trackers }. */
function torrentInfo(buf) {
  const t = decode(buf);
  if (!t || !t.info || !t.__spans.info) throw new Error('Not a valid torrent file: no info');
  const [a, b] = t.__spans.info;
  const infoHash = crypto.createHash('sha1').update(buf.subarray(a, b)).digest('hex');
  const info = t.info;
  const name = (info['name.utf-8'] || info.name || Buffer.from('torrent')).toString('utf8');
  let files;
  if (Array.isArray(info.files)) {
    files = info.files.map((f) => ({ path: (f['path.utf-8'] || f.path || []).map((x) => x.toString('utf8')).join('/'), length: f.length || 0 }));
  } else {
    files = [{ path: name, length: info.length || 0 }];
  }
  const trackers = [];
  if (t.announce) trackers.push(t.announce.toString('utf8'));
  for (const tier of t['announce-list'] || []) for (const u of tier) trackers.push(u.toString('utf8'));
  return { name, infoHash, files, length: files.reduce((s, f) => s + f.length, 0), multi: Array.isArray(info.files), trackers: [...new Set(trackers)] };
}

/** magnet:?xt=urn:btih:<hash>&dn=<name>&tr=... -> { infoHash, name, trackers } or null. */
function parseMagnet(uri) {
  if (!/^magnet:\?/i.test(uri || '')) return null;
  const q = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
  const xt = q.getAll('xt').find((x) => /^urn:btih:/i.test(x));
  if (!xt) return null;
  let hash = xt.slice(9);
  if (/^[a-z2-7]{32}$/i.test(hash)) hash = base32ToHex(hash);
  if (!/^[0-9a-f]{40}$/i.test(hash)) return null;
  return { infoHash: hash.toLowerCase(), name: q.get('dn') || '', trackers: q.getAll('tr') };
}

function base32ToHex(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

module.exports = { decode, encode, torrentInfo, parseMagnet };
