'use strict';
// After a download: run a program the user chose, and/or tell a web address (webhook).
//  - The program is started directly with its arguments, never through a command shell, so a file
//    name from the internet (with &, |, quotes...) can't turn into extra commands.
//    Placeholders in the arguments: {file} {folder} {name} {url} {page}.
//  - The webhook gets a POST with JSON: { event: 'finished' | 'failed', name, file, size, url, page, error }.
const path = require('path');
const { spawn } = require('child_process');
const { words } = require('./curl');

function sourceOf(rec) {
  if (rec.kind === 'hls' || rec.kind === 'dash') return rec.playlistUrl || '';
  if (rec.kind === 'torrent') return rec.magnet || '';
  return (rec.sources && rec.sources[0]) || '';
}

/** Arguments with the placeholders filled in (each argument stays one argument). */
function buildArgs(template, rec) {
  const values = { file: rec.savePath, folder: path.dirname(rec.savePath), name: rec.name, url: sourceOf(rec), page: rec.pageUrl || '' };
  return words(String(template || '')).map((a) => a.replace(/\{(file|folder|name|url|page)\}/g, (m, k) => values[k]));
}

/** Start the user's program for a finished download. Resolves { ok, error }. */
function runProgram(program, argsTemplate, rec, spawnFn = spawn) {
  return new Promise((resolve) => {
    if (!program) return resolve({ ok: false, error: 'No program chosen' });
    if (/\.(bat|cmd)$/i.test(program)) return resolve({ ok: false, error: 'Batch files run through a command shell, which NovaDM does not use for safety; choose a program (.exe)' });
    try {
      const p = spawnFn(program, buildArgs(argsTemplate, rec), { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.on('spawn', () => { try { p.unref(); } catch {} resolve({ ok: true }); });
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/** Tell a web address about a finished or failed download. */
async function sendWebhook(url, event, rec, fetchFn = fetch) {
  if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: 'Not a web address' };
  const body = { event, name: rec.name, file: rec.savePath, size: rec.size > 0 ? rec.size : null, url: sourceOf(rec), page: rec.pageUrl || '', error: rec.error || null, app: 'NovaDM' };
  try {
    const res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { runProgram, sendWebhook, buildArgs };
