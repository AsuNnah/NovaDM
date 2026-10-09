'use strict';
// Verify Secure DNS: resolve hosts through Electron's resolver with DoH off vs on.
// Run: node_modules\electron\dist\electron.exe tools\check-dns.js host1 host2 ...
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, session } = require('electron');

const hosts = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.js'));
const out = {};

async function resolveAll(label) {
  const ses = session.fromPartition('dnscheck-' + label);
  out[label] = {};
  for (const h of hosts) {
    try {
      const r = await ses.resolveHost(h, { cacheUsage: 'disallowed', source: 'any' });
      out[label][h] = r.endpoints.map((e) => e.address);
    } catch (e) {
      out[label][h] = 'error: ' + e.message;
    }
  }
}

app.whenReady().then(async () => {
  app.configureHostResolver({ secureDnsMode: 'off' });
  await resolveAll('systemDns');
  app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: ['https://cloudflare-dns.com/dns-query', 'https://dns.google/dns-query'] });
  await resolveAll('secureDns');
  fs.writeFileSync(path.join(os.tmpdir(), 'novadm-dns.json'), JSON.stringify(out, null, 2));
  app.exit(0);
});
