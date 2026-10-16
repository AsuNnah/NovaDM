'use strict';
// In-app self-test for 1.7.4: (a) a page's icon asked for when bookmarking from a private tab carries no cookies of
// the normal session (from a normal tab it still does); (b) Authorization and API-key headers of a download are not
// sent to another host after a redirect, cookies and sign-in headers stay on the same host.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { session } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-fixes174.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(80); } return null; };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

module.exports = async ({ app, browser, browsing, ipc }) => {
  const result = {};
  try {
    const iconCookies = [];
    const seen = []; // [host, headers] of requests to /final
    const server = http.createServer((req, res) => {
      const host = String(req.headers.host).split(':')[0];
      if (req.url.startsWith('/fav')) { iconCookies.push(req.headers.cookie || ''); res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
      if (req.url.startsWith('/page')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<title>P</title><link rel="icon" href="/fav${req.url.slice(5)}">hi`); }
      if (req.url === '/hop') { res.writeHead(302, { location: `http://localhost:${server.address().port}/final` }); return res.end(); }
      if (req.url === '/same') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/final` }); return res.end(); }
      if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
      if (req.url === '/final') { seen.push([host, req.headers]); res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    // (a) the normal session holds a cookie for the site
    await browser.normalSession.cookies.set({ url: base + '/', name: 'sid', value: 'normal-secret' });
    const open = async (opts, page) => {
      const id = browser.createTab({ url: base + page, ...opts });
      await until(() => browser.tabs.get(id).title === 'P' && browser.tabs.get(id).favicon);
      browser.selectTab(id);
      return id;
    };
    const normalId = await open({ win: 'normal' }, '/page-normal');
    iconCookies.length = 0;
    await ipc['bookmarks.toggleActive']();
    await until(() => iconCookies.length >= 1);
    const fromNormal = iconCookies.slice();
    const privId = await open({ incognito: true }, '/page-private');
    iconCookies.length = 0;
    await ipc['bookmarks.toggleActive']();
    await until(() => iconCookies.length >= 1);
    const fromPrivate = iconCookies.slice();
    result.icon = { fromNormal, fromPrivate };
    void normalId; void privId;

    // (b) headers over redirects
    const net = require('../src/main/net');
    const ses = session.defaultSession;
    const go = async (url, headers) => {
      seen.length = 0;
      const r = await net.open(url, { session: ses, headers });
      r.abort();
      await until(() => seen.length >= 1);
      return seen[0];
    };
    const secret = { authorization: 'Bearer abc', 'x-api-key': 'k123', cookie: 'sid=1', referer: base + '/', accept: '*/*' };
    const direct = await go(base + '/final', secret);
    // A redirect loop still ends (15 hops), with a cookie given.
    let loopResult = 'no error';
    try { const r = await net.open(base + '/loop', { session: ses, headers: { cookie: 'sid=1' } }); r.abort(); } catch (e) { loopResult = e.message; }
    const other = await go(base + '/hop', secret);
    const same = await go(base + '/same', secret);
    const otherNoCookie = await go(base + '/hop', { authorization: 'Bearer abc', accept: '*/*' });
    result.redirect = {
      otherHost: { host: other[0], auth: other[1].authorization || null, key: other[1]['x-api-key'] || null, cookie: other[1].cookie || null, accept: other[1].accept },
      sameHost: { host: same[0], auth: same[1].authorization || null, key: same[1]['x-api-key'] || null, cookie: same[1].cookie || null },
      loop: loopResult,
      direct: { auth: direct[1].authorization || null, key: direct[1]['x-api-key'] || null, cookie: direct[1].cookie || null },
      otherHostNoCookie: { host: otherNoCookie[0], auth: otherNoCookie[1].authorization || null },
    };

    const c = {
      normalSendsItsCookie: fromNormal.some((x) => /sid=normal-secret/.test(x)),
      privateSendsNone: fromPrivate.length >= 1 && fromPrivate.every((x) => !/normal-secret/.test(x)),
      otherHostGetsNoSecrets: other[0] === 'localhost' && !other[1].authorization && !other[1]['x-api-key'] && !other[1].cookie,
      otherHostKeepsPlainHeaders: other[1].accept === '*/*',
      sameHostKeepsEverything: same[0] === '127.0.0.1' && same[1].authorization === 'Bearer abc' && same[1]['x-api-key'] === 'k123' && same[1].cookie === 'sid=1',
      otherHostNoCookieGetsNoAuth: otherNoCookie[0] === 'localhost' && !otherNoCookie[1].authorization,
      redirectLoopEnds: /Too many redirects/.test(loopResult),
    };
    result.checks = c;
    result.ok = Object.values(c).every(Boolean);
  } catch (e) { result.error = String(e && e.stack || e); }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
