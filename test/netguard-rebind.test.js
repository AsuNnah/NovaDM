'use strict';
// SEC-104 (1.8.0): a guarded fetch looks the name up once and connects to the address it checked, so a name that
// answers a public address first and a private one next (DNS rebinding) can't reach the private one.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Transport } = require('../src/main/transport');
const { openerFor } = require('../src/main/netguard');

// Here 127.0.0.1 stands for "a public address" and 127.0.0.2 for "this PC": the test refuses only the second.
const refuse = (ip) => ip === '127.0.0.2';
const fakeSession = (answers) => {
  const asked = [];
  return { asked, resolveHost: async (h) => { asked.push(h); return { endpoints: [{ address: answers.shift() || '127.0.0.2', family: 'ipv4' }] }; },
    resolveProxy: async () => 'DIRECT', getUserAgent: () => 'test', cookies: { get: async () => [] } };
};

test('SEC-104: one lookup per connection, the checked address is used, a private answer is refused', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/to-literal') { res.writeHead(302, { location: `http://127.0.0.2:${server.address().port}/x` }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok ' + req.url);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // Rebinding answers: public first, then private. The connection is made with the first answer only.
    const ses = fakeSession(['127.0.0.1', '127.0.0.2']);
    const t = new Transport({ session: ses, refuse });
    const conn = await t.directOpen(`http://rebind.test:${port}/a`, { session: ses });
    let body = ''; for await (const c of conn.res) body += c;
    assert.strictEqual(body, 'ok /a');
    assert.deepStrictEqual(ses.asked, ['rebind.test'], 'looked up once, for the connection itself');

    // A private answer is refused before connecting.
    const ses2 = fakeSession(['127.0.0.2']);
    await assert.rejects(new Transport({ session: ses2, refuse }).directOpen(`http://evil.test:${port}/b`, { session: ses2 }), { code: 'NOVADM_GUARD' });

    // A redirect to a literal private address is refused too (no lookup happens for it).
    const ses3 = fakeSession(['127.0.0.1']);
    await assert.rejects(new Transport({ session: ses3, refuse }).directOpen(`http://redir.test:${port}/to-literal`, { session: ses3 }), { code: 'NOVADM_GUARD' });

    // openerFor: a local page, or a proxy doing the lookups, uses the browser stack; otherwise the pinned connection.
    const used = [];
    const open = async (u) => { used.push('browser'); return { u }; };
    class FakeTransport { directOpen(u) { used.push('pinned'); return { u }; } }
    const pub = { ...fakeSession([]), resolveHost: async () => ({ endpoints: [{ address: '93.184.216.34' }] }) };
    await openerFor(pub, 'https://site.test/', { Transport: FakeTransport, open })('https://cdn.test/p.m3u8', {});
    await openerFor(pub, 'http://192.168.1.5/', { Transport: FakeTransport, open })('http://192.168.1.5/p.m3u8', {});
    await openerFor({ ...pub, resolveProxy: async () => 'PROXY 10.0.0.1:8080' }, 'https://site.test/', { Transport: FakeTransport, open })('https://cdn.test/p.m3u8', {});
    assert.deepStrictEqual(used, ['pinned', 'browser', 'browser']);
    // A site that answers its own name with a private address is still a site on the internet (no exemption).
    const twoFaced = { ...pub, resolveHost: async () => ({ endpoints: [{ address: '93.184.216.34' }, { address: '192.168.1.1' }] }) };
    await openerFor(twoFaced, 'https://evil.test/', { Transport: FakeTransport, open })('http://192.168.1.1/', {});
    assert.strictEqual(used[3], 'pinned');
    const { guardFor } = require('../src/main/netguard');
    await assert.rejects(guardFor('https://evil2.test/', { lookup: async () => [{ address: '192.168.1.1' }] })('http://192.168.1.1/'), /Not fetched/);
  } finally { server.close(); }
});
