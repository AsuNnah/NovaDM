'use strict';
// In-app self-test for the 0.5.0 video features, against a local server only:
//  - a page that loads a DASH manifest -> detected (qualities) -> downloaded -> one MP4 that
//    Chromium plays with picture AND sound
//  - the same for HLS with a separate audio rendition (TS video + AAC audio)
//  - a live HLS stream: recording, Stop, finished file
//  - FFmpeg not installed: status, and conversions explain what is missing
// Run with a throwaway NOVADM_USERDATA.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const muxjs = require('mux.js');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-phase4.json');
const LOG = OUT + '.log';
const step = (m, x) => { try { fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${m}${x ? ' ' + JSON.stringify(x) : ''}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const SEGDIR = path.join(__dirname, '..', 'node_modules', 'mux.js', 'test', 'segments');

function routesFor() {
  const routes = {};
  const TS = fs.readFileSync(path.join(SEGDIR, 'test-segment.ts'));
  // DASH: 3 segments, separate video/audio fragmented MP4.
  for (let k = 0; k < 3; k++) {
    const tx = new muxjs.mp4.Transmuxer({ remux: false, baseMediaDecodeTime: k * 90000 * 2 });
    tx.on('data', (s) => {
      const dir = s.type === 'video' ? 'v' : 'a';
      if (k === 0) routes[`/dash/${dir}/init.mp4`] = Buffer.from(s.initSegment);
      routes[`/dash/${dir}/${k + 1}.m4s`] = Buffer.from(s.data);
    });
    tx.push(new Uint8Array(TS)); tx.flush();
  }
  routes['/dash/stream.mpd'] = ['application/dash+xml', `<?xml version="1.0"?><MPD type="static" mediaPresentationDuration="PT6S"><Period>
    <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate initialization="v/init.mp4" media="v/$Number$.m4s" timescale="1" duration="2"/>
      <Representation id="v720" bandwidth="1000000" width="1280" height="720" codecs="avc1.4d401e"/></AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4"><SegmentTemplate initialization="a/init.mp4" media="a/$Number$.m4s" timescale="1" duration="2"/>
      <Representation id="aud" bandwidth="128000" codecs="mp4a.40.2"/></AdaptationSet></Period></MPD>`];
  // HLS with separate audio.
  const V = fs.readFileSync(path.join(SEGDIR, 'test-no-audio-segment.ts'));
  const A = fs.readFileSync(path.join(SEGDIR, 'test-aac-segment.aac'));
  routes['/hls/master.m3u8'] = ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aud"\nvideo.m3u8\n'];
  routes['/hls/video.m3u8'] = ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\nv0.ts\n#EXT-X-ENDLIST\n'];
  routes['/hls/audio.m3u8'] = ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1,\na0.aac\n#EXT-X-ENDLIST\n'];
  routes['/hls/v0.ts'] = ['video/mp2t', V];
  routes['/hls/a0.aac'] = ['audio/aac', A];
  // Pages that load the streams (as a player script would).
  routes['/dash.html'] = ['text/html', '<!doctype html><title>DASH clip</title><script>fetch("/dash/stream.mpd").then(r=>r.text())</script>'];
  routes['/hls.html'] = ['text/html', '<!doctype html><title>HLS clip</title><script>fetch("/hls/master.m3u8").then(r=>r.text())</script>'];
  routes['/live.html'] = ['text/html', '<!doctype html><title>Live show</title><script>fetch("/live/live.m3u8").then(r=>r.text())</script>'];
  return routes;
}

function startServer(routes, files) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u === '/live/live.m3u8') {
        const n = Math.floor((Date.now() - t0) / 400) + 4;
        let p = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${n - 4}\n`;
        for (let i = n - 4; i < n; i++) p += `#EXTINF:1,\nseg${i}.bin\n`;
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(p);
      }
      const lm = /^\/live\/seg(\d+)\.bin$/.exec(u);
      if (lm) { const b = Buffer.alloc(1500, Number(lm[1]) % 256); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': b.length }); return res.end(b); }
      if (u.startsWith('/files/')) {
        const f = files[u];
        if (!f) { res.writeHead(404); return res.end(); }
        const body = fs.readFileSync(f);
        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': body.length });
        return res.end(body);
      }
      if (u.startsWith('/play/')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`<!doctype html><video id="v" muted autoplay playsinline src="/files/${u.slice(6)}"></video>`);
      }
      const r = routes[u];
      if (!r) { res.writeHead(404); return res.end(); }
      const [type, body] = Array.isArray(r) ? r : ['application/octet-stream', r];
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

module.exports = async ({ app, browser, media, downloads, settings, ipc }) => {
  const result = {};
  try { fs.rmSync(LOG, { force: true }); } catch {}
  try {
    const files = {};
    const routes = routesFor();
    const { server, base } = await startServer(routes, files);
    const dlDir = path.join(app.getPath('userData'), 'dl-phase4');
    fs.rmSync(dlDir, { recursive: true, force: true });
    settings.set({ downloadDir: dlDir, categoryFolders: false, skipEditor: true, notifyOnComplete: false, pageTitleNames: true });

    // Open a page, wait for its stream to be detected, download it from the media panel.
    const grab = async (page, kind) => {
      const tabId = browser.createTab({ url: base + page });
      const item = await until(() => media.list(tabId).items.find((i) => i.kind === kind), 10000);
      if (!item) return { detected: false };
      browser.selectTab(tabId);
      await ipc['media.download']({ id: item.id, variantUrl: item.variants[0] && item.variants[0].url });
      const rec = await until(() => downloads.list().find((d) => d.addedAt > Date.now() - 20000 && d.name.includes(kind === 'dash' ? 'DASH clip' : kind === 'hls' && page.includes('live') ? 'Live show' : 'HLS clip')), 5000);
      return { detected: true, variants: item.variants.map((v) => v.label), audioSeparate: !!item.audioSeparate || !!(item.variants[0] && item.variants[0].audioSeparate), live: item.live, rec, tabId };
    };
    // Play a finished file in Chromium: picture and sound must decode.
    const play = async (savePath) => {
      const key = '/files/' + path.basename(savePath).replace(/[^a-z0-9.]+/gi, '_');
      files[key] = savePath;
      const tabId = browser.createTab({ url: base + '/play/' + key.slice(7) });
      const tab = browser.tabs.get(tabId);
      await sleep(2500);
      const r = await tab.wc.executeJavaScript(`(() => { const v = document.getElementById('v'); return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, time: v.currentTime, error: v.error && v.error.code, videoBytes: v.webkitVideoDecodedByteCount, audioBytes: v.webkitAudioDecodedByteCount }; })()`);
      browser.closeTab(tabId);
      return r;
    };

    // 1. DASH
    const d = await grab('/dash.html', 'dash');
    step('dash detected', { detected: d.detected, variants: d.variants });
    const dRec = d.rec && await until(() => { const r = downloads.get(d.rec.id); return r && ['done', 'error'].includes(r.state) && r; }, 30000);
    result.dash = { detected: d.detected, variants: d.variants, audioSeparate: d.audioSeparate, state: dRec && dRec.state, error: dRec && dRec.error, name: dRec && dRec.name };
    if (dRec && dRec.state === 'done') result.dash.playback = await play(dRec.savePath);
    step('dash', result.dash);

    // 2. HLS with separate audio
    const h = await grab('/hls.html', 'hls');
    const hRec = h.rec && await until(() => { const r = downloads.get(h.rec.id); return r && ['done', 'error'].includes(r.state) && r; }, 30000);
    result.hlsSeparateAudio = { detected: h.detected, audioSeparate: h.audioSeparate, state: hRec && hRec.state, error: hRec && hRec.error };
    if (hRec && hRec.state === 'done') result.hlsSeparateAudio.playback = await play(hRec.savePath);
    step('hls', result.hlsSeparateAudio);

    // 3. Live recording
    const l = await grab('/live.html', 'hls');
    const recording = l.rec && await until(() => { const r = downloads.list().find((x) => x.id === l.rec.id); return r && r.recording && r; }, 8000);
    await sleep(3000);
    const mid = downloads.list().find((x) => l.rec && x.id === l.rec.id);
    if (l.rec) ipc['downloads.stopRecording']({ id: l.rec.id });
    const lRec = l.rec && await until(() => { const r = downloads.get(l.rec.id); return r && ['done', 'error'].includes(r.state) && r; }, 15000);
    result.live = {
      detected: l.detected, liveFlag: l.live, wasRecording: !!recording, recordedSeconds: mid && mid.recordedSeconds,
      state: lRec && lRec.state, bytes: lRec && lRec.state === 'done' ? fs.statSync(lRec.savePath).size : 0,
    };
    step('live', result.live);

    // 4. FFmpeg not installed
    result.ffmpeg = await ipc['ffmpeg.status']();
    result.convertWithoutFfmpeg = dRec ? ipc['downloads.convert']({ id: dRec.id, action: 'audio' }) : null;
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
