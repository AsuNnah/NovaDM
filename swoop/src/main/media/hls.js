'use strict';
// HLS (M3U8) playlist parser: master playlists (variants, renditions, session keys) and media
// playlists (segments, keys, init maps, byte ranges, live/VOD).

const DRM_KEYFORMATS = /widevine|playready|com\.apple\.streamingkeydelivery|urn:uuid/i;

function parseAttributes(s) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m;
  while ((m = re.exec(s))) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

function resolve(uri, base) {
  try { return new URL(uri, base).href; } catch { return uri; }
}

function parseResolution(s) {
  const m = /^(\d+)\s*x\s*(\d+)$/i.exec(s || '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function isPlaylist(text) {
  return /^﻿?\s*#EXTM3U/.test(text || '');
}

function parse(text, baseUrl) {
  if (!isPlaylist(text)) throw new Error('Not an HLS playlist');
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, baseUrl) {
  const variants = [];
  const renditions = [];
  const sessionKeys = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(l.slice(18));
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) { uri = lines[j]; i = j; break; }
      }
      if (!uri) continue;
      variants.push({
        url: resolve(uri, baseUrl),
        bandwidth: Number(a.BANDWIDTH) || 0,
        avgBandwidth: Number(a['AVERAGE-BANDWIDTH']) || 0,
        resolution: parseResolution(a.RESOLUTION),
        codecs: a.CODECS || '',
        frameRate: Number(a['FRAME-RATE']) || 0,
        audioGroup: a.AUDIO || '',
        subtitleGroup: a.SUBTITLES || '',
      });
    } else if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(l.slice(13));
      renditions.push({
        type: (a.TYPE || '').toUpperCase(), groupId: a['GROUP-ID'] || '', name: a.NAME || '',
        language: a.LANGUAGE || '', isDefault: a.DEFAULT === 'YES', url: a.URI ? resolve(a.URI, baseUrl) : '',
      });
    } else if (l.startsWith('#EXT-X-SESSION-KEY:')) {
      sessionKeys.push(parseAttributes(l.slice(19)));
    }
  }
  // An audio group whose renditions have their own URI means the audio is a separate stream.
  for (const v of variants) {
    v.audioSeparate = !!v.audioGroup && renditions.some((r) => r.type === 'AUDIO' && r.groupId === v.audioGroup && r.url);
  }
  variants.sort((a, b) => (heightOf(b) - heightOf(a)) || (b.bandwidth - a.bandwidth));
  const drm = sessionKeys.some((k) => isDrmKey(k));
  return { type: 'master', variants, renditions, drm };
}

function heightOf(v) { return v.resolution ? v.resolution.height : 0; }

function isDrmKey(attrs) {
  const method = (attrs.METHOD || '').toUpperCase();
  if (method === 'NONE' || method === '') return false;
  if (method.startsWith('SAMPLE-AES')) return true;
  return !!attrs.KEYFORMAT && attrs.KEYFORMAT !== 'identity' && DRM_KEYFORMATS.test(attrs.KEYFORMAT);
}

function parseMedia(lines, baseUrl) {
  const segments = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let playlistType = '';
  let key = null;
  let map = null;
  let pendingDuration = null;
  let pendingTitle = '';
  let pendingRange = null;
  let discontinuity = false;
  let lastRangeEnd = { uri: '', end: 0 };
  let encryption = 'none';
  for (const l of lines) {
    if (l.startsWith('#EXTINF:')) {
      const rest = l.slice(8);
      const comma = rest.indexOf(',');
      pendingDuration = parseFloat(comma >= 0 ? rest.slice(0, comma) : rest) || 0;
      pendingTitle = comma >= 0 ? rest.slice(comma + 1) : '';
    } else if (l.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(l.slice(22)) || 0;
    } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(l.slice(22)) || 0;
    } else if (l.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = l.slice(21).trim().toUpperCase();
    } else if (l.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(l.slice(11));
      const method = (a.METHOD || 'NONE').toUpperCase();
      if (method === 'NONE') key = null;
      else {
        key = { method, url: a.URI ? resolve(a.URI, baseUrl) : '', iv: a.IV || '', keyFormat: a.KEYFORMAT || 'identity' };
        if (isDrmKey(a)) encryption = 'drm';
        else if (method === 'AES-128' && encryption !== 'drm') encryption = 'aes128';
        else if (encryption === 'none') encryption = 'unsupported';
      }
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(l.slice(11));
      map = { url: resolve(a.URI || '', baseUrl), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, null) : null };
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = l.slice(17).trim();
    } else if (l.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuity = true;
    } else if (!l.startsWith('#')) {
      const url = resolve(l, baseUrl);
      let range = null;
      if (pendingRange) {
        const prev = lastRangeEnd.uri === url ? lastRangeEnd.end : 0;
        range = parseByteRange(pendingRange, prev);
        lastRangeEnd = { uri: url, end: range.offset + range.length };
      }
      segments.push({
        url, duration: pendingDuration ?? targetDuration, title: pendingTitle, range,
        key, map, discontinuity, seq: mediaSequence + segments.length,
      });
      pendingDuration = null; pendingTitle = ''; pendingRange = null; discontinuity = false;
    }
  }
  const duration = segments.reduce((s, x) => s + (x.duration || 0), 0);
  const live = !endList && playlistType !== 'VOD';
  return { type: 'media', segments, duration, targetDuration, mediaSequence, endList, live, playlistType, encryption, hasMap: !!segments.find((s) => s.map) };
}

function parseByteRange(s, prevEnd) {
  const [len, off] = s.split('@');
  return { length: Number(len), offset: off !== undefined ? Number(off) : (prevEnd || 0) };
}

/** 16-byte IV: explicit hex IV, or the media sequence number (big-endian) per the HLS spec. */
function ivFor(segment) {
  const buf = Buffer.alloc(16);
  if (segment.key && segment.key.iv) {
    const hex = segment.key.iv.replace(/^0x/i, '').padStart(32, '0').slice(-32);
    Buffer.from(hex, 'hex').copy(buf);
  } else {
    buf.writeUInt32BE(Math.floor(segment.seq / 2 ** 32) >>> 0, 8);
    buf.writeUInt32BE(segment.seq >>> 0, 12);
  }
  return buf;
}

function variantLabel(v) {
  if (v.resolution) return `${v.resolution.height}p`;
  const m = /(\d{3,4})p/i.exec(v.url || '');
  if (m) return `${m[1]}p`;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)} kbps`;
  return 'Default';
}

/** Guess the container from the first bytes of a segment. */
function sniffContainer(buf) {
  if (!buf || buf.length < 8) return 'unknown';
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'ts';
  const box = buf.slice(4, 8).toString('latin1');
  if (['ftyp', 'styp', 'moof', 'sidx', 'moov', 'emsg', 'prft'].includes(box)) return 'fmp4';
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    // ID3 tag: packed audio (AAC/MP3) or TS with ID3 prefix; look past the tag.
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const after = buf.slice(10 + size);
    if (after[0] === 0xff && (after[1] & 0xf6) === 0xf0) return 'aac';
    if (after[0] === 0xff && (after[1] & 0xe0) === 0xe0) return 'mp3';
    return 'audio';
  }
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'aac';
  return 'unknown';
}

module.exports = { parse, parseAttributes, isPlaylist, ivFor, variantLabel, sniffContainer, isDrmKey };
