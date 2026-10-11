'use strict';
// Site extensions: small scripts that turn a page into downloadable files, for sites NovaDM's own
// detection doesn't understand (the idea of Gopeed's extensions). A folder with
//   novadm-extension.json  { name, version, description, matches: ["https://*.example.com/*"], script }
//   <script>.js            novadm.onResolve(async (page) => [{ url, name, kind, headers, size }])
// Each run happens in a fresh sandboxed page: no Node, an empty cookie jar, and no network of its own
// (Content-Security-Policy). The only way out is novadm.fetchText/fetchJson, which NovaDM carries out
// only for addresses on the extension's declared sites. Installing shows those sites and asks first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MANIFEST = 'novadm-extension.json';
const RUN_TIMEOUT = 20000;
const MAX_ITEMS = 200;

/** Chrome-style match pattern ("*://*.example.com/*") against a URL. */
function matchPattern(pattern, url) {
  const m = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(String(pattern || ''));
  let u;
  try { u = new URL(url); } catch { return false; }
  if (!m || !/^https?:$/.test(u.protocol)) return false;
  const [, scheme, host, pathPat] = m;
  if (scheme !== '*' && scheme + ':' !== u.protocol) return false;
  const h = u.hostname.toLowerCase();
  if (host !== '*') {
    if (host.startsWith('*.')) { const base = host.slice(2).toLowerCase(); if (h !== base && !h.endsWith('.' + base)) return false; }
    else if (h !== host.toLowerCase()) return false;
  }
  const re = new RegExp('^' + pathPat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(u.pathname + u.search);
}

function readManifest(dir) {
  const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  const name = String(m.name || '').trim().slice(0, 60);
  if (!name) throw new Error('The extension has no name');
  const matches = (Array.isArray(m.matches) ? m.matches : []).map(String).filter((p) => /^(\*|https?):\/\/[^/]+\/.*$/.test(p));
  if (!matches.length) throw new Error('The extension does not say which sites it works on ("matches")');
  if (matches.some((p) => /^(\*|https?):\/\/\*\//.test(p))) throw new Error('The extension asks for every site; NovaDM only accepts extensions for specific sites');
  const script = String(m.script || 'index.js');
  if (script.includes('..') || path.isAbsolute(script) || !fs.existsSync(path.join(dir, script))) throw new Error('The extension script is missing');
  return { name, version: String(m.version || '0'), description: String(m.description || '').slice(0, 300), matches, script };
}

/** What an extension may hand back: web links only, simple fields. */
function cleanItems(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items.slice(0, MAX_ITEMS) : []) {
    if (!it || typeof it.url !== 'string' || !/^(https?:\/\/|magnet:\?)/i.test(it.url)) continue;
    const kind = ['hls', 'dash', 'video', 'audio', 'file'].includes(it.kind) ? it.kind : /\.m3u8(\?|$)/i.test(it.url) ? 'hls' : /\.mpd(\?|$)/i.test(it.url) ? 'dash' : 'file';
    const headers = {};
    for (const [k, v] of Object.entries(it.headers || {})) if (typeof v === 'string' && /^(referer|origin|authorization|x-[a-z0-9-]+)$/i.test(k)) headers[k.toLowerCase()] = v.slice(0, 2000);
    out.push({ url: it.url, kind, name: typeof it.name === 'string' ? it.name.slice(0, 200) : '', label: typeof it.label === 'string' ? it.label.slice(0, 40) : '', size: Number(it.size) > 0 ? Number(it.size) : -1, duration: Number(it.duration) > 0 ? Number(it.duration) : 0, headers });
  }
  return out;
}

class SiteExtensions {
  /**
   * ctx: { settings, userDataDir, fetchText(url, { headers, session }), confirm(info) => Promise<bool>,
   *   createSandbox() => { webContents, destroy() } (Electron; injected so the logic is testable) }
   */
  constructor(ctx) {
    Object.assign(this, ctx);
    this.dir = path.join(ctx.userDataDir, 'site-extensions');
    this.runs = new Map(); // webContents id -> { ext }
  }

  list() {
    let dirs = [];
    try { dirs = fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch {}
    const off = new Set(this.settings.get('siteExtensionsOff') || []);
    const out = [];
    for (const d of dirs) {
      try { out.push({ id: d.name, ...readManifest(path.join(this.dir, d.name)), enabled: !off.has(d.name) }); } catch {}
    }
    return out;
  }

  setEnabled(id, on) {
    const off = new Set(this.settings.get('siteExtensionsOff') || []);
    if (on) off.delete(id); else off.add(id);
    this.settings.set({ siteExtensionsOff: [...off] });
  }

  remove(id) {
    if (!/^[a-z0-9-]+$/.test(id)) return;
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }

  /** Install from a folder (copied). Asks the user first, showing the sites it can read. */
  async installFromFolder(src) {
    const man = readManifest(src);
    if (this.confirm && !(await this.confirm(man))) return { ok: false, cancelled: true };
    const id = man.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + crypto.createHash('sha1').update(man.name).digest('hex').slice(0, 6);
    const dest = path.join(this.dir, id);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    fs.cpSync(src, dest, { recursive: true, filter: (p) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(p) });
    return { ok: true, id, ...man };
  }

  /** Install from a GitHub repository address (its default branch, as a zip). */
  async installFromGitHub(repoUrl, download) {
    const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(repoUrl || '').trim());
    if (!m) throw new Error('Enter a GitHub address like https://github.com/owner/repository');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-siteext-'));
    try {
      const zip = path.join(tmp, 'ext.zip');
      await download(`https://codeload.github.com/${m[1]}/${m[2]}/zip/HEAD`, zip);
      const out = path.join(tmp, 'x');
      fs.mkdirSync(out);
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      await new Promise((resolve, reject) => execFile(tar, ['-xf', zip, '-C', out], { windowsHide: true }, (err) => (err ? reject(new Error('Could not unpack the extension')) : resolve())));
      const top = fs.readdirSync(out).map((d) => path.join(out, d)).find((d) => fs.existsSync(path.join(d, MANIFEST)));
      if (!top) throw new Error(`No ${MANIFEST} in that repository`);
      return await this.installFromFolder(top);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Run every enabled extension made for this page. Resolves with [{ ext, items }]. */
  async resolvePage(page) {
    const exts = this.list().filter((e) => e.enabled && e.matches.some((p) => matchPattern(p, page.url)));
    const results = [];
    for (const ext of exts) {
      try { results.push({ ext: ext.name, items: cleanItems(await this.runOne(ext, page)) }); } catch (e) { results.push({ ext: ext.name, items: [], error: e.message }); }
    }
    return results;
  }

  runOne(ext, page) {
    const code = fs.readFileSync(path.join(this.dir, ext.id, ext.script), 'utf8');
    const sandbox = this.createSandbox();
    const wcId = sandbox.webContents.id;
    this.runs.set(wcId, { ext, session: page.session });
    return new Promise((resolve, reject) => {
      const finish = (err, items) => {
        clearTimeout(timer);
        this.runs.delete(wcId);
        try { sandbox.destroy(); } catch {}
        if (err) reject(err); else resolve(items);
      };
      const timer = setTimeout(() => finish(new Error('The extension took too long')), RUN_TIMEOUT);
      sandbox.onResult = (r) => (r && r.error ? finish(new Error(r.error)) : finish(null, r && r.items));
      sandbox.run({ code, page: { url: page.url, title: page.title || '' } });
    });
  }

  /** novadm.fetchText from a sandbox: only for its extension's sites, with the browsing session. */
  async fetchFor(wcId, url, opts = {}) {
    const run = this.runs.get(wcId);
    if (!run) throw new Error('Not allowed');
    if (!run.ext.matches.some((p) => matchPattern(p, url))) throw new Error(`The extension may not read ${new URL(url).host}`);
    const headers = {};
    for (const [k, v] of Object.entries(opts.headers || {})) if (typeof v === 'string' && /^(referer|accept|x-[a-z0-9-]+|content-type)$/i.test(k)) headers[k.toLowerCase()] = v;
    return this.fetchText(url, { headers, session: run.session });
  }
}

module.exports = { SiteExtensions, matchPattern, readManifest, cleanItems, MANIFEST };
