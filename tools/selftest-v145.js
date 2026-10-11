'use strict';
// In-app self-test for 1.4.5, offline (GitHub answers are stand-ins):
// - the menu has an icon on every item, dividers between groups, shortcuts, and nothing wraps;
// - a new NovaDM version shows "What's new" on the menu's update notice and its notes in Settings → About;
// - "Check for updates" lists the add-ons and Electron, with Update / "Update anyway" and the warnings.
// Screenshots: %TEMP%\novadm-v145-menu.png, novadm-v145-about.png.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-v145.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };

const NOTES = '### Added\n- **Something new** for the test.\n\nThe files are not code-signed yet.\n\n| File | SHA-256 |\n|---|---|\n| x | `y` |';
async function github(url, opts = {}) {
  // 1.5.3: known security problems. The installed yt-dlp "has" one, the newest none.
  if (url.startsWith('https://api.osv.dev/')) {
    const q = JSON.parse(opts.body);
    return JSON.stringify({ vulns: q.package.name === 'yt-dlp' && q.version === '2026.8.19' ? [{ id: 'GHSA-test', aliases: ['CVE-2026-99999'], database_specific: { severity: 'HIGH' } }] : [] });
  }
  if (url.startsWith('https://services.nvd.nist.gov/')) return JSON.stringify({ vulnerabilities: [] });
  if (url.includes('/AsuNnah/NovaDM/releases/latest')) return JSON.stringify({ tag_name: 'v9.9.9', html_url: 'https://github.com/AsuNnah/NovaDM/releases/tag/v9.9.9' });
  if (url.includes('/AsuNnah/NovaDM/releases?')) return JSON.stringify([{ tag_name: 'v9.9.9', body: NOTES }, { tag_name: 'v1.0.0', body: NOTES }]);
  if (url.includes('/yt-dlp/yt-dlp/releases/latest')) return JSON.stringify({ tag_name: '2099.01.01' });
  if (url.includes('/aria2/aria2/releases/latest')) return JSON.stringify({ tag_name: 'release-1.37.0' });
  if (url.includes('/electron/electron/releases')) return JSON.stringify([{ tag_name: 'v99.0.0' }]);
  if (url.endsWith('checksums.sha256')) return ['9.1', '10.0'].map((v) => `${'a'.repeat(64)}  ffmpeg-n${v}-latest-win64-lgpl-shared-${v}.zip`).join('\n');
  throw new Error('offline test: ' + url);
}

module.exports = async ({ app, browser, ipc, overlayView, ytdlp, ffmpeg }) => {
  const result = {};
  const updates = require(path.join(__dirname, '..', 'src', 'main', 'updates'));
  try {
    updates.fetchOverride = github;
    ytdlp.status = async () => ({ installed: true, version: '2026.08.19' });
    ffmpeg.status = async () => ({ installed: true, version: 'n9.1.0-5-gabc' });

    // Menu: icons, dividers, shortcuts, one line per item.
    const panel = overlayView.webContents;
    ipc['panel.open']({ name: 'menu' });
    await until(() => panel.executeJavaScript("document.querySelectorAll('#content .menuitem').length > 5"));
    result.menu = await panel.executeJavaScript(`(() => {
      const items = [...document.querySelectorAll('#content .menuitem')];
      return {
        items: items.length,
        withIcon: items.filter((m) => m.querySelector('svg.mi-ic path, svg.mi-ic circle, svg.mi-ic rect')).length,
        dividers: document.querySelectorAll('#content .msep').length,
        shortcuts: items.map((m) => (m.querySelector('.mk') || {}).textContent).filter(Boolean),
        oneLine: items.every((m) => m.getBoundingClientRect().height < 40),
        // The menu itself (without add-on notices, which scroll) fits a 720p window.
        menuHeight: Math.round(items[items.length - 1].getBoundingClientRect().bottom - items[0].getBoundingClientRect().top),
      };
    })()`);
    await sleep(300);
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-v145-menu.png'), (await panel.capturePage()).toPNG());

    // A new NovaDM: the update notice gets "What's new"; Settings → About shows the notes and the add-ons.
    await ipc['update.check']();
    await sleep(500);
    ipc['panel.open']({ name: 'menu' });
    await sleep(500);
    result.noticeHasWhatsNew = await panel.executeJavaScript("[...document.querySelectorAll('#content .addon-warn.upd button')].some((b) => /What’s new/.test(b.textContent))");
    ipc['panel.close'] && ipc['panel.close']();

    const id = browser.createTab({ url: 'novadm://settings?section=about' });
    const tab = browser.tabs.get(id);
    await until(() => tab.wc.executeJavaScript("!!document.getElementById('aboutBuild') && document.getElementById('aboutBuild').textContent.length > 0").catch(() => false));
    await tab.wc.executeJavaScript("document.getElementById('aboutCheck').click()");
    await until(() => tab.wc.executeJavaScript("document.querySelectorAll('#aboutAddons .row').length === 4"), 10000);
    await sleep(300);
    result.about = await tab.wc.executeJavaScript(`(() => {
      const t = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim());
      return {
        update: document.getElementById('aboutUpdate').textContent,
        notesShown: !document.getElementById('aboutNotesRow').hidden,
        notesHeads: t('#aboutNotes h3'),
        notesItems: t('#aboutNotes li'),
        addons: [...document.querySelectorAll('#aboutAddons .row')].map((r) => ({ name: r.querySelector('b').textContent, info: r.querySelector('span').textContent, status: (r.querySelector('.status') || {}).textContent || '', security: [...r.querySelectorAll('.status')].map((x) => x.textContent).filter((x) => /security problems/.test(x)).join(' ').replace(/^⚠ /, ''), button: (r.querySelector('button') || {}).textContent || '' })),
      };
    })()`);
    await tab.wc.executeJavaScript("document.getElementById('about').scrollIntoView()");
    await sleep(300);
    fs.writeFileSync(path.join(os.tmpdir(), 'novadm-v145-about.png'), (await tab.wc.capturePage()).toPNG());

    const a = Object.fromEntries(result.about.addons.map((x) => [x.name, x]));
    result.checks = {
      menu: result.menu.items === 14 && result.menu.withIcon === 14 && result.menu.dividers === 4 && result.menu.shortcuts.includes('Ctrl+J') && result.menu.oneLine && result.menu.menuHeight < 560,
      notice: result.noticeHasWhatsNew,
      notes: result.about.notesShown && result.about.notesHeads.length === 1 && /9\.9\.9/.test(result.about.notesHeads[0]) && result.about.notesItems[0] === 'Something new for the test.',
      ytdlp: a['yt-dlp'] && a['yt-dlp'].button === 'Update',
      security: a['yt-dlp'] && a['yt-dlp'].security === 'Known security problems in 2026.08.19 (OSV.dev): CVE-2026-99999 (high). 2099.01.01 has none: update.'
        && a.aria2 && a.aria2.security === '' && /No known security problems \(NVD\)/.test(a.FFmpeg.security || ''),
      ffmpeg: a.FFmpeg && a.FFmpeg.button === 'Update anyway' && /tested with FFmpeg 9/.test(a.FFmpeg.status),
      aria2: a.aria2 && !a.aria2.button,
      electron: a['Electron (built into NovaDM)'] && /no longer gets security fixes/.test(a['Electron (built into NovaDM)'].status) && !a['Electron (built into NovaDM)'].button,
    };
    result.ok = Object.values(result.checks).every(Boolean);
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  } finally {
    updates.fetchOverride = null;
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
