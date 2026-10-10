'use strict';
// Checks the built app (dist/win-unpacked/NovaDM.exe) against ways other programs could misuse it.
// Run after `npm run dist`:  node tools/check-build-security.js
// Each check starts NovaDM with a throwaway profile and asks it to write a marker file in a way
// that must not work; the marker must never appear.
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');

const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'NovaDM.exe');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-buildcheck-'));
const marker = path.join(work, 'marker.txt');
const script = path.join(work, 'script.js');
fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = () => {};`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((r) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });

async function start(exe, args, env, ms = 7000) {
  try { fs.rmSync(marker, { force: true }); } catch {}
  const p = spawn(exe, args, { env: { ...process.env, NOVADM_USERDATA: fs.mkdtempSync(path.join(work, 'p-')), ...env }, stdio: 'ignore' });
  let exited = null;
  p.on('exit', (code) => { exited = code; });
  await sleep(ms);
  const inspect = await portOpen(9339);
  try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  return { ran: fs.existsSync(marker), inspect, exited };
}

async function cookieOnDisk(exe, args) {
  const SECRET = 'secret-session-' + Date.now();
  const server = require('http').createServer((req, res) => { res.setHeader('set-cookie', `session=${SECRET}; Max-Age=3600; Path=/`); res.end('<title>ok</title>ok'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(work, 'c-'));
  const p = spawn(exe, args, { env: { ...process.env, NOVADM_USERDATA: profile, NOVADM_OPEN: `http://127.0.0.1:${server.address().port}/` }, stdio: 'ignore' });
  let exited = false;
  p.on('exit', () => { exited = true; });
  await sleep(8000);
  try { execFileSync('taskkill', ['/PID', String(p.pid)], { stdio: 'ignore' }); } catch {} // a normal close: cookies are flushed
  for (let i = 0; i < 40 && !exited; i++) await sleep(250);
  if (!exited) { try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  server.close();
  const file = path.join(profile, 'Partitions', 'browser', 'Network', 'Cookies');
  if (!fs.existsSync(file)) return { found: false };
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  const row = db.prepare("SELECT value, encrypted_value FROM cookies WHERE name = 'session'").get();
  db.close();
  const raw = fs.readFileSync(file).includes(Buffer.from(SECRET));
  return { found: !!row, plain: !!row && (row.value === SECRET || raw), encrypted: !!row && row.encrypted_value.length > 0, encryptedBytes: row ? row.encrypted_value.length : 0 };
}

(async () => {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok, detail });

  const wire = await getCurrentFuseWire(EXE);
  const want = { RunAsNode: false, EnableCookieEncryption: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true, GrantFileProtocolExtraPrivileges: false };
  for (const [k, on] of Object.entries(want)) check(`fuse ${k} ${on ? 'on' : 'off'}`, (wire[FuseV1Options[k]] === 49) === on);

  let r = await start(EXE, [script], { ELECTRON_RUN_AS_NODE: '1' });
  check('can not be used as a Node.js runner (ELECTRON_RUN_AS_NODE)', !r.ran);
  r = await start(EXE, [], { NODE_OPTIONS: `--require "${script}"` });
  check('NODE_OPTIONS can not load code into it', !r.ran);
  r = await start(EXE, ['--inspect=9339'], {});
  check('no debugger port with --inspect', !r.inspect);
  r = await start(EXE, [], { NOVADM_SELFTEST: script });
  check('test hook NOVADM_SELFTEST is off in the built app', !r.ran);

  // A copy whose app code was changed must refuse to start.
  const copy = path.join(work, 'tampered');
  fs.cpSync(path.dirname(EXE), copy, { recursive: true });
  const asar = path.join(copy, 'resources', 'app.asar');
  const b = fs.readFileSync(asar);
  const i = Math.floor(b.length * 0.6);
  b[i] ^= 0x20;
  fs.writeFileSync(asar, b);
  r = await start(path.join(copy, 'NovaDM.exe'), [], {}, 6000);
  check('a changed app.asar does not run', r.exited !== null, `exit code ${r.exited}`);

  // Sign-in cookies are encrypted on disk: a page sets one, NovaDM closes normally, and the cookie
  // file is read directly (as malware or a copied backup could).
  const c = await cookieOnDisk(EXE, []);
  check('cookies are stored encrypted', c.found && !c.plain && c.encrypted, c.found ? `plain text: ${c.plain}, encrypted bytes: ${c.encryptedBytes}` : 'cookie not written');
  if (process.argv.includes('--control')) {
    // Plain Electron (no fuses) for comparison: the same cookie lands in plain text.
    const d = await cookieOnDisk(path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(__dirname, '..')]);
    console.log(`control, plain Electron: cookie in plain text = ${d.plain}`);
  }

  try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
  let failed = 0;
  for (const x of results) { console.log(`${x.ok ? 'ok  ' : 'FAIL'}  ${x.name}${x.detail ? ` (${x.detail})` : ''}`); if (!x.ok) failed++; }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
