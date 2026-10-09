'use strict';
// Decides whether a network response is downloadable media, a stream fragment, or noise.

const HLS_MIMES = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl', 'application/mpegurl']);
const DASH_MIMES = new Set(['application/dash+xml']);
const SUB_MIMES = new Set(['text/vtt', 'application/x-subrip', 'text/srt', 'application/ttml+xml', 'text/x-ssa']);
const SEGMENT_MIMES = new Set(['video/mp2t', 'video/iso.segment', 'audio/mp2t', 'video/vnd.dlna.mpeg-tts']);
const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', '3gp', 'ogv', 'f4v']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'weba']);
const SUB_EXT = new Set(['vtt', 'srt', 'ass', 'ssa', 'ttml', 'dfxp']);
const GENERIC_MIMES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/force-download', 'application/download']);

// seg_00001.mp4, chunk-12.m4s, frag3, part_7, /segment/42 ...
const SEGMENT_NAME = /(?:^|[/_.-])(?:seg|segment|chunk|frag|fragment|part|media)[-_]?\d+(?:[._-]|$)/i;
const INIT_NAME = /(?:^|[/_-])init(?:[-_.][\w-]*)?\.(?:mp4|m4s|m4v|m4a)$/i;
const STORYBOARD = /thumb|sprite|storyboard|preview|seek/i;

function urlParts(u) {
  try {
    const url = new URL(u);
    const name = decodeURIComponent(url.pathname.split('/').pop() || '');
    const m = /\.([a-z0-9]{1,5})$/i.exec(name);
    return { url, name, ext: m ? m[1].toLowerCase() : '' };
  } catch {
    return null;
  }
}

function sizeFrom(headers, status) {
  const cr = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(headers['content-range'] || '');
  if (cr) return { size: cr[3] === '*' ? -1 : Number(cr[3]), rangeStart: Number(cr[1]) };
  const cl = Number(headers['content-length']);
  return { size: status === 200 && cl > 0 ? cl : -1, rangeStart: 0 };
}

/**
 * @param {object} r { url, method, statusCode, resourceType, headers (lower-case keys) }
 * @param {object} opts { minMediaKB }
 * @returns {null|{kind, mime, ext, name, size}}
 *   kind: 'hls' | 'dash' | 'video' | 'audio' | 'subtitle' | 'segment'
 */
function classify(r, opts = {}) {
  if (!r || r.method !== 'GET') return null;
  if (r.statusCode < 200 || r.statusCode >= 300) return null;
  const parts = urlParts(r.url);
  if (!parts || !/^https?:$/.test(parts.url.protocol)) return null;
  const headers = r.headers || {};
  const mime = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (mime === 'text/html' || mime.startsWith('image/') || mime === 'text/css' || mime.includes('javascript') || mime === 'application/json') {
    // Some servers send playlists as JSON/HTML types by mistake; only trust the extension for m3u8.
    if (!(parts.ext === 'm3u8' && mime !== 'text/html')) return null;
  }
  const { ext, name } = parts;
  const { size, rangeStart } = sizeFrom(headers, r.statusCode);
  const base = { mime, ext, name, size };

  if (HLS_MIMES.has(mime) || ext === 'm3u8' || (ext === 'm3u' && mime.includes('mpegurl'))) return { ...base, kind: 'hls' };
  if (DASH_MIMES.has(mime) || ext === 'mpd') return { ...base, kind: 'dash' };
  if (SUB_MIMES.has(mime) || (SUB_EXT.has(ext) && (GENERIC_MIMES.has(mime) || mime.startsWith('text/')))) {
    if (STORYBOARD.test(name)) return null;
    return { ...base, kind: 'subtitle' };
  }
  if (SEGMENT_MIMES.has(mime) || ext === 'ts' || ext === 'm4s' || INIT_NAME.test(name)) return { ...base, kind: 'segment' };

  let kind = null;
  if (mime.startsWith('video/')) kind = 'video';
  else if (mime.startsWith('audio/')) kind = 'audio';
  else if (GENERIC_MIMES.has(mime) && VIDEO_EXT.has(ext)) kind = 'video';
  else if (GENERIC_MIMES.has(mime) && AUDIO_EXT.has(ext)) kind = 'audio';
  if (!kind) return null;

  // A fragment file name (seg_00001.mp4, chunk-12.m4s, ...) is a segment however it is loaded.
  if (SEGMENT_NAME.test(name) || SEGMENT_NAME.test(parts.url.pathname)) return { ...base, kind: 'segment' };

  const minBytes = (opts.minMediaKB ?? 300) * 1024;
  const direct = r.resourceType === 'media' || r.resourceType === 'mainFrame' || r.resourceType === 'subFrame';
  if (direct) {
    // Played by a <video>/<audio> element (or opened directly): trust it unless it's tiny.
    if (size >= 0 && size < minBytes) return null;
    return { ...base, kind };
  }
  // Fetched by script (MSE players): usually fragments. Keep only large, whole files.
  if (rangeStart > 0) return { ...base, kind: 'segment' };
  if (size < Math.max(minBytes, 1024 * 1024)) return size < 0 ? null : { ...base, kind: 'segment' };
  return { ...base, kind };
}

/** Key used to merge repeated requests for the same file (range/cache-busting params removed). */
function dedupeKey(u) {
  try {
    const url = new URL(u);
    for (const p of ['range', 'bytestart', 'byteend', 'rn', 'rbuf', '_', 'cb', 't']) url.searchParams.delete(p);
    url.hash = '';
    return url.href;
  } catch {
    return u;
  }
}

/** Key that ignores the host, used to group the same file served by several CDN hosts. */
function mirrorKey(u) {
  try {
    const url = new URL(dedupeKey(u));
    return url.pathname + url.search;
  } catch {
    return u;
  }
}

module.exports = { classify, dedupeKey, mirrorKey, SEGMENT_NAME };
