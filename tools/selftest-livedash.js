'use strict';
// In-app self-test for live DASH recording (1.1), against a local live server: a page plays a
// dynamic MPD (numbered segments that appear every 2 s, real fragmented MP4 video + audio). The
// recording runs ~10 s, is stopped, and the file must play in Chromium with picture and sound.
// A second live stream ends by itself (the manifest turns static), which must finish the file too.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const muxjs = require('mux.js');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-livedash.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const SEGDIR = path.join(__dirname, '..', 'node_modules', 'mux.js', 'test', 'segments');
const SEG = 2; // seconds per segment

// Segment k of each track: the sample stream again, placed at k * 2 s on the timeline.
const TS = fs.readFileSync(path.join(SEGDIR, 'test-segment.ts'));
const cache = new Map();
function segment(k) {
  if (cache.has(k)) return cache.get(k);
  const out = {};
  const tx = new muxjs.mp4.Transmuxer({ remux: false, baseMediaDecodeTime: k * 90000 * SEG });
  tx.on('data', (s) => { out[s.type === 'video' ? 'v' : 'a'] = { init: Buffer.from(s.initSegment), data: Buffer.from(s.data) }; });
  tx.push(new Uint8Array(TS)); tx.flush();
  cache.set(k, out);
  return out;
}

function mpd({ ast, ended, startNumber = 1 }) {
  const type = ended ? 'static' : 'dynamic';
  const extra = ended ? 'mediaPresentationDuration="PT20S"' : `availabilityStartTime="${new Date(ast).toISOString()}" minimumUpdatePeriod="PT2S" timeShiftBufferDepth="PT30S"`;
  return `<?xml version="1.0"?><MPD type="${type}" ${extra} profiles="urn:mpeg:dash:profile:isoff-live:2011"><Period id="p0" start="PT0S">
    <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate initialization="v/init.mp4" media="v/$Number$.m4s" timescale="1" duration="${SEG}" startNumber="${startNumber}"/>
      <Representation id="v720" bandwidth="1000000" width="1280" height="720" codecs="avc1.4d401e"/></AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4"><SegmentTemplate initialization="a/init.mp4" media="a/$Number$.m4s" timescale="1" duration="${SEG}" startNumber="${startNumber}"/>
      <Representation id="aud" bandwidth="128000" codecs="mp4a.40.2"/></AdaptationSet></Period></MPD>`;
}

module.exports = async ({ app, browser, media, downloads, settings, ipc }) => {
  const result = {};
  const files = {};
  const t0 = Date.now() - 12000; // the "broadcast" began 12 s ago
  let endAfter = Infinity; // stream 2: the manifest turns static after this time
  try {
    const server = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      const m = /^\/(live|ends)\/(v|a)\/(init\.mp4|(\d+)\.m4s)$/.exec(u);
      if (m) {
        const k = m[4] ? Number(m[4]) - 1 : 0;
        if (m[4] && t0 + (k + 1) * SEG * 1000 > Date.now()) { res.writeHead(404); return res.end(); } // not yet available
        const body = m[4] ? segment(k)[m[2]].data : segment(0)[m[2]].init;
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
        return res.end(body);
      }
      if (u === '/live/stream.mpd') { res.writeHead(200, { 'Content-Type': 'application/dash+xml' }); return res.end(mpd({ ast: t0 })); }
      if (u === '/ends/stream.mpd') { res.writeHead(200, { 'Content-Type': 'application/dash+xml' }); return res.end(mpd({ ast: t0, ended: Date.now() > endAfter })); }
      if (u === '/live.html' || u === '/ends.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><title>${u === '/live.html' ? 'Live DASH show' : 'Ending show'}</title><script>fetch("${u.replace('.html', '')}/stream.mpd").then(r=>r.text())</script>`);
      }
      if (u.startsWith('/files/')) { const body = fs.readFileSync(files[u]); res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length }); return res.end(body); }
      if (u.startsWith('/play/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<!doctype html><video id="v" muted autoplay playsinline src="/files/${u.slice(6)}"></video>`); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    settings.set({ downloadDir: path.join(app.getPath('userData'), 'dl-livedash'), categoryFolders: false, skipEditor: true, notifyOnComplete: false, pageTitleNames: true });

    const record = async (page, title) => {
      const tabId = browser.createTab({ url: base + page });
      const item = await until(() => media.list(tabId).items.find((i) => i.kind === 'dash'), 10000);
      if (!item) return { detected: false };
      browser.selectTab(tabId);
      await ipc['media.download']({ id: item.id, variantUrl: item.variants[0] && item.variants[0].url });
      const rec = await until(() => downloads.list().find((d) => d.name.includes(title)), 5000);
      return { detected: true, live: item.live, rec };
    };
    const play = async (savePath) => {
      const key = '/files/' + path.basename(savePath).replace(/[^a-z0-9.]+/gi, '_');
      files[key] = savePath;
      const tab = browser.tabs.get(browser.createTab({ url: base + '/play/' + key.slice(7) }));
      await sleep(2500);
      const r = await tab.wc.executeJavaScript('(() => { const v = document.getElementById("v"); return { duration: v.duration, width: v.videoWidth, time: v.currentTime, error: v.error && v.error.code, videoBytes: v.webkitVideoDecodedByteCount, audioBytes: v.webkitAudioDecodedByteCount }; })()');
      browser.closeTab(tab.id);
      return r;
    };

    // 1. Record ~10 s, then Stop.
    const a = await record('/live.html', 'Live DASH show');
    result.detected = { detected: a.detected, live: a.live };
    if (a.rec) {
      const rec1 = await until(() => { const r = downloads.get(a.rec.id); return r && r.recording && r.recordedSeconds >= 2 && r; }, 15000);
      result.whileRecording = rec1 && { recording: rec1.recording, live: rec1.live, state: rec1.state };
      await sleep(10000);
      const mid = downloads.get(a.rec.id);
      result.recordedBeforeStop = mid.recordedSeconds;
      await ipc['downloads.stopRecording']({ id: a.rec.id });
      const done = await until(() => { const r = downloads.get(a.rec.id); return r && ['done', 'error'].includes(r.state) && r; }, 20000);
      result.stopped = done && { state: done.state, error: done.error, recordedSeconds: done.recordedSeconds, size: done.size, gaps: done.liveGaps };
      if (done && done.state === 'done') result.playback = await play(done.savePath);
    }

    // 2. A broadcast that ends by itself.
    endAfter = Date.now() + 7000;
    const b = await record('/ends.html', 'Ending show');
    if (b.rec) {
      const done = await until(() => { const r = downloads.get(b.rec.id); return r && ['done', 'error'].includes(r.state) && r; }, 40000);
      result.endsByItself = done && { state: done.state, error: done.error, recordedSeconds: done.recordedSeconds };
    }
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
