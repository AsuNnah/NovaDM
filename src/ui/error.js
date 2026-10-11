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
  certWarning();
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

// Certificate errors, as in Chrome: Back to safety, or Advanced → Proceed to <site> (unsafe), which
// trusts that certificate for that site until NovaDM closes (browser.js allowCert).
function certWarning() {
  document.body.classList.add('cert');
  $('title').textContent = 'Your connection is not private';
  const bold = (text) => { const b = document.createElement('b'); b.textContent = text; return b; };
  $('hint').append('Attackers might be trying to steal your information from ', bold(host), ' (for example, passwords, messages or credit cards).');
  $('icon').innerHTML = '<svg viewBox="0 0 24 24" width="52" height="52" fill="currentColor"><path d="M12 2.5 1.5 21h21z"/><path d="M12 9v5.5M12 17.2v.3" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const why = {
    '-202': 'its security certificate is not trusted by your computer’s operating system.',
    '-200': 'its security certificate belongs to another site. If this site opens in another browser, your network may be redirecting it: set Secure DNS to Cloudflare or Google in Settings.',
    '-201': 'its security certificate has expired or is not valid yet. Check that your computer’s date and time are right.',
  }[String(code)] || 'its security certificate has a problem.';
  $('advText').append('This server could not prove that it is ', bold(host), `; ${why} This may be caused by a misconfiguration or an attacker intercepting your connection.`);
  $('proceed').textContent = `Proceed to ${host} (unsafe)`;
  $('retry').textContent = 'Back to safety';
  $('settings').textContent = 'Advanced';
}
const cert = document.body.classList.contains('cert');
$('proceed').onclick = async (e) => {
  e.preventDefault();
  const r = window.novadmInternal && await window.novadmInternal.call('cert.proceed', { url }).catch(() => null);
  $('proceedErr').hidden = !!(r && r.ok);
};

$('retry').onclick = () => {
  if (cert) { if (window.novadmInternal) window.novadmInternal.call('phishing.back', { url }); return; } // back to safety
  if (phishing) { if (window.novadmInternal) window.novadmInternal.call('phishing.back', { url }); return; }
  if (window.novadmInternal && url) window.novadmInternal.navigate(url);
};
$('settings').onclick = () => {
  if (cert) { $('adv').hidden = !$('adv').hidden; $('settings').textContent = $('adv').hidden ? 'Advanced' : 'Hide advanced'; return; }
  if (!window.novadmInternal) return;
  if (phishing) window.novadmInternal.call('phishing.allow', { url });
  else window.novadmInternal.navigate('novadm://settings');
};
