'use strict';
// Live end-to-end check: real public HLS stream -> download 10 segments with a pause/resume in
// the middle -> one valid MP4 whose timeline is continuous for every track.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { app, session } = require('electron');
const net = require('../src/main/net');
const hls = require('../src/main/media/hls');
const { HlsDownload } = require('../src/main/download/hls-dl');

const MASTER = process.env.SMOKE_URL || 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const SEGMENTS = 10;
const out = {};
function finish(code) { fs.writeFileSync(path.join(os.tmpdir(), 'novadm-smoke.json'), JSON.stringify(out, null, 2)); app.exit(code); }

// { trackId: [baseMediaDecodeTime per fragment] }
function trackTimes(buf) {
  const res = {};
  const walk = (start, end, ctx) => {
    let i = start;
    while (i + 8 <= end) {
      const size = buf.readUInt32BE(i);
      const type = buf.toString('latin1', i + 4, i + 8);
      if (size < 8) break;
      if (type === 'moof') walk(i + 8, i + size, {});
      if (type === 'traf') walk(i + 8, i + size, ctx);
      if (type === 'tfhd') ctx.track = buf.readUInt32BE(i + 12);
      if (type === 'tfdt') {
        const t = buf[i + 8] === 1 ? Number(buf.readBigUInt64BE(i + 12)) : buf.readUInt32BE(i + 12);
        (res[ctx.track] = res[ctx.track] || []).push(t);
      }
      i += size;
    }
  };
  walk(0, buf.length, {});
  return res;
}

app.whenReady().then(async () => {
  const ses = session.fromPartition('smoke');
  net.installRefererHook(ses);
  const openConn = (url, opts) => net.open(url, { ...opts, session: ses });
  const fetchText = async (url) => { const r = await net.fetchText(url, { session: ses, timeoutMs: 20000 }); return { text: r.text, finalUrl: r.finalUrl }; };
  const hard = setTimeout(() => { out.error = 'timeout'; finish(2); }, 120000);
  try {
    const master = hls.parse((await fetchText(MASTER)).text, MASTER);
    const variant = master.type === 'master' ? master.variants[master.variants.length - 1] : { url: MASTER };
    const medRes = await fetchText(variant.url);
    // Keep the first SEGMENTS segments.
    const kept = []; let n = 0;
    for (const l of medRes.text.replace(/\r/g, '').split('\n')) {
      kept.push(l);
      if (l && !l.startsWith('#') && ++n >= SEGMENTS) { kept.push('#EXT-X-ENDLIST'); break; }
    }
    const trimmed = kept.join('\n');
    const save = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-smoke-')), 'clip.mp4');
    const opts = {
      savePath: save, playlistUrl: variant.url, openConn, concurrency: 2, convertTs: true,
      fetchText: async (url) => (url === variant.url ? { text: trimmed, finalUrl: variant.url } : fetchText(url)),
    };

    const dl = new HlsDownload({ id: 's', ...opts });
    dl.start();
    await new Promise((r, j) => {
      dl.on('error', j);
      dl.on('progress', (p) => { if (p.doneSegments >= 4 && dl.state === 'downloading') r(); });
    });
    await dl.pause();
    out.pausedAt = dl.doneSegments;
    out.bytesAtPause = fs.statSync(save + '.part').size;

    const dl2 = new HlsDownload({ id: 's', ...opts });
    await new Promise((res, rej) => { dl2.on('done', res); dl2.on('error', rej); dl2.start(); });
    out.resumed = dl2.resumed;
    const buf = fs.readFileSync(save);
    out.outputBytes = buf.length;
    const times = trackTimes(buf);
    out.tracks = {};
    for (const [id, list] of Object.entries(times)) {
      const deltas = list.slice(1).map((t, i) => t - list[i]);
      out.tracks[id] = {
        fragments: list.length, first: list[0], last: list[list.length - 1],
        increasing: deltas.every((d) => d > 0),
        maxStepVsMedian: (() => { const s = [...deltas].sort((a, b) => a - b); const med = s[Math.floor(s.length / 2)] || 1; return +(Math.max(...deltas) / med).toFixed(2); })(),
      };
    }
    out.ok = out.resumed && Object.values(out.tracks).every((t) => t.fragments === SEGMENTS && t.increasing && t.first === 0 && t.maxStepVsMedian < 1.6);
    clearTimeout(hard);
    finish(out.ok ? 0 : 4);
  } catch (e) {
    clearTimeout(hard);
    out.error = String(e && e.stack || e);
    finish(5);
  }
});
