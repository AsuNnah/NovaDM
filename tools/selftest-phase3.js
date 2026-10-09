'use strict';
// In-app self-test for the 0.4.0 features, against a local server only:
//  queue schedule (start, pause at the end of the window, continue next time), per-queue limit,
//  Mark of the Web, Defender result handling (scanner replaced by a fake), "when all downloads
//  finish" countdown (dry run: nothing really sleeps or shuts down) and cancel, closing the window
//  to the tray while downloading, keep-awake, and a second start handing over to the first.
// Run with a throwaway NOVADM_USERDATA. Start-with-Windows is never changed by test runs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { powerSaveBlocker } = require('electron');
const { readMarkOfTheWeb } = require('../src/main/download/postprocess');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-phase3.json');
const LOG = OUT + '.log';
const step = (m, x) => { try { fs.appendFileSync(LOG, `${new Date().toISOString().slice(11, 23)} ${m}${x ? ' ' + JSON.stringify(x) : ''}\n`); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

function startServer(files) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const body = files[u.pathname];
      if (!body) { res.writeHead(404); return res.end(); }
      const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const s = m ? Number(m[1]) : 0; const e = m && m[2] ? Number(m[2]) : body.length - 1;
      res.writeHead(m ? 206 : 200, { 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${s}-${e}/${body.length}` } : {}) });
      let off = s;
      const slow = u.pathname.startsWith('/slow/');
      const tick = () => { if (res.destroyed) return; if (off > e) return res.end(); const n = Math.min(16384, e - off + 1); res.write(body.subarray(off, off + n)); off += n; setTimeout(tick, slow ? 25 : 1); };
      tick();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

module.exports = async ({ app, downloads, settings, scheduler, background, overlayView, ipc, getWindow }) => {
  const result = {};
  try { fs.rmSync(LOG, { force: true }); } catch {}
  const dry = path.join(os.tmpdir(), 'novadm-power-dryrun.txt');
  try { fs.rmSync(dry, { force: true }); } catch {}
  process.env.NOVADM_DRYRUN_POWER = dry;
  process.env.NOVADM_AFTERDONE_SECONDS = '2';
  const overlayText = () => overlayView.webContents.executeJavaScript('document.getElementById("content").innerText');
  try {
    const files = {};
    for (const n of ['a', 'b', 'c', 'd']) files[`/slow/${n}.bin`] = crypto.randomBytes(400 * 1024);
    files['/files/tool.zip'] = crypto.randomBytes(64 * 1024);
    files['/files/setup.exe'] = crypto.randomBytes(64 * 1024);
    files['/files/one.bin'] = crypto.randomBytes(32 * 1024);
    files['/files/two.bin'] = crypto.randomBytes(32 * 1024);
    const { server, base } = await startServer(files);
    const dlDir = path.join(app.getPath('userData'), 'dl-phase3');
    fs.rmSync(dlDir, { recursive: true, force: true });
    settings.set({ downloadDir: dlDir, categoryFolders: false, skipEditor: true, notifyOnComplete: false, connections: 2, maxActive: 5, scanDownloads: 'programs' });
    const byName = (n) => downloads.list().find((d) => d.name === n);

    // 1. Schedule: 01:00-05:00. Before the window the download waits; inside it runs; at the end it
    //    pauses ("scheduled"); the next window continues it.
    let clock = new Date(2026, 9, 9, 0, 30);
    scheduler.now = () => clock;
    ipc['downloads.saveQueues']({ queues: [{ id: 'main', name: 'Main' }, { id: 'night', name: 'Night', schedule: { enabled: true, start: '01:00', stop: '05:00', days: [] } }] });
    downloads.add({ kind: 'http', url: base + '/slow/a.bin', name: 'night.bin', queue: 'night' });
    result.beforeWindow = byName('night.bin').state;
    clock = new Date(2026, 9, 9, 1, 0); scheduler.tick();
    result.inWindow = (await until(() => byName('night.bin').state === 'downloading' && byName('night.bin').received > 0 && 'downloading', 8000)) || byName('night.bin').state;
    clock = new Date(2026, 9, 9, 5, 0); scheduler.tick();
    await until(() => byName('night.bin').state === 'scheduled', 5000);
    const atStop = byName('night.bin');
    result.afterWindow = { state: atStop.state, received: atStop.received };
    clock = new Date(2026, 9, 10, 1, 0); scheduler.tick();
    const fin = await until(() => byName('night.bin').state === 'done' && byName('night.bin'), 30000);
    result.nextWindow = { state: fin && fin.state, sameBytes: !!fin && fs.readFileSync(fin.savePath).equals(files['/slow/a.bin']) };
    step('schedule', result);

    // 2. A queue that runs one download at a time.
    ipc['downloads.saveQueues']({ queues: [{ id: 'main', name: 'Main' }, { id: 'single', name: 'One by one', maxActive: 1 }] });
    let peak = 0;
    for (const n of ['b', 'c', 'd']) downloads.add({ kind: 'http', url: base + `/slow/${n}.bin`, name: `q-${n}.bin`, queue: 'single' });
    await until(() => { peak = Math.max(peak, downloads.queueActive('single')); return ['q-b.bin', 'q-c.bin', 'q-d.bin'].every((n) => byName(n).state === 'done'); }, 60000);
    result.queueLimit = { peak, allDone: ['q-b.bin', 'q-c.bin', 'q-d.bin'].every((n) => byName(n).state === 'done') };
    step('queue limit', result.queueLimit);

    // 3. Mark of the Web + scan result (scanner replaced: the real one may be blocked where tests run).
    const realScan = downloads.scanFile;
    downloads.scanFile = async () => ({ result: 'threat', detail: 'Test:NovaDM/Fake' });
    let threatEvent = null;
    downloads.once('threat', (r) => { threatEvent = r.name; });
    downloads.add({ kind: 'http', url: base + '/files/setup.exe', name: 'setup.exe', pageUrl: base + '/download-page' });
    const exe = await until(() => byName('setup.exe').state === 'done' && byName('setup.exe').scan === 'threat' && byName('setup.exe'), 15000);
    result.motw = exe ? readMarkOfTheWeb(exe.savePath).replace(/\r/g, '').split('\n').filter(Boolean) : null;
    result.threat = { scan: exe && exe.scan, event: threatEvent };
    downloads.scanFile = async () => ({ result: 'clean', detail: '' });
    downloads.add({ kind: 'http', url: base + '/files/tool.zip', name: 'tool.zip' });
    result.cleanScan = ((await until(() => byName('tool.zip').scan === 'clean' && byName('tool.zip'), 15000)) || {}).scan;
    downloads.scanFile = realScan;
    const real = await realScan(path.join(dlDir, 'tool.zip'));
    result.realDefender = real.result; // 'clean' normally; 'error' if the scanner can't run here
    step('safety', result);

    // 4. When all downloads finish: shut down (dry run) after the countdown; and a cancelled one.
    await sleep(2500); // let earlier "all done" settle
    settings.set({ afterAllDone: 'shutdown' });
    downloads.add({ kind: 'http', url: base + '/files/one.bin', name: 'one.bin' });
    const shown = await until(async () => /shut down/.test(await overlayText()) && 'shown', 10000);
    await sleep(3000);
    result.afterDone = { dialog: !!shown, action: fs.existsSync(dry) ? fs.readFileSync(dry, 'utf8').trim() : '', resetTo: settings.get('afterAllDone') };
    try { fs.rmSync(dry, { force: true }); } catch {}
    settings.set({ afterAllDone: 'sleep' });
    downloads.add({ kind: 'http', url: base + '/files/two.bin', name: 'two.bin' });
    await until(async () => /sleep/.test(await overlayText()), 10000);
    ipc['afterdone.cancel']();
    await sleep(3000);
    result.afterDoneCancelled = { ran: fs.existsSync(dry), setting: settings.get('afterAllDone') };
    step('after done', { a: result.afterDone, c: result.afterDoneCancelled });

    // 5. Closing the window while downloading keeps NovaDM in the tray; the PC stays awake.
    settings.set({ closeToTray: 'downloading', preventSleep: true, speedLimitKBps: 100 });
    downloads.add({ kind: 'http', url: base + '/slow/a.bin?x=2', name: 'tray.bin' });
    await until(() => byName('tray.bin').state === 'downloading', 5000);
    await sleep(500);
    result.keepAwake = background.blocker != null && powerSaveBlocker.isStarted(background.blocker);
    const win = getWindow();
    win.close();
    await sleep(500);
    result.tray = { windowAlive: !!getWindow() && !getWindow().isDestroyed(), visible: getWindow() ? getWindow().isVisible() : null, trayIcon: !!background.tray };

    // 6. Starting NovaDM again (same profile) hands over to this one and exits.
    const env = { ...process.env };
    delete env.NOVADM_SELFTEST;
    const child = spawn(process.execPath, [app.getAppPath()], { env, stdio: 'ignore' });
    const code = await new Promise((r) => { const t = setTimeout(() => { try { child.kill(); } catch {} r('still running'); }, 15000); child.on('exit', (c) => { clearTimeout(t); r(c); }); });
    await sleep(500);
    result.secondInstance = { exitCode: code, broughtBack: getWindow() ? getWindow().isVisible() : false };
    settings.set({ speedLimitKBps: 0 });
    downloads.pauseAll();
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
