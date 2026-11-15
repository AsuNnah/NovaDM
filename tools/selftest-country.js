'use strict';
// In-app self-test for 1.8.1 Hide your country: with a country profile on, a tab goes through the profile's proxy
// and gets its time zone and language (REQ-313), location requests are refused, and when the proxy stops nothing goes
// direct (SEC-111). A local HTTP proxy answers for a made-up host, so no real network is used.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-country.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(150); } return null; };

module.exports = async ({ app, browser, settings }) => {
  const result = { seen: [] };
  const proxy = http.createServer((req, res) => {
    result.seen.push({ url: req.url, lang: req.headers['accept-language'] || '' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>via proxy</title><p>ok</p>');
  });
  try {
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const port = proxy.address().port;
    settings.set({ httpsUpgrade: false }); // the made-up site is http only
    const realTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tz = realTz === 'Pacific/Auckland' ? 'Asia/Tokyo' : 'Pacific/Auckland';
    settings.set({ proxyProfiles: [{ id: 'st', name: 'Selftest exit', country: 'DE', type: 'http', server: `127.0.0.1:${port}`, timeZone: tz, lang: 'de-DE' }], proxyProfile: 'st' });
    await sleep(800); // the proxy is applied asynchronously

    const id = browser.createTab({ url: 'http://country-selftest.test/page' });
    const wc = browser.tabs.get(id).wc;
    await until(() => !wc.isLoading() && /via proxy/.test(wc.getTitle()), 10000);
    result.page = await wc.executeJavaScript(`new Promise((r) => {
      const out = { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: navigator.language, langs: navigator.languages.join(','), locale: Intl.NumberFormat().resolvedOptions().locale };
      navigator.geolocation.getCurrentPosition(() => r({ ...out, geo: 'given' }), (e) => r({ ...out, geo: 'refused ' + e.code }), { timeout: 3000 });
    })`);

    // The proxy stops: the page fails, and nothing reaches the made-up host any other way.
    await new Promise((r) => proxy.close(r));
    const before = result.seen.length;
    wc.loadURL('http://country-selftest.test/second').catch(() => {});
    result.failedTo = await until(() => /error\.html/.test(wc.getURL()) ? wc.getURL() : null, 10000);
    result.errorText = result.failedTo ? await wc.executeJavaScript('document.body.innerText').catch(() => '') : '';

    // Back to your connection: the time zone is the machine's again.
    settings.set({ proxyProfile: '' });
    await sleep(500);
    result.tzAfter = await wc.executeJavaScript('Intl.DateTimeFormat().resolvedOptions().timeZone');

    const p = result.page || {};
    result.checks = {
      wentThroughProxy: result.seen.some((s) => s.url === 'http://country-selftest.test/page'),
      acceptLanguage: result.seen.length > 0 && /^de-DE,de;q=0\.9/.test(result.seen[0].lang),
      timeZone: p.tz === tz,
      language: p.lang === 'de-DE' && /^de-DE/.test(p.langs) && /^de/.test(p.locale),
      locationRefused: /^refused 1$/.test(p.geo || ''),
      failsClosed: !!result.failedTo && result.seen.length === before,
      saysProxyDown: /proxy for "Selftest exit" isn't answering/i.test(result.errorText),
      backToRealTimeZone: result.tzAfter === realTz,
    };
    result.ok = Object.values(result.checks).every(Boolean);
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  try { proxy.close(); } catch {}
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
