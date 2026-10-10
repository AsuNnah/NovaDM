'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shortcutFor } = require('../src/main/shortcuts');
const { protectionFor, toggleSite } = require('../src/main/hardening');

const key = (key, mods = {}) => ({ type: 'keyDown', key, control: !!mods.ctrl, shift: !!mods.shift, alt: !!mods.alt, meta: false });

test('shortcuts: Brave / Chrome set', () => {
  const cases = [
    [key('t', { ctrl: true }), 'new-tab'], [key('T', { ctrl: true, shift: true }), 'reopen-tab'], [key('N', { ctrl: true, shift: true }), 'new-private'],
    [key('3', { ctrl: true }), 'tab-3'], [key('9', { ctrl: true }), 'tab-last'], [key('PageDown', { ctrl: true }), 'next-tab'],
    [key('Tab', { ctrl: true, shift: true }), 'prev-tab'], [key('F5', { shift: true }), 'hard-reload'], [key('R', { ctrl: true, shift: true }), 'hard-reload'],
    [key('I', { ctrl: true, shift: true }), 'devtools'], [key('F12'), 'devtools'], [key('u', { ctrl: true }), 'view-source'],
    [key('Delete', { ctrl: true, shift: true }), 'clear-data'], [key('Escape', { shift: true }), 'task-manager'], [key('/', { ctrl: true }), 'shortcut-list'],
    [key('d', { alt: true }), 'focus-address'], [key('F6'), 'focus-address'], [key('Home', { alt: true }), 'home'], [key('F11'), 'fullscreen'],
    [key('D', { ctrl: true, shift: true }), 'bookmark-all'], [key('g', { ctrl: true }), 'find-next'], [key('A', { ctrl: true, shift: true }), 'tab-search'], [key('F3', { shift: true }), 'find-prev'],
  ];
  for (const [input, want] of cases) assert.strictEqual(shortcutFor(input), want, JSON.stringify(input));
  // Plain typing and editing keys stay with the page / text field.
  for (const input of [key('a'), key('c', { ctrl: true }), key('v', { ctrl: true }), key('a', { ctrl: true }), key('Enter'), key('Enter', { ctrl: true })]) {
    assert.strictEqual(shortcutFor(input), null, JSON.stringify(input));
  }
  assert.strictEqual(shortcutFor({ ...key('t', { ctrl: true }), type: 'keyUp' }), null);
});

test('protection: levels, fingerprinting, per-site off', () => {
  const v = { hardeningOff: [] };
  const settings = { get: (k) => v[k], set: (p) => Object.assign(v, p) };
  assert.strictEqual(protectionFor(settings, 'novadm://settings'), null);
  assert.strictEqual(protectionFor(settings, 'file:///C:/x.html'), null);
  let p = protectionFor(settings, 'https://news.example/a');
  assert.deepStrictEqual([p.level, p.fingerprinting, p.clickToPlay, p.blockFonts, p.noScript], ['standard', 'standard', false, false, false]);
  // The noise seed is fixed per site (until NovaDM restarts) and differs between sites.
  assert.strictEqual(p.seed, protectionFor(settings, 'https://www.news.example/b').seed);
  assert.notStrictEqual(p.seed, protectionFor(settings, 'https://shop.example/').seed);
  v.securityLevel = 'safer';
  p = protectionFor(settings, 'https://news.example/a');
  assert.deepStrictEqual([p.fingerprinting, p.clickToPlay, p.blockFonts, p.noScript], ['strict', true, true, false]);
  assert.strictEqual(protectionFor(settings, 'http://news.example/a').noScript, true); // Safer: no JavaScript on http://
  v.securityLevel = 'safest';
  assert.strictEqual(protectionFor(settings, 'https://news.example/a').noScript, true);
  toggleSite(settings, 'https://news.example/a');
  assert.strictEqual(protectionFor(settings, 'https://news.example/other'), null);
  assert.ok(protectionFor(settings, 'https://shop.example/'));
  toggleSite(settings, 'https://news.example/a');
  assert.ok(protectionFor(settings, 'https://news.example/a'));
});

test('leaked passwords: k-anonymity lookup, padding ignored, cached', async () => {
  const breach = require('../src/main/breach');
  const asked = [];
  // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
  const fetchText = async (url) => {
    asked.push(url);
    return '0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n1E4C9B93F3F0682250B6CF8331B7EE68FD8:9545824\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0';
  };
  assert.strictEqual(await breach.breachCount('password', fetchText), 9545824);
  assert.deepStrictEqual(asked, [breach.api + '5BAA6']); // only the first 5 characters of the hash
  assert.strictEqual(await breach.breachCount('password', fetchText), 9545824);
  assert.strictEqual(asked.length, 1); // remembered for this run
  assert.strictEqual(await breach.breachCount('a-long-unique-passphrase-9f2c', async () => 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0'), 0);
});
