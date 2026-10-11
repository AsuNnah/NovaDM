'use strict';
// In-app self-test for 1.4.4: a finished HLS video download (TS converted to MP4)
// - without FFmpeg: stays a fragmented MP4 whose header gives the real length (not 13:15:21);
// - with FFmpeg (NOVADM_TEST_FFMPEG=<ffmpeg.exe>): becomes a normal MP4 with its index first, the
//   Downloads list shows "optimizing" meanwhile, and the record's size is the new file's.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-v144.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SEG = fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'mux.js', 'test', 'segments', 'test-segment.ts'));
const N = 4;

function header(file) {
  const { readBoxes, child } = require('../src/main/media/mp4');
  const buf = fs.readFileSync(file);
  const top = readBoxes(buf);
  const moov = top.find((b) => b.type === 'moov');
  const mvhd = child(buf, moov, 'mvhd');
  const v1 = buf[mvhd.start + mvhd.header] === 1;
  const scale = buf.readUInt32BE(mvhd.start + mvhd.header + (v1 ? 20 : 12));
  const dur = v1 ? Number(buf.readBigUInt64BE(mvhd.start + mvhd.header + 24)) : buf.readUInt32BE(mvhd.start + mvhd.header + 16);
  const types = top.map((b) => b.type);
  return { seconds: Math.round((dur / scale) * 10) / 10, fragmented: types.includes('moof'), indexFirst: types.indexOf('moov') < types.indexOf('mdat'), size: buf.length };
}

module.exports = async ({ app, downloads, settings }) => {
  const result = {};
  try {
    const server = http.createServer((req, res) => {
      if (req.url === '/v.m3u8') {
        let pl = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n';
        for (let i = 0; i < N; i++) pl += `#EXTINF:10,\ns${i}.ts\n`;
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        return res.end(pl + '#EXT-X-ENDLIST\n');
      }
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': SEG.length });
      res.end(SEG);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = path.join(app.getPath('userData'), 'dl144');
    fs.rmSync(dir, { recursive: true, force: true });
    settings.set({ downloadDir: dir, categoryFolders: false, scanDownloads: 'off', markOfTheWeb: false, skipEditor: true });

    const run = async (name) => {
      const completed = new Promise((r) => { const on = (rec) => { if (rec.name === name) { downloads.off('completed', on); r(rec); } }; downloads.on('completed', on); });
      const rec = downloads.add({ kind: 'hls', name, playlistUrl: base + '/v.m3u8', category: 'video', meta: { duration: N * 10 } });
      let sawOptimizing = false;
      const watch = setInterval(() => { const s = downloads.list().find((d) => d.id === rec.id); if (s && s.optimizing) sawOptimizing = true; }, 20);
      const done = await Promise.race([completed, sleep(60000).then(() => null)]);
      clearInterval(watch);
      const r = downloads.get(rec.id);
      return { finished: !!done, sawOptimizing, recordSize: r.size, ...header(r.savePath), leftover: fs.existsSync(r.savePath + '.faststart.part') };
    };

    settings.set({ ffmpegPath: '' });
    result.withoutFfmpeg = await run('plain.mp4');
    if (process.env.NOVADM_TEST_FFMPEG) {
      settings.set({ ffmpegPath: process.env.NOVADM_TEST_FFMPEG });
      result.withFfmpeg = await run('fast.mp4');
    }
    server.close();

    const a = result.withoutFfmpeg;
    const b = result.withFfmpeg;
    result.checks = {
      withoutFfmpeg: a.finished && a.fragmented && a.seconds === N * 10 && !a.sawOptimizing,
      withFfmpeg: !b ? 'not run (set NOVADM_TEST_FFMPEG)' : b.finished && !b.fragmented && b.indexFirst && Math.abs(b.seconds - N * 10) < 2 && b.sawOptimizing && b.recordSize === b.size && !b.leftover,
    };
    result.ok = Object.values(result.checks).every((v) => v === true || typeof v === 'string');
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
