'use strict';
// Leaked-password warning (Settings → Privacy). When a page sends a password, its SHA-1 is looked
// up in Have I Been Pwned's list of breached passwords with k-anonymity: only the first 5
// characters of the hash leave this PC (answers padded, no cookies) and the match happens here.
// The password itself is never sent or stored; results are kept in memory for this run only.
const crypto = require('crypto');

const seen = new Map(); // full SHA-1 -> times seen in breaches

/** How many times this password appears in known breaches (0 = not found). */
async function breachCount(password, fetchText) {
  const sha = crypto.createHash('sha1').update(String(password), 'utf8').digest('hex').toUpperCase();
  if (seen.has(sha)) return seen.get(sha);
  const text = await fetchText(module.exports.api + sha.slice(0, 5));
  const line = String(text).split(/\r?\n/).find((l) => l.slice(0, 35).toUpperCase() === sha.slice(5));
  const n = line ? Number(line.split(':')[1]) || 0 : 0; // padding lines have a count of 0
  seen.set(sha, n);
  return n;
}

module.exports = { breachCount, api: 'https://api.pwnedpasswords.com/range/' };
