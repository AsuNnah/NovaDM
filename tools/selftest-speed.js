'use strict';
// In-app self-test for 1.1 (speed and Shields rules), against local servers only:
//  skip tracking redirects, tracking parameters removed, de-AMP (address and page), HTTPS upgrade
//  (with fallback for a site without HTTPS, through a local proxy), unloading a tab and getting it
//  back (back list and scroll position), reader view (scripts and event handlers removed), and
//  the page media scan still working.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const netMod = require('net');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-speed.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(100); } return null; };
const settle = async (tab) => { await sleep(150); await until(() => tab.wc && !tab.wc.isLoading()); await sleep(200); };

module.exports = async ({ app, browser, media, ipc, settings }) => {
  const result = {};
  const save = (step) => { result.step = step; fs.writeFileSync(OUT, JSON.stringify(result, null, 2)); };
  try {
    const hits = [];
    const para = '<p>' + 'This is a long article paragraph with enough words to count as reading material for reader view. '.repeat(4) + '</p>';
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const u = req.url.split('?')[0];
      if (u === '/amp') return res.end(`<!doctype html><html amp><head><title>AMP</title><link rel="canonical" href="http://127.0.0.1:${server.address().port}/real"></head><body>amp copy</body></html>`);
      if (u === '/long') return res.end('<title>Long</title>' + '<div style="height:5000px">tall</div>');
      if (u === '/article') return res.end(`<title>A story</title><article><h1>A story</h1>${para.repeat(8)}<p>Picture: <img src="x.png" onerror="window.bad=1"> <a href="javascript:void(window.bad=2)">bad link</a> <a href="http://example.org/more">more</a></p><script>window.ran=1</script></article>`);
      if (u === '/media') return res.end('<title>Media</title><a href="/files/clip.mp4">clip</a>');
      res.end(`<title>${u}</title><p>${u}</p>`);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tab = browser.activeTab();
    const go = async (url) => { browser.navigate(tab.id, url); await settle(tab); return tab.wc.getURL(); };

    // 1. Tracking redirect skipped (the tracker is never contacted: the redirect happens first).
    result.debounce = (await go(`http://www.google.com/url?q=${encodeURIComponent(base + '/target')}&sa=D`)).replace(base, '');
    save(1);
    // 2. Click identifiers removed.
    hits.length = 0;
    result.stripped = (await go(`${base}/page?a=1&fbclid=abc123&gclid=xyz`)).replace(base, '');
    result.serverSaw = hits.filter((h) => h.startsWith('/page'));
    save(2);
    // 3. de-AMP: an AMP cache address, and an AMP page naming its real page.
    result.deAmpUrl = (await go(`https://example-org.cdn.ampproject.org/c/127.0.0.1:${server.address().port}/story`)).replace(base, '');
    await go(base + '/start');
    await go(base + '/amp');
    await until(() => /\/real$/.test(tab.wc.getURL()), 5000);
    await settle(tab);
    result.deAmpPage = tab.wc.getURL().replace(base, '');
    result.backListAfterAmp = tab.wc.navigationHistory.getAllEntries().map((e) => e.url.replace(base, '')).slice(-2);

    save(3);
    // 4. HTTPS upgrade through a local proxy: "plain.example" has no HTTPS (falls back to http),
    //    "secure.example" has (stays on https).
    const tlsDir = process.env.NOVADM_TLS_DIR || '';
    if (tlsDir && fs.existsSync(path.join(tlsDir, 'key.pem'))) {
      const tls = https.createServer({ key: fs.readFileSync(path.join(tlsDir, 'key.pem')), cert: fs.readFileSync(path.join(tlsDir, 'cert.pem')) }, (req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>secure</title>secure'); });
      await new Promise((r) => tls.listen(0, '127.0.0.1', r));
      const proxy = http.createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end('<title>plain</title>plain http'); });
      proxy.on('connect', (req, sock) => {
        if (!/^secure\.example:/.test(req.url)) { sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
        const up = netMod.connect(tls.address().port, '127.0.0.1', () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
        up.on('error', () => sock.destroy());
      });
      await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
      await browser.normalSession.setProxy({ proxyRules: `127.0.0.1:${proxy.address().port}`, proxyBypassRules: '127.0.0.1' });
      browser.normalSession.setCertificateVerifyProc((_r, cb) => cb(0)); // test certificate
      const plain = await go('http://plain.example/');
      await until(() => /^http:\/\/plain/.test(tab.wc.getURL()), 8000);
      result.httpsUpgrade = { noHttpsSite: tab.wc.getURL(), plainStart: plain, httpsSite: await go('http://secure.example/'), localStaysHttp: (await go(base + '/local')).startsWith('http://') };
      browser.normalSession.setCertificateVerifyProc(null);
      await browser.normalSession.setProxy({ mode: 'system' });
      proxy.close(); tls.close();
    } else result.httpsUpgrade = 'skipped: set NOVADM_TLS_DIR';

    save(4);
    // 5. Unload a tab and get it back where it was.
    const t2 = browser.tabs.get(browser.createTab({ url: base + '/first' }));
    await settle(t2);
    browser.navigate(t2.id, base + '/long');
    await settle(t2);
    await t2.wc.executeJavaScript('window.scrollTo(0, 2000)');
    await sleep(1200); // page state (scroll) is saved on an interval
    browser.selectTab(tab.id);
    const unloaded = browser.discardIdle(0);
    result.unload = { unloaded: unloaded.includes(t2.id), noPage: t2.wc === null, listed: browser.order.includes(t2.id) };
    browser.selectTab(t2.id);
    await settle(t2);
    await sleep(500);
    result.unload.back = { url: t2.wc.getURL().replace(base, ''), scrollY: await t2.wc.executeJavaScript('window.scrollY'), canGoBack: t2.wc.navigationHistory.canGoBack() };

    save(5);
    // 6. Reader view (in the first tab again).
    browser.selectTab(tab.id);
    await go(base + '/article');
    result.readable = await until(() => tab.readable, 5000);
    const r = await ipc['reader.open']();
    await settle(tab);
    await sleep(500);
    const srcdoc = await tab.wc.executeJavaScript("document.getElementById('doc').getAttribute('srcdoc') || ''");
    result.reader = {
      ok: r.ok, page: tab.url, hasText: srcdoc.includes('long article paragraph'),
      scripts: /<script/i.test(srcdoc.replace(/<meta[^>]*>/g, '')), onerror: /onerror/i.test(srcdoc), jsLink: /javascript:/i.test(srcdoc),
      keptLink: srcdoc.includes('http://example.org/more'),
      sandbox: await tab.wc.executeJavaScript("document.getElementById('doc').getAttribute('sandbox')"),
    };
    await ipc['reader.original']({ id: '1' });
    await settle(tab);
    result.reader.backToOriginal = tab.wc.getURL().replace(base, '');

    save(6);
    // 7. Media links are still found on pages.
    await go(base + '/media');
    result.mediaScan = !!(await until(() => media.list(tab.id).items.some((i) => /clip\.mp4/.test(i.url)), 8000));
    result.shieldsStats = browser.shields.stats;
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
