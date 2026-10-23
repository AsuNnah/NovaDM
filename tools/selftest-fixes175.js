'use strict';
// In-app self-test for 1.7.5: (a) the direct download transport does not send Authorization / API-key headers to
// another host after a redirect (issue 32); (b) the automatic media analysis refuses private addresses named by a
// page on the internet, also through a redirect, and still works for a local page (issue 33).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-fixes175.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(60); } return null; };

module.exports = async ({ app, browser, media, settings }) => {
  const result = {};
  try {
    const seen = []; // [host, path, headers]
    let playlistHits = 0;
    const server = http.createServer((req, res) => {
      const host = String(req.headers.host).split(':')[0];
      seen.push([host, req.url, req.headers]);
      const port = server.address().port;
      if (req.url === '/hop') { res.writeHead(302, { location: `http://localhost:${port}/final` }); return res.end(); }
      if (req.url === '/same') { res.writeHead(302, { location: `http://127.0.0.1:${port}/final` }); return res.end(); }
      if (req.url.startsWith('/pl')) { playlistHits++; res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2,\nseg0.ts\n#EXT-X-ENDLIST\n'); }
      if (req.url === '/r') { res.writeHead(302, { location: `http://127.0.0.1:${port}/blocked` }); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    // (a) the direct transport
    const { Transport } = require('../src/main/transport');
    const tr = new Transport({ session: browser.normalSession, settings });
    const go = async (p, headers) => {
      seen.length = 0;
      const conn = await tr.open(base + p, { headers, direct: true });
      conn.abort();
      await until(() => seen.some((s) => s[1] === '/final'));
      return { transport: conn.transport, last: seen.find((s) => s[1] === '/final') };
    };
    const secret = { authorization: 'Bearer abc', 'x-api-key': 'k123', accept: '*/*', referer: base + '/' };
    const other = await go('/hop', secret);
    const same = await go('/same', secret);
    result.direct = {
      otherHost: { transport: other.transport, host: other.last[0], auth: other.last[2].authorization || null, key: other.last[2]['x-api-key'] || null, accept: other.last[2].accept },
      sameHost: { transport: same.transport, host: same.last[0], auth: same.last[2].authorization || null, key: same.last[2]['x-api-key'] || null },
    };

    // (b) the media analysis
    const tab = browser.tabs.get(browser.activeId);
    const real = tab.url;
    const ask = async (pageUrl, url) => {
      tab.url = pageUrl;
      playlistHits = 0;
      try { await media.fetchText(url, { headers: {}, tabId: tab.id }); return { ok: true, hits: playlistHits }; } catch (e) { return { ok: false, hits: playlistHits, error: String(e.message).slice(0, 60) }; }
    };
    const fromWeb = await ask('https://video.example/watch', base + '/pl.m3u8');
    const fromWebViaRedirect = await ask('https://video.example/watch', base + '/r');
    const fromHome = await ask(base + '/page.html', base + '/pl.m3u8');
    tab.url = real;
    const blockedHits = seen.filter((s) => s[1] === '/blocked').length;
    result.media = { fromWeb, fromWebViaRedirect, fromHome, blockedHits };

    // The redirect check of net.open itself, with an injected guard (a public-looking page is not needed).
    const net = require('../src/main/net');
    seen.length = 0;
    let refused = '';
    try { await net.fetchText(base + '/r', { session: browser.normalSession, guard: async (u) => { if (/\/blocked/.test(u)) throw new Error('guarded'); } }); } catch (e) { refused = e.message; }
    await sleep(200);
    result.guardOnRedirect = { refused, reachedBlocked: seen.some((s) => s[1] === '/blocked') };
    // A guard that allows the address: the redirect is still followed, to the end.
    let allowedText = '';
    try { allowedText = (await net.fetchText(base + '/same', { session: browser.normalSession, guard: async () => {} })).text; } catch (e) { allowedText = 'ERR ' + e.message; }

    const c = {
      directUsed: other.transport === 'direct' && same.transport === 'direct',
      otherHostGetsNoSecrets: other.last[0] === 'localhost' && !other.last[2].authorization && !other.last[2]['x-api-key'],
      otherHostKeepsPlainHeaders: other.last[2].accept === '*/*',
      sameHostKeepsSecrets: same.last[0] === '127.0.0.1' && same.last[2].authorization === 'Bearer abc' && same.last[2]['x-api-key'] === 'k123',
      webPageCannotReachLocal: !fromWeb.ok && fromWeb.hits === 0 && /Not fetched/.test(fromWeb.error),
      webPageCannotReachViaRedirect: !fromWebViaRedirect.ok && blockedHits === 0,
      localPageStillWorks: fromHome.ok && fromHome.hits === 1,
      guardedRedirectStillFollowed: allowedText === 'ok',
      redirectGuardWorks: refused === 'guarded' && !result.guardOnRedirect.reachedBlocked,
    };
    result.checks = c;
    result.ok = Object.values(c).every(Boolean);
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
