'use strict';
// Content grabber: collects downloadable content from a page (images incl. lazy-loaded, srcset,
// CSS backgrounds and links to full-size files; videos; audio; documents; archives).
const { CATEGORIES, extOf } = require('./util');

const ISOLATED_WORLD = 1999;

// Runs inside the page (isolated world: shared DOM, separate JS). Returns raw candidates.
const SCAN_SCRIPT = (autoScroll) => `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const startY = window.scrollY;
  if (${autoScroll ? 'true' : 'false'}) {
    const t0 = Date.now();
    let lastH = 0, still = 0;
    while (Date.now() - t0 < 15000 && still < 3) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(450);
      const h = document.documentElement.scrollHeight;
      if (h === lastH) still++; else { still = 0; lastH = h; }
    }
    window.scrollTo(0, startY);
    await sleep(300);
  }
  const out = [];
  const seen = new Set();
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const push = (url, o) => {
    const a = abs(url);
    if (!a || !/^https?:/.test(a) || seen.has(a)) return;
    seen.add(a);
    out.push({ url: a, ...o });
  };
  const bestFromSrcset = (ss) => {
    if (!ss) return '';
    let best = '', bestScore = -1;
    for (const part of ss.split(/,\\s+(?=[^\\s])/)) {
      const [u, d] = part.trim().split(/\\s+/);
      const m = /^(\\d+(?:\\.\\d+)?)([wx])$/.exec(d || '1x');
      const score = m ? Number(m[1]) * (m[2] === 'x' ? 1000 : 1) : 0;
      if (u && score > bestScore) { best = u; bestScore = score; }
    }
    return best;
  };
  const LAZY = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-full', 'data-large', 'data-hi-res', 'data-zoom-image', 'data-orig-file', 'data-large-file'];
  const IMG_RE = /\\.(jpe?g|png|gif|webp|avif|bmp|svg|heic|tiff?)(\\?|#|$)/i;

  document.querySelectorAll('img').forEach((img) => {
    const w = img.naturalWidth || img.width || 0, h = img.naturalHeight || img.height || 0;
    const alt = (img.alt || img.title || '').slice(0, 120);
    const big = bestFromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
    if (big) push(big, { kind: 'image', w: 0, h: 0, alt, from: 'srcset' });
    for (const a of LAZY) { const v = img.getAttribute(a); if (v && !v.startsWith('data:')) push(v, { kind: 'image', w: 0, h: 0, alt, from: 'lazy' }); }
    const src = img.currentSrc || img.src;
    if (src && !src.startsWith('data:') && !src.startsWith('blob:')) push(src, { kind: 'image', w, h, alt, from: 'img' });
    // Thumbnail linking to the full-size image.
    const link = img.closest('a[href]');
    if (link && IMG_RE.test(link.href)) push(link.href, { kind: 'image', w: 0, h: 0, alt, from: 'link' });
  });
  document.querySelectorAll('picture source[srcset], picture source[data-srcset]').forEach((s) => {
    const big = bestFromSrcset(s.getAttribute('srcset') || s.getAttribute('data-srcset'));
    if (big) push(big, { kind: 'image', w: 0, h: 0, alt: '', from: 'srcset' });
  });
  document.querySelectorAll('video, audio').forEach((m) => {
    const kind = m.tagName === 'AUDIO' ? 'audio' : 'video';
    if (m.src && !m.src.startsWith('blob:')) push(m.src, { kind, w: m.videoWidth || 0, h: m.videoHeight || 0, alt: '', from: 'media' });
    m.querySelectorAll('source[src]').forEach((s) => push(s.src, { kind, w: 0, h: 0, alt: '', from: 'media' }));
    if (m.poster) push(m.poster, { kind: 'image', w: 0, h: 0, alt: 'Video poster', from: 'poster' });
  });
  document.querySelectorAll('a[href]').forEach((a) => {
    const href = a.href;
    if (!/^https?:/.test(href)) return;
    const text = (a.textContent || a.title || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    push(href, { kind: 'link', w: 0, h: 0, alt: text, from: 'link' });
  });
  // CSS background images on visible, reasonably large elements.
  const els = document.querySelectorAll('body *');
  const limit = Math.min(els.length, 4000);
  for (let i = 0; i < limit; i++) {
    const el = els[i];
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 60) continue;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') continue;
    for (const m of bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)) {
      if (!m[1].startsWith('data:')) push(m[1], { kind: 'image', w: Math.round(r.width), h: Math.round(r.height), alt: '', from: 'css' });
    }
  }
  const og = document.querySelector('meta[property="og:image"]');
  if (og && og.content) push(og.content, { kind: 'image', w: 0, h: 0, alt: 'Page preview image', from: 'meta' });
  return { title: document.title || '', url: location.href, items: out };
})()`;

const KIND_BY_CATEGORY = { images: 'image', video: 'video', music: 'audio', documents: 'document', archives: 'archive', programs: 'program' };

function kindForUrl(url, hint) {
  const ext = extOf(urlPath(url));
  for (const [cat, list] of Object.entries(CATEGORIES)) if (list.includes(ext)) return KIND_BY_CATEGORY[cat];
  if (hint === 'image' || hint === 'video' || hint === 'audio') return hint;
  return null; // plain web page link: not downloadable content
}

function urlPath(u) { try { return decodeURIComponent(new URL(u).pathname); } catch { return u; } }

function nameFor(url) {
  const last = urlPath(url).split('/').filter(Boolean).pop() || '';
  return last.slice(0, 160);
}

/** Normalise raw scan results: keep downloadable kinds, add names, de-duplicate. */
function normalize(raw, pageUrl, pageTitle, tabId) {
  const out = [];
  const seen = new Set();
  for (const r of raw || []) {
    const key = r.url.split('#')[0];
    if (seen.has(key)) continue;
    const kind = kindForUrl(r.url, r.kind);
    if (!kind) continue;
    seen.add(key);
    out.push({
      url: key, kind, name: nameFor(r.url) || kind, alt: r.alt || '', w: r.w || 0, h: r.h || 0,
      from: r.from, pageUrl, pageTitle, tabId,
    });
  }
  return out;
}

async function scanTab(tab, { autoScroll = false } = {}) {
  const wc = tab.wc;
  if (!wc || wc.isDestroyed()) return { items: [], title: '', url: '' };
  const url = wc.getURL();
  if (!/^https?:/.test(url)) return { items: [], title: tab.title || '', url };
  const res = await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: SCAN_SCRIPT(autoScroll) }], true);
  return { title: res.title, url: res.url, items: normalize(res.items, res.url, res.title, tab.id) };
}

module.exports = { scanTab, normalize, kindForUrl };
