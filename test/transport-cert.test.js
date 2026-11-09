'use strict';
// REQ-308 (1.8.0): after "Proceed (unsafe)" in a normal window, the fast engine accepts that host's certificate by its
// SHA-256 fingerprint, and still refuses any other bad certificate. Other sessions never get the exception.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { Transport } = require('../src/main/transport');

let openssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { openssl = false; }

test('REQ-308: an accepted certificate passes by fingerprint only, in the normal session only', { skip: !openssl && 'needs openssl to make a test certificate' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'novadm-cert-'));
  const make = (n) => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, `k${n}.pem`), '-out', path.join(dir, `c${n}.pem`)], { stdio: 'ignore' });
    const cert = fs.readFileSync(path.join(dir, `c${n}.pem`));
    return { key: fs.readFileSync(path.join(dir, `k${n}.pem`)), cert, fp: 'sha256/' + crypto.createHash('sha256').update(new crypto.X509Certificate(cert).raw).digest('base64') };
  };
  const a = make(1); const b = make(2);
  const server = https.createServer({ key: a.key, cert: a.cert }, (req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const ses = { resolveHost: async () => ({ endpoints: [{ address: '127.0.0.1', family: 'ipv4' }] }), resolveProxy: async () => 'DIRECT', getUserAgent: () => 'test', cookies: { get: async () => [] } };
  const other = { ...ses };
  const read = async (t, s) => { const c = await t.directOpen(`https://localhost:${port}/`, { session: s }); let x = ''; for await (const d of c.res) x += d; return x; };
  try {
    let accepted = [];
    const asked = [];
    const t = new Transport({ session: ses, certFor: (h) => { asked.push(h); return accepted; } });
    await assert.rejects(read(t, ses), 'refused before Proceed');
    accepted = [a.fp];
    t.agents.clear(); // a fresh connection, as for a new download
    assert.strictEqual(await read(t, ses), 'ok', 'the accepted certificate passes');
    assert.ok(asked.includes(`localhost:${port}`), 'asked with host:port');
    await assert.rejects(read(t, other), 'another session gets no exception');
    accepted = [b.fp];
    t.agents.clear();
    await assert.rejects(read(t, ses), { code: 'NOVADM_CERT' }, 'a different certificate is refused');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
