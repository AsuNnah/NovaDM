'use strict';
// After a download finishes:
//  - Mark of the Web: the file gets a Zone.Identifier stream (ZoneId=3, "from the internet"), like
//    browsers write, so Windows SmartScreen and Office Protected View check it before it runs.
//  - Virus scan with Microsoft Defender's command-line scanner (MpCmdRun.exe), when installed.
//  - Videos saved as fragments (HLS, DASH, joined tracks) become a normal MP4 with FFmpeg, if it is
//    installed: players start at once and jump without delay (makeFaststart).
// Only Windows and NTFS support these; elsewhere they are skipped quietly.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function markOfTheWeb(file, { url = '', referrer = '', incognito = false } = {}) {
  if (process.platform !== 'win32') return false;
  const lines = ['[ZoneTransfer]', 'ZoneId=3'];
  // Private tabs: say "from the internet" without recording where (as Chromium does).
  if (incognito) lines.push('HostUrl=about:internet');
  else {
    if (/^https?:/i.test(referrer)) lines.push('ReferrerUrl=' + referrer);
    if (/^https?:/i.test(url)) lines.push('HostUrl=' + url);
  }
  try {
    fs.writeFileSync(file + ':Zone.Identifier', lines.join('\r\n') + '\r\n');
    return true;
  } catch {
    return false; // FAT/exFAT drives have no alternate data streams
  }
}

function readMarkOfTheWeb(file) {
  try { return fs.readFileSync(file + ':Zone.Identifier', 'utf8'); } catch { return ''; }
}

const versionKey = (name) => name.split(/[.-]/).map((x) => String(Number(x) || 0).padStart(8, '0')).join('.');

/** Path of Defender's MpCmdRun.exe (newest platform version first), or ''. */
function findDefender() {
  if (process.platform !== 'win32') return '';
  const cands = [];
  try {
    const plat = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
    const dirs = fs.readdirSync(plat).sort((a, b) => (versionKey(a) < versionKey(b) ? 1 : -1));
    for (const d of dirs) cands.push(path.join(plat, d, 'MpCmdRun.exe'));
  } catch {}
  cands.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe'));
  return cands.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || '';
}

/**
 * Read MpCmdRun's output. Its exit code is 2 both for "threat found" and for "scan failed", so the
 * text decides. Returns { result: 'clean' | 'threat' | 'error', detail }.
 */
function parseScanOutput(out) {
  const text = String(out || '');
  if (/found no threats/i.test(text)) return { result: 'clean', detail: '' };
  const m = /found\s+(\d+)\s+threats?/i.exec(text);
  if (m && Number(m[1]) > 0) {
    const name = /Threat\s*:\s*(.+)/i.exec(text);
    return { result: 'threat', detail: name ? name[1].trim() : `${m[1]} threat(s)` };
  }
  const fail = /\[Failed\][^\r\n]*|Failed with hr\s*=\s*\S+/i.exec(text);
  return { result: 'error', detail: fail ? fail[0].trim() : 'The scan did not finish' };
}

let defenderPath = null;
let running = { at: 0, ok: true };
/** Is Defender's service running? (With another antivirus active it is stopped, and MpCmdRun then only fails.) Cached for a minute. */
function defenderRunning() {
  if (Date.now() - running.at < 60000) return Promise.resolve(running.ok);
  return new Promise((resolve) => {
    execFile('sc.exe', ['query', 'WinDefend'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      running = { at: Date.now(), ok: err ? true : /STATE\s*:\s*\d+\s+RUNNING/i.test(String(stdout)) }; // a failed query: try the scan anyway
      resolve(running.ok);
    });
  });
}

