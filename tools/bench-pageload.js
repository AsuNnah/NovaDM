'use strict';
// Page-load benchmark (run like a self-test: NOVADM_SELFTEST=tools/bench-pageload.js).
//
// Default: an offline "fake web". A local proxy answers for every http:// host, so news pages can
// load scripts from the real ad and tracker domains (which the real filter lists match), each doing
// some work like real ads do. Measures, per page: load time, CPU time of the page processes and
// requests;
// for: ad blocking off / on / on without element hiding. Also the filter engine's matching speed
// and the memory of 8 tabs before and after unloading 7 of them.
//
// NOVADM_BENCH_URLS=<file with one https address per line>: load those real pages instead (normal
// network, no proxy); the results depend on the network, so compare runs made back to back.
// Results: %TEMP%\novadm-bench.json
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const OUT = path.join(os.tmpdir(), 'novadm-bench.json');
const ROUNDS = Number(process.env.NOVADM_BENCH_ROUNDS) || 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AD_SCRIPTS = [
  'pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
  'securepubads.g.doubleclick.net/tag/js/gpt.js',
  'www.googletagmanager.com/gtm.js?id=GTM-ABC123',
  'www.google-analytics.com/analytics.js',
  'connect.facebook.net/en_US/fbevents.js',
  'static.ads-twitter.com/uwt.js',
  'cdn.taboola.com/libtrc/news-site/loader.js',
  'widgets.outbrain.com/outbrain.js',
  'c.amazon-adsystem.com/aax2/apstag.js',
  'static.hotjar.com/c/hotjar-123.js',
  'sb.scorecardresearch.com/beacon.js',
  'cdn.krxd.net/controltag/abc.js',
  'js-agent.newrelic.com/nr-loader-spa.js',
  'cdn.segment.com/analytics.js/v1/abc/analytics.min.js',
  'ads.pubmatic.com/AdServer/js/pwt/123/pwt.js',
  'acdn.adnxs.com/ast/ast.js',
  'tags.crwdcntrl.net/c/123/cc.js',
  'cdn.permutive.com/abc-web.js',
];
// What an ad script does: some CPU work, an ad frame with its own work, a tracking pixel and a
// stack of DOM nodes (like real ad slots).
const AD_JS = `(function(){var t=performance.now();while(performance.now()-t<25){}
var f=document.createElement('iframe');f.width=300;f.height=250;f.src='http://tpc.googlesyndication.com/safeframe/1-0-40/html/container.html?r='+Math.random();document.body.appendChild(f);
var i=new Image();i.src='http://www.facebook.com/tr?id=1&ev=PageView&r='+Math.random();
for(var k=0;k<150;k++){var d=document.createElement('div');d.className='ad-slot sponsored';d.textContent='ad '+k;document.body.appendChild(d);}})();`;
const AD_FRAME = '<script>var t=performance.now();while(performance.now()-t<30){}</script><div style="width:300px;height:250px;background:#ddd">Ad</div>';

function articleHtml(n) {
  const scripts = AD_SCRIPTS.map((s) => `<script src="http://${s}"></script>`).join('\n');
  const para = '<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Article ${n}</title></head><body>` +
    `<h1>Article ${n}</h1>${para.repeat(30)}<div class="adsbygoogle" style="height:250px">ad</div><div id="taboola-below-article">ad</div>` +
    `<img src="http://news.example/img/${n}.png" width="600" height="300">${para.repeat(20)}${scripts}</body></html>`;
}

