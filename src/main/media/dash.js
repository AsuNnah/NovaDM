'use strict';
// MPEG-DASH manifest (.mpd) parser: periods, adaptation sets, representations, and the segment list
// of a representation from SegmentTemplate ($Number$ / $Time$ / SegmentTimeline), SegmentList,
// SegmentBase (an index in the file: sidx) or a single BaseURL. ContentProtection marks DRM.
// Live (type="dynamic") manifests: the segments available now, from the timeline or, for numbered
// templates, from the clock (availabilityStartTime + segment duration).
const { readBoxes, parseSidx } = require('./mp4');

// ---- a small XML reader (MPDs are plain, well-formed XML) ------------------------------------------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENT[e] ?? m;
});

function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<\s*([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      const name = m[2].replace(/^.*:/, '');
      while (stack.length > 1 && stack[stack.length - 1].name !== name) stack.pop(); // tolerate stray tags
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {
      const el = { name: m[3].replace(/^.*:/, ''), attrs: {}, children: [], text: '' };
      const ar = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4] || ''))) el.attrs[a[1].replace(/^.*:/, '')] = unescape(a[3] ?? a[4] ?? '');
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += unescape(m[6]);
  }
  return root;
}

const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => (el ? el.children.find((c) => c.name === name) : null);

// ---- helpers --------------------------------------------------------------------------------------

/** ISO 8601 duration ("PT1H2M3.5S", "P1DT2H") in seconds. */
function parseDuration(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s || '').trim());
  if (!m) return 0;
  const [, y, mo, d, h, mi, se] = m.map((x) => Number(x) || 0);
  return y * 365 * 86400 + mo * 30 * 86400 + d * 86400 + h * 3600 + mi * 60 + se;
}

function resolveUrl(rel, base) { try { return new URL(rel, base).href; } catch { return rel; } }

function baseOf(el, parentBase) {
  const b = kid(el, 'BaseURL');
  return b && b.text.trim() ? resolveUrl(b.text.trim(), parentBase) : parentBase;
}

/** $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$ */
function fillTemplate(tpl, vars) {
  return String(tpl).replace(/\$(RepresentationID|Number|Time|Bandwidth|SubNumber)(?:%0(\d+)d)?\$|\$\$/g, (m, name, width) => {
    if (m === '$$') return '$';
    const v = vars[name];
    if (v === undefined) return m;
    const s = String(v);
    return width ? s.padStart(Number(width), '0') : s;
  });
}

function parseRange(s) {
  const m = /^(\d+)-(\d+)$/.exec(String(s || '').trim());
  return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : null;
}

// Segment info is inherited Period -> AdaptationSet -> Representation (lower levels override).
function mergedSegInfo(levels, name) {
  let merged = null;
  for (const lvl of levels) {
    const el = kid(lvl, name);
    if (!el) continue;
    merged = merged ? { ...merged, attrs: { ...merged.attrs, ...el.attrs }, children: el.children.length ? el.children : merged.children } : { ...el };
  }
  return merged;
}

function kindOf(as, rep) {
  const ct = (as.attrs.contentType || '').toLowerCase();
  const mime = (rep.attrs.mimeType || as.attrs.mimeType || '').toLowerCase();
  const codecs = (rep.attrs.codecs || as.attrs.codecs || '').toLowerCase();
  if (ct === 'video' || mime.startsWith('video/')) return 'video';
  if (ct === 'audio' || mime.startsWith('audio/')) return 'audio';
  if (ct === 'text' || mime.startsWith('text/') || /stpp|wvtt|ttml/.test(codecs)) return 'text';
  if (/avc|hvc|hev|vp0?9|av01/.test(codecs)) return 'video';
  if (/mp4a|opus|ac-3|ec-3|flac/.test(codecs)) return 'audio';
  return 'other';
}

// ---- manifest ---------------------------------------------------------------------------------------

