'use strict';
// 1.7.7: the pop-up guard with a per-site "always block" next to the per-site "always allow".
const test = require('node:test');
const assert = require('node:assert');
const { PopupGuard } = require('../src/main/popup');

function guard(initial = {}) {
  const data = { popupMode: 'ask', popupAllow: [], popupBlock: [], ...initial };
  return Object.assign(new PopupGuard({ get: (k) => data[k], set: (c) => Object.assign(data, c) }), { data });
}
const page = 'https://shop.example/page';
const other = 'https://elsewhere.example/landing';

test('without a site list the modes work as before', () => {
  const g = guard();
  assert.equal(g.decideRequest({ pageUrl: page, url: other, click: null }), 'ask', 'a script opens another site: ask');
  assert.equal(g.decideRequest({ pageUrl: page, url: other, click: { mods: false } }), 'ask', 'a real click on a link to another site: ask');
  assert.equal(g.decideRequest({ pageUrl: page, url: 'https://shop.example/other', click: { mods: false } }), 'open', 'a link within the site');
  assert.equal(g.decideRequest({ pageUrl: page, url: other, click: { mods: true } }), 'open', 'Ctrl / middle click');
  assert.equal(g.decideRequest({ pageUrl: page, url: other, click: null, isAd: true }), 'block', 'an ad site');
  assert.equal(guard({ popupMode: 'block' }).decideRequest({ pageUrl: page, url: other, click: null }), 'block');
  assert.equal(guard({ popupMode: 'allow' }).decideRequest({ pageUrl: page, url: other, click: null }), 'open');
});

test('a site that is always blocked: its pop-ups never ask; the user\'s own clicks still open', () => {
  const g = guard({ popupBlock: ['shop.example'] });
  assert.equal(g.decideRequest({ pageUrl: page, url: other, click: null }), 'block', 'opened by a script');
  assert.equal(g.decideRequest({ pageUrl: page, url: other, click: { mods: false } }), 'block', 'a plain click that opens another site (the usual click-under trick) is blocked, not asked');
  assert.equal(g.decideRequest({ pageUrl: page, url: 'https://shop.example/other', click: { mods: false } }), 'open', 'a link within the site still works');
  assert.equal(g.decideRequest({ pageUrl: page, url: other, click: { mods: true } }), 'open', 'Ctrl / middle click is the user\'s own choice');
  assert.equal(g.decideRequest({ pageUrl: page, url: other, click: { mods: true }, isAd: true }), 'block', 'but never an ad site');
  assert.equal(g.decideRequest({ pageUrl: page, url: 'javascript:void(0)', click: null }), 'block');
  // The explicit choice beats the general setting, both ways round.
  assert.equal(guard({ popupMode: 'allow', popupBlock: ['shop.example'] }).decideRequest({ pageUrl: page, url: other, click: null }), 'block');
  assert.equal(guard({ popupMode: 'block', popupAllow: ['shop.example'] }).decideRequest({ pageUrl: page, url: other, click: null }), 'open');
  // Other sites are not affected, and a sub-domain counts as the same site.
  assert.equal(g.decideRequest({ pageUrl: 'https://news.example/a', url: other, click: null }), 'ask');
  assert.equal(g.decideRequest({ pageUrl: 'https://www.shop.example/x', url: other, click: null }), 'block');
});

test('blocking and allowing a site take it off the other list; both can be undone', () => {
  const g = guard({ popupAllow: ['shop.example'] });
  g.blockSite(page, true);
  assert.deepEqual([g.data.popupBlock, g.data.popupAllow], [['shop.example'], []]);
  assert.ok(g.siteBlocked(page) && !g.siteAllowed(page));
  g.allowSite(page, true);
  assert.deepEqual([g.data.popupBlock, g.data.popupAllow], [[], ['shop.example']]);
  g.blockSite(page, true); g.blockSite(page, false);
  assert.deepEqual(g.data.popupBlock, [], 'back to the general setting');
  g.blockSite('not an address', true);
  g.blockSite('', true);
  assert.deepEqual(g.data.popupBlock, [], 'nothing is added for an address without a site');
  g.blockSite(page, true); g.blockSite(page, true);
  assert.deepEqual(g.data.popupBlock, ['shop.example'], 'no duplicates');
});
