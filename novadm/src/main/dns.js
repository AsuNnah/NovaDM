'use strict';
// Secure DNS (DNS-over-HTTPS) for all browsing and downloads. Bypasses ISP DNS that returns
// block pages for some sites (they show up as certificate name errors).
const { app } = require('electron');

const PROVIDERS = {
  cloudflare: { name: 'Cloudflare (1.1.1.1)', url: 'https://cloudflare-dns.com/dns-query' },
  google: { name: 'Google (8.8.8.8)', url: 'https://dns.google/dns-query' },
  quad9: { name: 'Quad9 (9.9.9.9)', url: 'https://dns.quad9.net/dns-query' },
  adguard: { name: 'AdGuard (blocks ads)', url: 'https://dns.adguard-dns.com/dns-query' },
};

function serversFor(settings) {
  const choice = settings.get('secureDns') || 'cloudflare';
  if (choice === 'off') return [];
  if (choice === 'custom') {
    const u = String(settings.get('secureDnsCustom') || '').trim();
    return /^https:\/\//i.test(u) ? [u] : [PROVIDERS.cloudflare.url];
  }
  const primary = (PROVIDERS[choice] || PROVIDERS.cloudflare).url;
  // A second provider keeps lookups working if the first is down.
  const backup = choice === 'google' ? PROVIDERS.cloudflare.url : PROVIDERS.google.url;
  return [primary, backup];
}

async function reachable(url, timeoutMs = 3500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // Any HTTP response means the DoH endpoint can be reached from this network.
    await fetch(url + '?dns=AAABAAABAAAAAAAAB2V4YW1wbGUDY29tAAABAAE', { signal: ctrl.signal, headers: { accept: 'application/dns-message' } });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Apply the Secure DNS setting. Starts in strict mode (encrypted only) so blocked-site answers
 * from the ISP are never used, then relaxes to "automatic" if the DoH servers can't be reached.
 * Returns a status object for the UI.
 */
async function applySecureDns(settings) {
  const servers = serversFor(settings);
  if (!servers.length) {
    app.configureHostResolver({ secureDnsMode: 'off' });
    return { mode: 'off', servers };
  }
  app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: servers });
  const ok = (await reachable(servers[0])) || (servers[1] && (await reachable(servers[1])));
  if (!ok) {
    app.configureHostResolver({ secureDnsMode: 'automatic', secureDnsServers: servers });
    return { mode: 'automatic', servers, note: 'Secure DNS servers unreachable on this network; using normal DNS as fallback.' };
  }
  return { mode: 'secure', servers };
}

module.exports = { applySecureDns, PROVIDERS };