/** Parse an MPD. Returns { live, duration, periods: [{ start, duration, sets: [...] }] }. */
function parse(text, mpdUrl) {
  if (!/<MPD[\s>]/.test(text || '')) throw new Error('Not a DASH manifest');
  const doc = parseXml(text);
  const mpd = kid(doc, 'MPD');
  const live = (mpd.attrs.type || 'static') === 'dynamic';
  const duration = parseDuration(mpd.attrs.mediaPresentationDuration);
  // Live timing: when segment numbers count from, and how far back the server keeps them.
  const liveInfo = live ? {
    availabilityStart: Date.parse(mpd.attrs.availabilityStartTime || '') || 0,
    timeShiftBufferDepth: parseDuration(mpd.attrs.timeShiftBufferDepth) || 0,
  } : null;
  const mpdBase = baseOf(mpd, mpdUrl);
  const periodsEl = kids(mpd, 'Period');
  const periods = [];
  let cursor = 0;
  periodsEl.forEach((p, pi) => {
    const start = p.attrs.start ? parseDuration(p.attrs.start) : cursor;
    const next = periodsEl[pi + 1];
    let pdur = p.attrs.duration ? parseDuration(p.attrs.duration) : 0;
    if (!pdur && next && next.attrs.start) pdur = parseDuration(next.attrs.start) - start;
    if (!pdur && duration) pdur = duration - start;
    cursor = start + pdur;
    const pBase = baseOf(p, mpdBase);
    const sets = kids(p, 'AdaptationSet').map((as) => {
      const asBase = baseOf(as, pBase);
      const asDrm = kids(as, 'ContentProtection').length > 0;
      const reps = kids(as, 'Representation').map((r) => {
        const kind = kindOf(as, r);
        const w = Number(r.attrs.width || as.attrs.width) || 0;
        const h = Number(r.attrs.height || as.attrs.height) || 0;
        return {
          id: r.attrs.id || '', kind, bandwidth: Number(r.attrs.bandwidth) || 0, width: w, height: h,
          codecs: r.attrs.codecs || as.attrs.codecs || '', mimeType: r.attrs.mimeType || as.attrs.mimeType || '',
          lang: as.attrs.lang || r.attrs.lang || '', label: (kid(as, 'Label') || {}).text || as.attrs.label || '',
          drm: asDrm || kids(r, 'ContentProtection').length > 0,
          // what segmentsFor() needs
          _levels: [p, as, r], _base: baseOf(r, asBase), _periodStart: start, _periodDuration: pdur, _live: liveInfo,
        };
      });
      return { id: as.attrs.id || '', kind: reps[0] ? reps[0].kind : 'other', lang: as.attrs.lang || '', representations: reps };
    });
    periods.push({ id: p.attrs.id || String(pi), start, duration: pdur, sets });
  });
  return {
    live, duration: duration || cursor, periods, minimumUpdatePeriod: parseDuration(mpd.attrs.minimumUpdatePeriod),
    suggestedPresentationDelay: parseDuration(mpd.attrs.suggestedPresentationDelay), ...(liveInfo || {}),
  };
}

/**
 * Segments of a representation: { init: { url, range } | null, segments: [{ url, range, time, duration }],
 *   index: { url, range } (SegmentBase: the sidx must be fetched; see segmentsFromSidx), whole (one file) }.
 * time/duration in seconds. Live: only the segments available at `now` (ms).
 */
