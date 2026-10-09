'use strict';
// Shared logic of the NovaDM browser extension (also loaded by the unit tests in Node).
// Wrapped so its names don't clash with the scripts that load it (service worker, options page).
(() => {

  const DEFAULTS = {
    port: 9614,
    key: '',
    intercept: true, // send the browser's downloads to NovaDM
    minSizeMB: 1, // ...when they are at least this big (unknown sizes count as big)
    types: 'zip rar 7z gz xz tar iso img exe msi msix apk dmg mp4 mkv avi mov webm m4v mp3 m4a flac wav ogg pdf epub torrent',
    skipHosts: '', // sites whose downloads stay in the browser
  };

  const ext = (name) => { const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '').split(/[?#]/)[0]); return m ? m[1].toLowerCase() : ''; };
  const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
  const words = (s) => String(s || '').toLowerCase().split(/[\s,;]+/).map((x) => x.replace(/^\./, '')).filter(Boolean);

  /**
   * Should this browser download go to NovaDM instead?
   * item: chrome.downloads.DownloadItem fields { url, finalUrl, filename, mime, fileSize, totalBytes, byExtensionId }
   */
  function shouldIntercept(item, settings, ownId) {
    const s = { ...DEFAULTS, ...settings };
    if (!s.intercept || !s.key) return false;
    const url = item.finalUrl || item.url || '';
    if (!/^https?:\/\//i.test(url)) return false; // blob:, data: and file: stay in the browser
    if (item.byExtensionId && item.byExtensionId === ownId) return false; // our own fallback download
    const host = hostOf(url);
    if (words(s.skipHosts).some((h) => host === h || host.endsWith('.' + h))) return false;
    const size = Number(item.fileSize || item.totalBytes || 0);
    if (size > 0 && size < s.minSizeMB * 1024 * 1024) return false;
    const types = new Set(words(s.types));
    const e = ext(item.filename) || ext(url);
    if (e && types.has(e)) return true;
    return /^(video|audio)\//i.test(item.mime || '');
  }

  /** A network response a page received: is it a video/stream worth listing? */
  function classifyResponse(url, contentType, contentLength) {
    const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    const e = ext(url);
    if (/mpegurl/.test(ct) || e === 'm3u8') return 'hls';
    if (ct === 'application/dash+xml' || e === 'mpd') return 'dash';
    if (/^video\/(mp2t|iso\.segment)$/.test(ct) || ['ts', 'm4s'].includes(e)) return null; // stream pieces
    const big = Number(contentLength || 0) === 0 || Number(contentLength) >= 300 * 1024;
    if (ct.startsWith('video/') && big) return 'video';
    if (ct.startsWith('audio/') && big) return 'audio';
    return null;
  }

  /** Cookie header from chrome.cookies.getAll() results. */
  function cookieHeader(cookies) {
    return (cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
  }

  /** Body for POST /api/v1/downloads. */
  function addBody({ url, name = '', referer = '', pageUrl = '', cookies = '', size = 0, start = false }) {
    const body = { url, start: !!start };
    if (name) body.name = name;
    if (/^https?:/i.test(referer)) body.referer = referer;
    if (/^https?:/i.test(pageUrl)) body.pageUrl = pageUrl;
    if (cookies) body.cookies = cookies;
    if (size > 0) body.size = size;
    return body;
  }

  function apiUrl(settings, path) { return `http://127.0.0.1:${Number(settings.port) || DEFAULTS.port}/api/v1/${path}`; }

  const NovaLib = { DEFAULTS, shouldIntercept, classifyResponse, cookieHeader, addBody, apiUrl, ext };
  if (typeof module !== 'undefined' && module.exports) module.exports = NovaLib;
  else globalThis.NovaLib = NovaLib;
})();
