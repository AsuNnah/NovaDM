'use strict';
// In-app self-test for 1.8.0 (REQ-309, SEC-109): a site marked "Forget this site when NovaDM closes" has no cookie
// left in the Cookies file on disk after the forget step, and another site keeps its cookie. Made-up sites only.
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(os.tmpdir(), 'novadm-selftest-forgetsites.json');

module.exports = async ({ app, browser, browsing, settings }) => {
  const result = { checks: {} };
  const c = result.checks;
  try {
    const ses = browser.normalSession;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await ses.cookies.set({ url: 'https://bank.example/', name: 'forgetme', value: 'signed-in', expirationDate: exp, secure: true });
    await ses.cookies.set({ url: 'https://login.bank.example/', name: 'forgetme2', value: 'signed-in', expirationDate: exp, secure: true });
    await ses.cookies.set({ url: 'https://news.example/', name: 'keepme', value: 'kept', expirationDate: exp, secure: true });
    await ses.cookies.flushStore();
    const part = path.join(app.getPath('userData'), 'Partitions', 'browser');
    const file = [path.join(part, 'Network', 'Cookies'), path.join(part, 'Cookies')].find((f) => fs.existsSync(f)); // Windows / Linux
    const names = () => { const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(file, { readOnly: true }); const r = db.prepare('SELECT name FROM cookies').all().map((x) => x.name); db.close(); return r; };
    result.before = names();
    c.cookiesOnDiskBefore = ['forgetme', 'forgetme2', 'keepme'].every((n) => result.before.includes(n));

    settings.set({ forgetSites: ['bank.example'] });
    await browsing.onQuit(); // what NovaDM runs when it closes
    result.after = names();
    c.forgottenSiteGoneFromDisk = !result.after.includes('forgetme') && !result.after.includes('forgetme2');
    c.otherSiteKept = result.after.includes('keepme');
    result.ok = Object.values(c).every(Boolean);
  } catch (e) {
    result.fatal = String((e && e.stack) || e);
  }
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  app.exit(0);
};
