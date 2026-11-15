'use strict';
// In-app self-test for the 1.8.1 country-profile screens (REQ-312, REQ-314): a profile added in Settings is saved (its
// password encrypted, never shown back); the Guard panel switches to it and the toolbar chip names it; "Check what sites
// see" shows a result. Screenshots: %TEMP%\novadm-countryui-*.png
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { BaseWindow } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-countryui.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };
const shot = async (wc, name) => { try { fs.writeFileSync(path.join(os.tmpdir(), `novadm-countryui-${name}.png`), (await wc.capturePage()).toPNG()); } catch {} };

module.exports = async ({ app, browser, settings, chromeView }) => {
  const result = {};
  const c = {};
  // A local proxy that refuses HTTPS tunnels, so the check has a definite answer without the real network.
  const proxy = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  proxy.on('connect', (_req, sock) => sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  try {
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const id = browser.createTab({ url: 'novadm://settings?section=network' });
    const wc = browser.tabs.get(id).wc;
    await until(() => wc.executeJavaScript("!!document.getElementById('profileAdd') && document.getElementById('pfCountry').options.length > 10").catch(() => false), 10000);

    // 1. Add a profile: choosing the country fills the time zone and language.
    await wc.executeJavaScript(`(() => {
      document.getElementById('profileAdd').click();
      document.getElementById('pfName').value = 'Test exit';
      const c = document.getElementById('pfCountry'); c.value = 'DE'; c.dispatchEvent(new Event('change'));
      document.getElementById('pfType').value = 'http';
      document.getElementById('pfServer').value = '127.0.0.1:${proxy.address().port}';
      document.getElementById('pfUser').value = 'tester';
      document.getElementById('pfPass').value = 'secret-pass';
    })()`);
    result.filled = await wc.executeJavaScript("({ tz: document.getElementById('pfTz').value, lang: document.getElementById('pfLang').value })");
    // India's zone is listed by ICU under its old name only: the editor must still take the table's name.
    result.filledIN = await wc.executeJavaScript("(() => { const c = document.getElementById('pfCountry'); c.value = 'IN'; c.dispatchEvent(new Event('change')); const v = document.getElementById('pfTz').value; c.value = 'DE'; c.dispatchEvent(new Event('change')); return v; })()");
    await wc.executeJavaScript("document.getElementById('profileEdit').scrollIntoView({ block: 'center' })"); await sleep(300);
    await shot(wc, 'edit');
    await wc.executeJavaScript("document.getElementById('pfSave').click()");
    const saved = await until(() => { const p = (settings.get('proxyProfiles') || [])[0]; return p && p.passEnc ? p : null; }, 5000);
    result.saved = saved ? { ...saved, passEnc: saved.passEnc ? '(set)' : '' } : null;
    c.countryFillsTimeZone = result.filled.tz === 'Europe/Berlin' && result.filled.lang === 'de-DE' && result.filledIN === 'Asia/Kolkata';
    c.profileSaved = !!saved && saved.name === 'Test exit' && saved.country === 'DE' && saved.timeZone === 'Europe/Berlin';
    c.passwordEncryptedNotShown = !!saved && !/secret-pass/.test(saved.passEnc) && !(await wc.executeJavaScript('document.body.innerHTML.includes("secret-pass")'));
    c.listedInSettings = /Test exit · DE/.test(await wc.executeJavaScript("document.getElementById('profileList').innerText"));

    // 2. The toolbar chip appears; the Guard panel switches to the profile.
    c.chipAppears = !!(await until(() => chromeView.webContents.executeJavaScript("(() => { const e = document.getElementById('route-pill'); return !e.hidden && e.textContent === 'Your connection'; })()"), 4000));
    const win = BaseWindow.getAllWindows().find((w) => !/Private/.test(w.getTitle()));
    const panel = () => win.contentView.children.map((v) => v.webContents).find((x) => /[\\/]ui[\\/]panel\.html/.test(x.getURL()));
    await chromeView.webContents.executeJavaScript("document.getElementById('shield-pill').click()");
    const p = await until(() => { const x = panel(); return x && x.executeJavaScript("current === 'shields' && !!content.querySelector('.gsel')").then((ok) => (ok ? x : null)).catch(() => null); }, 6000);
    c.panelOffersProfile = !!p && /Test exit · DE/.test(await p.executeJavaScript("content.querySelector('.gsel').innerText"));
    if (p) await p.executeJavaScript("(() => { const s = content.querySelector('.gsel'); s.value = s.options[1].value; s.dispatchEvent(new Event('change')); })()");
    c.switched = !!(await until(() => settings.get('proxyProfile') === saved.id, 3000));
    c.chipNamesProfile = !!(await until(() => chromeView.webContents.executeJavaScript("document.getElementById('route-pill').textContent === 'Test exit · DE'"), 3000));

    // 3. The check, through the profile (whose proxy refuses HTTPS here): a clear "no answer" line, the rest shown.
    if (p) {
      await until(() => p.executeJavaScript("!!content.querySelector('.rsub') && /Europe\\/Berlin/.test(content.querySelector('.rsub').textContent)"), 3000);
      await p.executeJavaScript("[...content.querySelectorAll('button.link')].find((b) => /Check what sites see/.test(b.textContent)).click()");
      result.check = await until(() => p.executeJavaScript("content.querySelector('.rcheck') ? content.querySelector('.rcheck').innerText : ''"), 15000);
      await shot(p, 'check');
    }
    c.checkShown = /No answer through "Test exit"/.test(result.check || '') && /Europe\/Berlin/.test(result.check || '') && /refused/.test(result.check || '');
    result.checks = c;
    result.ok = Object.values(c).every(Boolean);
  } catch (e) {
    result.fatal = String(e && e.stack || e);
    result.checks = c;
  }
  try { proxy.close(); } catch {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