module.exports = async ({ app, browser, adblock, settings, getWindow }) => {
  const result = { rounds: ROUNDS, electron: process.versions.electron, chrome: process.versions.chrome };
  let proxy = null;
  const counts = { requests: 0 };
  const urlFile = process.env.NOVADM_BENCH_URLS;
  try {
    getWindow().setContentSize(1280, 820);
    await waitFor(() => adblock.ready, 60000);
    let pages;
    if (urlFile) {
      pages = fs.readFileSync(urlFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
      result.mode = 'real pages';
    } else {
      proxy = http.createServer((req, res) => {
        counts.requests++;
        const u = new URL(req.url);
        const delay = 40 + (u.hostname.length % 5) * 15; // 40-100 ms "network"
        setTimeout(() => {
          if (u.hostname === 'news.example' && u.pathname.startsWith('/article/')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(articleHtml(u.pathname.split('/').pop())); }
          if (u.hostname === 'news.example' && u.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.alloc(40000)); }
          if (u.pathname.endsWith('.html')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(AD_FRAME); }
          if (/\.js$|gtm\.js/.test(u.pathname)) { res.writeHead(200, { 'content-type': 'application/javascript' }); return res.end(AD_JS); }
          res.writeHead(200, { 'content-type': 'image/gif' }); res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
        }, delay);
      });
      await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
      await browser.normalSession.setProxy({ proxyRules: `http=127.0.0.1:${proxy.address().port}`, proxyBypassRules: '<-loopback>' });
      settings.set({ httpsUpgrade: false }); // the fake web is http only
      pages = [1, 2, 3, 4].map((n) => `http://news.example/article/${n}`);
      result.mode = 'offline fake web (ad and tracker scripts from real ad domains)';
    }

    const configs = [
      ['adblock off', { adblock: false }, true],
      ['adblock on', { adblock: true }, true],
      ['adblock on, no element hiding', { adblock: true }, false],
    ];
    result.pages = {};
    for (let round = 0; round < ROUNDS; round++) {
      for (const [name, patch, cosmetic] of configs) {
        settings.set(patch);
        adblock.cosmetic = cosmetic;
        for (const url of pages) {
          await browser.normalSession.clearCache();
          const m = await measure(browser, url, counts);
          (result.pages[name] = result.pages[name] || []).push(m);
        }
      }
    }
    adblock.cosmetic = true;
    settings.set({ adblock: true });
    result.summary = {};
    for (const [name] of configs) {
      const list = result.pages[name].filter((m) => !m.error);
      result.summary[name] = {
        loadMs: median(list.map((m) => m.loadMs)),
        cpuMs: median(list.map((m) => m.cpuMs)),
        requests: median(list.map((m) => m.requests)),
        domNodes: median(list.map((m) => m.domNodes)),
        failed: result.pages[name].length - list.length,
      };
    }

    // Filter engine speed: requests matched per millisecond.
    const { Request } = require('@ghostery/adblocker-electron');
    const reqs = [];
    for (let i = 0; i < 20000; i++) {
      const host = i % 3 ? `cdn${i % 50}.example${i % 7}.com` : AD_SCRIPTS[i % AD_SCRIPTS.length].split('/')[0];
      reqs.push(Request.fromRawDetails({ url: `https://${host}/path/${i}/file.js?x=${i}`, sourceUrl: 'https://news.example/article', type: i % 2 ? 'script' : 'image' }));
    }
    const t0 = process.hrtime.bigint();
    let matched = 0;
    for (const r of reqs) if (adblock.engine.match(r).match) matched++;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    result.engine = { requests: reqs.length, matched, totalMs: Math.round(ms), perRequestUs: Math.round((ms * 1000 / reqs.length) * 100) / 100 };

    // Memory: 8 loaded tabs, then 7 of them unloaded.
    const ids = [];
    for (let i = 0; i < 8; i++) { ids.push(browser.createTab({ url: pages[i % pages.length], background: i > 0 })); }
    await sleep(6000);
    result.memory = { loadedTabsMB: await rendererMB(app), tabs: 8 };
    browser.selectTab(ids[0]);
    for (const id of ids.slice(1)) browser.discard(id);
    await sleep(3000);
    result.memory.afterUnloadMB = await rendererMB(app);
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  if (proxy) { proxy.close(); try { await browser.normalSession.setProxy({ mode: 'system' }); } catch {} }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};

async function measure(browser, url, counts) {
  const { app } = require('electron');
  const tab = browser.activeTab();
  const before = counts.requests;
  const cpu0 = pageCpuSeconds(app);
  const t0 = Date.now();
  try {
    await Promise.race([tab.wc.loadURL(url), sleep(30000).then(() => { throw new Error('timeout'); })]);
  } catch (e) {
    if (!/ERR_ABORTED/.test(e.message)) return { url, error: e.message };
  }
  await sleep(1500); // late ad work after load
  // CPU time of all page processes (ad frames run in their own) from the start of the load.
  const cpuMs = Math.round((pageCpuSeconds(app) - cpu0) * 1000);
  const m = await tab.wc.executeJavaScript(`(function(){
    var n = performance.getEntriesByType('navigation')[0] || {};
    return { loadMs: Math.round(n.loadEventEnd || 0), domNodes: document.getElementsByTagName('*').length };
  })()`);
  return { url, loadMs: m.loadMs || Date.now() - t0, cpuMs, domNodes: m.domNodes, requests: counts.requests - before };
}

// Page processes come and go (ad frames); the ones that ended are counted by remembering them.
const cpuSeen = new Map();
function pageCpuSeconds(app) {
  for (const p of app.getAppMetrics()) if (p.type === 'Tab' && p.cpu) cpuSeen.set(p.pid, p.cpu.cumulativeCPUUsage || 0);
  let sum = 0;
  for (const v of cpuSeen.values()) sum += v;
  return sum;
}

async function rendererMB(app) {
  await sleep(500);
  const total = app.getAppMetrics().filter((p) => p.type === 'Tab').reduce((s, p) => s + (p.memory ? p.memory.workingSetSize : 0), 0);
  return Math.round(total / 1024);
}

function median(a) { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; }
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200); } return false; }
