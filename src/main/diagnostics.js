'use strict';
// "Report a problem" (menu): a text file with what's needed to find a bug. Everything in it goes
// through redact(); settings that can hold personal data show only whether they are set.
const os = require('os');
const { redact } = require('./redact');

const MAX_LINES = 500;
const lines = [];
const SENSITIVE_SETTING = /pass|token|secret|cookie|proxy|auth|login|home|folder|dir|path|site|rule|perm|agent|header|dns/i;

function add(level, args) {
  const text = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : safeJson(a))).join(' ');
  lines.push(`${new Date().toISOString()} ${level.padEnd(5)} ${text.slice(0, 2000)}`);
  if (lines.length > MAX_LINES) lines.shift();
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

/** Keep the last warnings, errors and crashes (in memory only; nothing is written until a report is saved). */
function install(app) {
  for (const level of ['warn', 'error']) {
    const orig = console[level];
    console[level] = (...a) => { add(level, a); orig.apply(console, a); };
  }
  app.on('render-process-gone', (_e, wc, d) => add('crash', [`page process ${d.reason} (exit ${d.exitCode}) on ${wc.getURL()}`]));
  app.on('child-process-gone', (_e, d) => add('crash', [`${d.type} process ${d.reason} (exit ${d.exitCode})${d.name ? ' ' + d.name : ''}`]));
  // Errors in NovaDM's own code that nothing caught (the monitor only watches; default handling stays).
  process.on('uncaughtExceptionMonitor', (e) => add('crash', ['uncaught:', e]));
  process.on('unhandledRejection', (r) => console.error('unhandled promise rejection:', r));
}

/** Errors printed in NovaDM's own UI pages (toolbar, panels). */
function watchConsole(wc, label) {
  wc.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') add(e.level === 'error' ? 'error' : 'warn', [`[${label}] ${e.message} (${e.sourceId}:${e.lineNumber})`]); });
  // A NovaDM page that doesn't load (1.3.0–1.4.0: empty toolbar) shows up here.
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => { if (isMain && code !== -3) add('load', [`[${label}] ${desc} (${code}) ${url}`]); });
}

function settingValue(k, v) {
  if (typeof v === 'boolean' || typeof v === 'number' || v == null) return String(v);
  if (Array.isArray(v)) return `${v.length} item(s)`;
  if (typeof v === 'object') return `${Object.keys(v).length} item(s)`;
  if (SENSITIVE_SETTING.test(k)) return v ? '[set]' : '[empty]';
  return String(v).slice(0, 80);
}

async function report({ app, settings, downloads, extensions, ffmpeg, ytdlp, aria2, browser, update }) {
  const out = [];
  const section = (title) => out.push('', `## ${title}`);

  section('Versions');
  out.push(`NovaDM ${app.getVersion()}${app.isPackaged ? '' : ' (from source)'}`,
    `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`,
    `Windows ${os.release()} ${os.arch()}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.cpus().length} CPU threads`,
    `Running for ${Math.round(process.uptime() / 60)} min, ${app.getAppMetrics().length} processes`);
  try { out.push(`GPU: ${Object.entries(app.getGPUFeatureStatus()).filter(([, v]) => !/enabled/.test(v)).map(([k, v]) => `${k}=${v}`).join(', ') || 'all enabled'}`); } catch {}

  out.push(`Install: ${!app.isPackaged ? 'from source' : process.env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installed'}`);

  if (browser) {
    section('Windows and tabs');
    const tabs = [...browser.tabs.values()];
    const normal = tabs.filter((t) => !t.incognito);
    out.push(`Normal tabs: ${normal.length} (${normal.filter((t) => t.discarded).length} unloaded), private tabs: ${tabs.length - normal.length}`);
  }
  section('Updates');
  out.push(`Check for updates: ${settings.get('updateCheck') === false ? 'off' : 'on'}`);
  out.push(update ? `Update ${update.version}: ${update.auto ? update.phase : 'notice'}${update.error ? ` (${update.error})` : ''}` : 'No newer version found (or not checked yet)');

  section('Add-ons');
  for (const [name, m] of [['FFmpeg', ffmpeg], ['yt-dlp', ytdlp], ['aria2', aria2]]) {
    let st = {};
    try { st = await m.status(); } catch (e) { st = { error: e.message }; }
    out.push(`${name}: ${st.installed ? `installed ${st.version || ''}` : 'not installed'}${st.error ? ` (${st.error})` : ''}`);
  }
  const exts = (extensions && extensions.list && extensions.list()) || [];
  out.push(`Chrome extensions: ${exts.map((e) => `${e.name} ${e.version}`).join(', ') || 'none'}`);

  section('Settings');
  for (const [k, v] of Object.entries(settings.all())) if (k !== 'searchEngines') out.push(`${k}: ${settingValue(k, v)}`);

  section('Downloads');
  const list = downloads.list();
  const counts = {};
  for (const d of list) counts[d.state] = (counts[d.state] || 0) + 1;
  out.push(Object.entries(counts).map(([s, n]) => `${s} ${n}`).join(', ') || 'none');
  // The last 10, any state: what kind of download, how far it got, and how it was handled.
  for (const d of list.slice(0, 10)) {
    let site = '';
    try { site = new URL(d.pageUrl || d.from || '').host; } catch {}
    out.push(`${d.state}: ${d.kind || 'http'} ${d.category || ''} from ${site || '?'}, ${d.percent != null ? d.percent + '%' : ''}${typeof d.segments === 'number' ? ` segments ${d.doneSegments || 0}/${d.segments}` : ''}${d.errorCode ? ' ' + d.errorCode : ''}${d.error ? ' ' + d.error : ''}`);
  }
  for (const d of list.filter((x) => x.state === 'error').slice(10, 20)) {
    let site = '';
    try { site = new URL(d.pageUrl || d.from || '').host; } catch {}
    out.push(`failed: ${d.kind || 'http'} ${d.category || ''} from ${site || '?'}: ${d.errorCode || ''} ${d.error || ''}`);
  }

  section(`Last ${lines.length} warnings, errors and crashes`);
  out.push(...lines);
  // The header is added after redact(), which would shorten its link.
  return ['# NovaDM problem report', '',
    'Personal data is removed: web addresses show only the site; your user name, PC name, folders,',
    'e-mail addresses, passwords and cookies are not included. Read it before sharing.',
    'Send it with a description of the problem: https://github.com/AsuNnah/NovaDM/issues',
  ].join('\n') + '\n' + redact(out.join('\n'), { appPath: app.getAppPath() }) + '\n';
}

module.exports = { install, watchConsole, report, add, settingValue };
