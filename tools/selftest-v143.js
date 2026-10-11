'use strict';
// In-app self-test for 1.4.3: Settings → About (opened the way the menu opens it) shows the running
// version, the build and an update status, scrolls into view, and "Check for updates" answers.
// yt-dlp is asked by itself on YouTube video pages, once per video, only when on and installed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-v143.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

module.exports = async ({ app, browser, ipc, ytdlp, settings }) => {
  const result = {};
  try {
    const id = browser.createTab({ url: 'novadm://settings?section=about' });
    const tab = browser.tabs.get(id);
    const read = () => tab.wc.executeJavaScript(`(() => {
      const t = (i) => (document.getElementById(i) || {}).textContent || '';
      const r = document.getElementById('about').getBoundingClientRect();
      return { version: t('aboutVersion'), build: t('aboutBuild'), update: t('aboutUpdate'), inView: r.top >= 0 && r.top < innerHeight };
    })()`).catch(() => null);
    await until(async () => { const r = await read(); return r && r.build; });
    await sleep(800); // the page scrolls to the section after 300 ms
    result.before = await read();
    result.versionOk = result.before.version === `NovaDM ${app.getVersion()}`;
    result.buildOk = /Electron \d/.test(result.before.build) && /Chromium \d/.test(result.before.build);
    await tab.wc.executeJavaScript(`document.getElementById('aboutCheck').click()`);
    result.after = await until(async () => { const r = await read(); return r && r.update !== 'Checking…' && r.update !== result.before.update ? r : null; }, 20000);
    result.checkAnswered = !!result.after;
    // yt-dlp on YouTube by itself (stand-in yt-dlp; the tab's address is set, never loaded).
    let runs = 0;
    const saved = { runner: ytdlp.runner, auto: settings.get('ytdlpAuto') };
    ytdlp.runner = async (args) => { runs++; await sleep(300); return JSON.stringify({ title: 'Clip', duration: 60, webpage_url: args[args.length - 1], formats: [{ format_id: '18', protocol: 'https', url: 'https://127.0.0.1:9/v.mp4', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a' }] }); };
    const t = browser.activeTab();
    const realUrl = t.url;
    const auto = () => ipc['media.ytdlpAuto']();
    t.url = 'https://example.com/watch?v=x';
    result.ytOtherSite = auto(); // null: not YouTube
    t.url = 'https://www.youtube.com/watch?v=selftest1';
    result.ytFirst = auto(); // null while yt-dlp looks
    const found = await until(() => { const r = auto(); return r && r.ok ? r : null; }, 5000);
    result.ytFound = found && found.choices.length > 0;
    auto(); auto();
    result.ytRuns = runs; // asked once per video
    settings.set({ ytdlpAuto: false });
    t.url = 'https://www.youtube.com/watch?v=selftest2';
    result.ytOff = auto(); // null: switched off
    settings.set({ ytdlpAuto: true });
    const exe = ytdlp.exe;
    ytdlp.runner = null; ytdlp.exe = () => '';
    result.ytNotInstalled = auto(); // null: yt-dlp not installed
    ytdlp.exe = exe; ytdlp.runner = saved.runner; t.url = realUrl; settings.set({ ytdlpAuto: saved.auto });
    result.ytOk = result.ytOtherSite === null && result.ytFirst === null && result.ytFound && runs === 1 && result.ytOff === null && result.ytNotInstalled === null;
    result.ok = result.versionOk && result.buildOk && result.before.inView && result.checkAnswered && result.ytOk;
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
