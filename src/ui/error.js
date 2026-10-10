'use strict';
const p = new URLSearchParams(location.search);
const url = p.get('u') || '';
const code = Number(p.get('c') || 0);
const desc = p.get('d') || '';
const $ = (id) => document.getElementById(id);

let host = url;
try { host = new URL(url).host; } catch {}
$('host').textContent = url;
$('code').textContent = desc ? `${desc} (${code})` : `Error ${code}`;
document.title = host;

function show(title, hint, tips) {
  $('title').textContent = title;
  $('hint').textContent = hint;
  for (const t of tips) { const li = document.createElement('li'); li.textContent = t; $('tips').appendChild(li); }
}

const phishing = p.get('p') === '1';
if (phishing) {
  document.body.classList.add('danger');
  show(`Deceptive site ahead: ${host}`,
    'NovaDM stopped this page: the site is on a list of phishing and malware sites. It may try to steal your passwords or card details, or install harmful software.',
    ['Go back, and don’t enter any passwords or personal details here.', 'If a message or e-mail sent you here, it was probably a scam.']);
  $('code').textContent = 'Lists: Phishing URL Blocklist, uBlock Badware risks';
  $('retry').textContent = 'Go back';
  $('settings').textContent = 'Continue anyway';
} else if (code <= -200 && code > -300) {
  // Certificate errors. A name mismatch on a site that works elsewhere usually means the
  // network's DNS sent NovaDM to a block page instead of the real site.
  show(`${host} didn't prove its identity`,
    "The security certificate doesn't belong to this site, so NovaDM stopped the connection to keep you safe.",
    [
      'If this site opens in another browser, your network may be redirecting it. In Settings, set Secure DNS to Cloudflare or Google, then try again.',
      'Check that the address is spelled correctly.',
    ]);
} else if (code === -105 || code === -137) {
  show(`Can't find ${host}`, "The site's address couldn't be looked up.",
    ['Check the spelling of the address.', 'Try a different Secure DNS provider in Settings.', 'Check your internet connection.']);
} else if (code === -106) {
  show("You're offline", 'NovaDM can’t reach the internet.', ['Check your Wi-Fi or network cable.', 'Then try again.']);
} else if (code === -7 || code === -118) {
  show(`${host} took too long to respond`, 'The site may be busy or blocked on this network.',
    ['Try again in a moment.', 'Try a different Secure DNS provider in Settings.']);
} else if (code === -102 || code === -101 || code === -100 || code === -15) {
  show(`${host} refused or dropped the connection`, 'The site may be down, or your network may be blocking it.',
    ['Try again in a moment.', 'Try a different Secure DNS provider in Settings.']);
} else {
  show("This page can't be opened", 'Something went wrong while loading this page.', ['Try again.', 'Check the address.']);
}

$('retry').onclick = () => {
  if (phishing) { if (window.novadmInternal) window.novadmInternal.call('phishing.back', { url }); return; }
  if (window.novadmInternal && url) window.novadmInternal.navigate(url);
};
$('settings').onclick = () => {
  if (!window.novadmInternal) return;
  if (phishing) window.novadmInternal.call('phishing.allow', { url });
  else window.novadmInternal.navigate('novadm://settings');
};