/** Scan one file. Resolves { result: 'clean'|'threat'|'error'|'unavailable', detail }. */
async function scanFile(file, { timeoutMs = 5 * 60 * 1000 } = {}) {
  if (defenderPath === null) defenderPath = findDefender();
  if (!defenderPath) return { result: 'unavailable', detail: 'Microsoft Defender is not available' };
  if (!(await defenderRunning())) return { result: 'unavailable', detail: 'Microsoft Defender is turned off (another antivirus is in charge)' };
  return new Promise((resolve) => {
    execFile(defenderPath, ['-Scan', '-ScanType', '3', '-File', file], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const parsed = parseScanOutput(`${stdout || ''}\n${stderr || ''}`);
      if (parsed.result === 'error' && err && err.killed) parsed.detail = 'The scan took too long';
      resolve(parsed);
    });
  });
}

/** Should this download be scanned? setting: 'programs' (programs + archives) | 'all' | 'off'. */
function wantsScan(setting, category) {
  if (setting === 'all') return true;
  if (setting === 'off') return false;
  return category === 'programs' || category === 'archives';
}

// Not plain .gz/.bz2/.xz: tar.exe only reads those when there is a tar inside.
const ARCHIVE_EXT = /\.(zip|7z|rar|tar|tgz|tbz2|txz|tar\.gz|tar\.bz2|tar\.xz|tar\.zst|cab|iso)$/i;

function isArchive(file) { return ARCHIVE_EXT.test(file || ''); }

/**
 * Unpack an archive into a new folder next to it (named after it), with Windows' own tar.exe
 * (libarchive: zip, tar.*, 7z, rar, cab, iso, as far as the Windows version supports them). It
 * refuses entries with absolute paths or ".." on its own. Resolves { ok, folder, error }.
 */
function extractArchive(file, { tarPath } = {}) {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(ARCHIVE_EXT, '') || 'extracted';
  let dest = path.join(dir, base);
  for (let i = 1; fs.existsSync(dest); i++) dest = path.join(dir, `${base} (${i})`);
  fs.mkdirSync(dest, { recursive: true });
  const tar = tarPath || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve) => {
    execFile(tar, ['-xf', file, '-C', dest], { windowsHide: true, timeout: 30 * 60 * 1000 }, (err, _out, errOut) => {
      if (err) {
        try { if (!fs.readdirSync(dest).length) fs.rmdirSync(dest); } catch {}
        return resolve({ ok: false, folder: '', error: String(errOut || err.message).trim().split(/\r?\n/).pop() || 'Could not unpack this archive' });
      }
      resolve({ ok: true, folder: dest });
    });
  });
}

/** A fragmented MP4 (moof boxes, or mvex in the moov): what video downloads save before makeFaststart. */
function isFragmentedMp4(file) {
  const { readBoxes, child } = require('../media/mp4');
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(1 << 20, fs.fstatSync(fd).size));
    fs.readSync(fd, head, 0, head.length, 0);
    const boxes = readBoxes(head);
    const moov = boxes.find((b) => b.type === 'moov');
    return boxes.some((b) => b.type === 'moof') || !!(moov && child(head, moov, 'mvex'));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Rewrite a fragmented MP4 as a normal one with its index first (FFmpeg -c copy -movflags +faststart;
 * nothing is re-encoded). The original is replaced only when FFmpeg succeeded and the result is
 * about as big; otherwise it stays as it is. { ok, size } or { ok: false, error }.
 * shortcut: if NovaDM closes during the rewrite, "<name>.faststart.part" is left next to the video.
 */
async function makeFaststart(file, ffmpeg, { retries = 10, waitMs = 1000 } = {}) {
  const tmp = file + '.faststart.part';
  try {
    await ffmpeg.run(['-i', file, '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', tmp]);
    const before = fs.statSync(file).size;
    const after = fs.statSync(tmp).size;
    if (after < before * 0.9) throw new Error(`FFmpeg's file is too small (${after} of ${before} bytes)`);
    // A player may still have the video open: try again for a while before giving up.
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); break; } catch (e) {
        if (i >= retries || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    return { ok: true, size: after };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { markOfTheWeb, readMarkOfTheWeb, findDefender, parseScanOutput, scanFile, wantsScan, isArchive, extractArchive, isFragmentedMp4, makeFaststart };