function segmentsFor(rep, { now = Date.now() } = {}) {
  const levels = rep._levels;
  const base = rep._base;
  const tpl = mergedSegInfo(levels, 'SegmentTemplate');
  if (tpl) {
    const a = tpl.attrs;
    const timescale = Number(a.timescale) || 1;
    const startNumber = a.startNumber !== undefined ? Number(a.startNumber) : 1;
    const pto = Number(a.presentationTimeOffset) || 0;
    const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
    const init = a.initialization ? { url: resolveUrl(fillTemplate(a.initialization, vars), base), range: null } : null;
    const segments = [];
    const timeline = kid(tpl, 'SegmentTimeline');
    if (timeline) {
      let t = 0;
      let n = startNumber;
      const ss = kids(timeline, 'S');
      // Live: a repeat count of -1 runs up to the live edge (now), not to the end of the period.
      const liveEdge = rep._live && rep._live.availabilityStart ? pto + ((now - rep._live.availabilityStart) / 1000 - rep._periodStart) * timescale : Infinity;
      const periodEnd = rep._periodDuration ? pto + rep._periodDuration * timescale : liveEdge;
      ss.forEach((s, si) => {
        if (s.attrs.t !== undefined) t = Number(s.attrs.t);
        const d = Number(s.attrs.d) || 0;
        let r = Number(s.attrs.r) || 0;
        if (r < 0) {
          const nextT = ss[si + 1] && ss[si + 1].attrs.t !== undefined ? Number(ss[si + 1].attrs.t) : periodEnd;
          const toEdge = !(ss[si + 1] && ss[si + 1].attrs.t !== undefined) && !rep._periodDuration && rep._live;
          if (toEdge) r = d > 0 && Number.isFinite(nextT) ? Math.floor((nextT - t) / d + 1e-9) - 1 : 0; // complete segments only
          else r = d > 0 && Number.isFinite(nextT) ? Math.ceil((nextT - t) / d) - 1 : 0;
        }
        for (let k = 0; k <= r && d > 0; k++) {
          segments.push({ url: resolveUrl(fillTemplate(a.media, { ...vars, Number: n, Time: t }), base), range: null, time: (t - pto) / timescale, duration: d / timescale });
          t += d; n++;
        }
      });
    } else if (a.duration && rep._live) {
      // Live numbered segments: segment k is complete once its end has passed (counted from
      // availabilityStartTime); the server keeps the last timeShiftBufferDepth seconds.
      const d = Number(a.duration);
      const live = rep._live;
      const elapsed = (now - live.availabilityStart) / 1000 - rep._periodStart;
      const segDur = d / timescale;
      const last = Math.floor(elapsed / segDur + 1e-9) - 1;
      const keep = live.timeShiftBufferDepth ? Math.floor(live.timeShiftBufferDepth / segDur) : 60;
      for (let k = Math.max(0, last - keep + 1); k <= last; k++) {
        segments.push({ url: resolveUrl(fillTemplate(a.media, { ...vars, Number: startNumber + k, Time: pto + k * d }), base), range: null, time: (k * d) / timescale, duration: segDur });
      }
    } else if (a.duration) {
      const d = Number(a.duration);
      const count = Math.max(1, Math.ceil((rep._periodDuration * timescale) / d - 1e-9));
      for (let k = 0; k < count && k < 200000; k++) {
        segments.push({ url: resolveUrl(fillTemplate(a.media, { ...vars, Number: startNumber + k, Time: k * d }), base), range: null, time: (k * d) / timescale, duration: d / timescale });
      }
    }
    return { init, segments, index: null, whole: false, timescale };
  }
  const list = mergedSegInfo(levels, 'SegmentList');
  if (list) {
    const timescale = Number(list.attrs.timescale) || 1;
    const d = Number(list.attrs.duration) || 0;
    const ini = kid(list, 'Initialization');
    const init = ini ? { url: resolveUrl(ini.attrs.sourceURL || '', base), range: parseRange(ini.attrs.range) } : null;
    const segments = kids(list, 'SegmentURL').map((s, k) => ({
      url: resolveUrl(s.attrs.media || '', base), range: parseRange(s.attrs.mediaRange), time: (k * d) / timescale, duration: d / timescale,
    }));
    return { init, segments, index: null, whole: false, timescale };
  }
  const sb = mergedSegInfo(levels, 'SegmentBase');
  if (sb && sb.attrs.indexRange) {
    const ini = kid(sb, 'Initialization');
    const idx = parseRange(sb.attrs.indexRange);
    const init = { url: base, range: ini && ini.attrs.range ? parseRange(ini.attrs.range) : { offset: 0, length: idx.offset } };
    return { init, segments: [], index: { url: base, range: idx }, whole: false };
  }
  return { init: null, segments: [{ url: base, range: null, time: 0, duration: rep._periodDuration }], index: null, whole: true };
}

/** SegmentBase: turn the fetched index (bytes [range.offset ...]) into segment byte ranges. */
function segmentsFromSidx(buf, url, rangeOffset) {
  const sidx = readBoxes(buf).find((b) => b.type === 'sidx');
  if (!sidx) throw new Error('No segment index (sidx) in the file');
  const { refs } = parseSidx(buf, sidx);
  return refs.filter((r) => !r.isSidx).map((r) => ({
    url, range: { offset: rangeOffset + r.offset, length: r.size }, time: r.time / r.timescale, duration: r.duration / r.timescale,
  }));
}

/**
 * Choose what to download from a period: the video representation closest to `height` (best when
 * not given) and the best audio (preferring `lang`). DRM-protected sets are skipped.
 */
function pick(period, { height = 0, videoId = '', audioId = '', lang = '' } = {}) {
  const reps = period.sets.flatMap((s) => s.representations);
  const videos = reps.filter((r) => r.kind === 'video').sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  const audios = reps.filter((r) => r.kind === 'audio').sort((a, b) => b.bandwidth - a.bandwidth);
  let video = videos.find((r) => r.id === videoId) || null;
  if (!video && videos.length) video = height ? (videos.find((r) => r.height <= height) || videos[videos.length - 1]) : videos[0];
  let audio = audios.find((r) => r.id === audioId) || null;
  if (!audio && audios.length) audio = (lang && audios.find((r) => r.lang && r.lang.toLowerCase().startsWith(lang.toLowerCase()))) || audios[0];
  return { video, audio, drm: !!((video && video.drm) || (audio && audio.drm)) };
}

module.exports = { parse, parseXml, parseDuration, fillTemplate, segmentsFor, segmentsFromSidx, pick };
