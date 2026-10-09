'use strict';
// In-app self-test for 0.8.0 (extras), against local servers only: theme + accent, shortcuts and
// zoom in pages, a "Copy as cURL" command, a category rule's folder, per-site settings (browser
// name, connections, sign-in), unpacking archives, the after-download program and webhook,
// export/import, and the MCP endpoint.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { nativeTheme } = require('electron');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-phase7.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(120); } return null; };

module.exports = async ({ app, browser, downloads, settings, ipc, chromeView, api }) => {
  const result = {};
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-p7-'));
    // A zip to serve.
    fs.mkdirSync(path.join(tmp, 'pack'));
    fs.writeFileSync(path.join(tmp, 'pack', 'inside.txt'), 'unpacked!');
    execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-a', '-c', '-f', path.join(tmp, 'pack.zip'), '-C', path.join(tmp, 'pack'), 'inside.txt']);
    const seen = { ua: new Set(), curl: null, hook: null, active: 0, peak: 0 };
    const big = Buffer.alloc(3 * 1024 * 1024, 9);
    const server = http.createServer((req, res) => {
      const u = req.url.split('?')[0];
      if (u === '/hook') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { seen.hook = JSON.parse(b); res.end('ok'); }); return; }
      if (u === '/page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<!doctype html><title>Page</title><p>Some text to zoom</p>'); }
      if (u === '/curl.bin') { seen.curl = { cookie: req.headers.cookie, referer: req.headers.referer }; res.writeHead(200, { 'Content-Length': 5 }); return res.end('curl!'); }
      if (u === '/secure.bin') {
        if (req.headers.authorization !== 'Basic ' + Buffer.from('me:pa55').toString('base64')) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="files"' }); return res.end(); }
        res.writeHead(200, { 'Content-Length': 6 }); return res.end('secret');
      }
      if (u === '/site.bin') {
        seen.ua.add(req.headers['user-agent']);
        seen.active++; seen.peak = Math.max(seen.peak, seen.active);
        res.on('close', () => { seen.active--; });
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
        const a = m ? Number(m[1]) : 0; const b = m && m[2] ? Number(m[2]) : big.length - 1;
        res.writeHead(m ? 206 : 200, { 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${a}-${b}/${big.length}` } : {}) });
        let off = a;
        const tick = () => { if (res.destroyed) return; if (off > b) return res.end(); const n = Math.min(32768, b - off + 1); res.write(big.subarray(off, off + n)); off += n; setTimeout(tick, 5); };
        return tick();
      }
      if (u === '/files/pack.zip') { const z = fs.readFileSync(path.join(tmp, 'pack.zip')); res.writeHead(200, { 'Content-Length': z.length }); return res.end(z); }
      if (u === '/files/rule.psd') { res.writeHead(200, { 'Content-Length': 4 }); return res.end('8BPS'); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dlDir = path.join(app.getPath('userData'), 'dl-phase7');
    settings.set({ downloadDir: dlDir, categoryFolders: false, skipEditor: true, notifyOnComplete: false });
    const byName = (n) => downloads.list().find((d) => d.name === n);
    const doneByName = (n) => until(() => { const d = byName(n); return d && ['done', 'error'].includes(d.state) && d; }, 20000);

    // 1. Theme and accent
    settings.set({ theme: 'light', accent: '#10b981' });
    await sleep(500);
    result.appearance = {
      themeSource: nativeTheme.themeSource,
      accent: (await chromeView.webContents.executeJavaScript("getComputedStyle(document.documentElement).getPropertyValue('--accent')")).trim(),
    };
    settings.set({ theme: 'system', accent: '#5b7cfa' });

    // 2. Shortcuts and zoom inside a page
    const tabId = browser.createTab({ url: base + '/page' });
    const tab = browser.tabs.get(tabId);
    await until(() => !tab.wc.isLoading(), 5000);
    tab.wc.focus();
    const before = browser.order.length;
    tab.wc.sendInputEvent({ type: 'keyDown', keyCode: '=', modifiers: ['control'] });
    await sleep(300);
    const zoom = tab.wc.getZoomLevel();
    tab.wc.sendInputEvent({ type: 'keyDown', keyCode: '0', modifiers: ['control'] });
    tab.wc.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] });
    await sleep(400);
    result.shortcuts = { zoomedTo: zoom, resetTo: tab.wc.getZoomLevel(), newTab: browser.order.length === before + 1 };

    // 3. A "Copy as cURL" command: same cookie and referer
    await ipc['downloads.addUrl']({ url: `curl '${base}/curl.bin' -H 'referer: ${base}/page' -b 'session=xyz'` });
    result.curl = { state: ((await doneByName('curl.bin')) || {}).state, server: seen.curl };

    // 4. A category rule with its own folder
    const ruleDir = path.join(app.getPath('userData'), 'design-files');
    settings.set({ categoryRules: [{ by: 'type', value: 'psd', category: 'images', folder: ruleDir }] });
    downloads.add({ kind: 'http', url: base + '/files/rule.psd', name: 'rule.psd' });
    const rd = await doneByName('rule.psd');
    result.rule = { folder: rd ? path.dirname(rd.savePath) === ruleDir : false, category: rd && rd.category };

    // 5. Per-site settings: browser name, one connection, and a sign-in
    settings.set({ connections: 8, siteSettings: [{ site: '127.0.0.1', connections: 1, userAgent: 'NovaDM-Test-Agent', speedLimitKBps: 0, user: 'me', passEnc: require('../src/main/proxy').encryptPassword('pa55') }] });
    downloads.add({ kind: 'http', url: base + '/site.bin', name: 'site.bin' });
    downloads.add({ kind: 'http', url: base + '/secure.bin', name: 'secure.bin' });
    const sd = await doneByName('site.bin');
    const sec = await doneByName('secure.bin');
    result.site = { state: sd && sd.state, userAgents: [...seen.ua], peakConnections: seen.peak, signIn: sec && sec.state, signInContent: sec && sec.state === 'done' ? fs.readFileSync(sec.savePath, 'utf8') : '' };
    const pageSettings = await ipc['settings.get']();
    result.site.passwordHiddenFromPages = !JSON.stringify(pageSettings.siteSettings).includes('passEnc') && pageSettings.siteSettings[0].hasPassword === true;
    settings.set({ siteSettings: [], categoryRules: [] });

    // 6. Unpack archives + 7. program and webhook
    const nodeExe = execFileSync('where.exe', ['node']).toString().split(/\r?\n/)[0].trim();
    const script = path.join(tmp, 'hook.js');
    const evidence = path.join(tmp, 'program-got.txt');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(evidence)}, process.argv.slice(2).join('|'));`);
    settings.set({ extractArchives: true, afterProgram: nodeExe, afterArgs: `"${script}" "{file}" {name}`, webhookUrl: base + '/hook' });
    downloads.add({ kind: 'http', url: base + '/files/pack.zip', name: 'pack.zip' });
    const zd = await doneByName('pack.zip');
    const unpacked = await until(() => { const d = byName('pack.zip'); return d && d.extract === 'done' && d; }, 10000);
    await until(() => fs.existsSync(evidence) && seen.hook, 8000);
    result.after = {
      zip: zd && zd.state,
      unpacked: unpacked ? fs.readFileSync(path.join(path.dirname(unpacked.savePath), 'pack', 'inside.txt'), 'utf8') : null,
      program: fs.existsSync(evidence) ? fs.readFileSync(evidence, 'utf8') : null,
      webhook: seen.hook && { event: seen.hook.event, name: seen.hook.name },
    };
    settings.set({ extractArchives: false, afterProgram: '', webhookUrl: '' });

    // 8. Export and import
    const backup = require('../src/main/backup');
    const data = backup.exportData({ settings, downloads, version: app.getVersion() });
    const before2 = downloads.list().length;
    for (const d of downloads.list()) if (d.name === 'curl.bin') await downloads.cancel(d.id, false);
    const imp = backup.importData(data, { settings, downloads });
    result.backup = { exported: data.downloads.length, added: imp.added, skipped: imp.skipped, back: downloads.list().length === before2, curlBack: !!byName('curl.bin') };

    // 9. MCP
    settings.set({ apiEnabled: true, apiPort: 0 });
    await sleep(600);
    const port = api.port;
    const mcp = await new Promise((resolve) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/mcp', agent: false, headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.get('apiKey')}` } }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(JSON.parse(s)));
      });
      r.end(body);
    });
    result.mcpTools = mcp.result.tools.map((t) => t.name);
    server.close();
  } catch (e) {
    result.fatal = String(e && e.stack || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
