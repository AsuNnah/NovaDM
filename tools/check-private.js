'use strict';
// Release gate: no personal data in the repo, the commits or the built app.
//   node tools/check-private.js            tracked files + commit authors
//   node tools/check-private.js --build    also dist/win-unpacked/resources/app.asar
// Generic checks (Windows user folders, e-mail addresses) run everywhere, including CI.
// Your own strings (name, e-mail, site names) go one regex per line in `.private-patterns`,
// which is git-ignored so the list itself is never published.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
const PLACEHOLDER_USERS = /^(x|you|user|username|name|public|default|runneradmin)$/i;
const OK_EMAIL = /noreply|@example\.(com|org|net)$|@anthropic\.com$/i;

function findings(text, emails = true) {
  const out = [];
  for (const m of text.matchAll(/[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([A-Za-z0-9._-]+)/g)) if (!PLACEHOLDER_USERS.test(m[1])) out.push(m[0]);
  if (emails) for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) if (!OK_EMAIL.test(m[0])) out.push(m[0]);
  for (const re of own) for (const m of text.matchAll(re)) out.push(m[0]);
  return out;
}

const ownFile = path.join(root, '.private-patterns');
const own = fs.existsSync(ownFile)
  ? fs.readFileSync(ownFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => new RegExp(l, 'gi'))
  : [];

const problems = [];
// package-lock.json only lists third-party package authors.
for (const f of git('ls-files').split('\n').filter((f) => f && f !== 'package-lock.json')) {
  const buf = fs.readFileSync(path.join(root, f));
  if (buf.includes(0)) continue; // binary
  for (const hit of findings(buf.toString('utf8'))) problems.push(`${f}: ${hit}`);
}
const history = git('log', '--all', '--format=%ae%n%ce%n%s%n%b') + git('for-each-ref', 'refs/tags', '--format=%(taggeremail)%0a%(contents)');
for (const line of new Set(history.split('\n'))) {
  for (const hit of findings(line)) problems.push(`commit / tag history: ${hit}`);
}
if (process.argv.includes('--build')) {
  const asar = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
  // Third-party packages inside list their authors' e-mails, so only user folders and own patterns here.
  // shortcut: the asar's file contents are stored uncompressed, so a text scan of the archive finds them.
  for (const hit of findings(fs.readFileSync(asar).toString('latin1'), false)) problems.push(`app.asar: ${hit}`);
}

const unique = [...new Set(problems)];
for (const p of unique) console.log('PRIVATE  ' + p);
console.log(unique.length ? `\n${unique.length} finding(s): remove them before publishing` : `no personal data found (${own.length} own pattern(s) used)`);
process.exit(unique.length ? 1 : 0);
