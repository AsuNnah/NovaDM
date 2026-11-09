'use strict';
// REQ-311 (1.8.0): My filters. Rules apply on Save, survive a list update, never go into the engine cache, and a
// too-big text is refused. Lines that are not rules are reported.
const test = require('node:test');
const assert = require('node:assert');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');
const { AdBlocker, readMyFilters, myFiltersTooBig } = require('../src/main/adblock');

test('REQ-311: rules counted, comments skipped, bad lines reported by number', () => {
  const r = readMyFilters('! my rules\n||ads.test^\n\n##.banner\n||ads.test^\n##\n');
  assert.deepStrictEqual(r.rules, ['||ads.test^', '##.banner']);
  assert.deepStrictEqual(r.bad, [{ line: 6, text: '##' }]);
  assert.strictEqual(myFiltersTooBig('x\n'.repeat(1999)), '', '2,000 lines fit');
  assert.match(myFiltersTooBig('x\n'.repeat(2000)), /2,000 lines/);
  assert.match(myFiltersTooBig('x'.repeat(64 * 1024 + 1)), /64 KB/);
  assert.match(myFiltersTooBig(5), /text/);
});

test('REQ-311: applied at once, removed on change, kept through a new engine, not in the cache', () => {
  const data = { myFilters: '||ads.test^' };
  const b = Object.create(AdBlocker.prototype);
  Object.assign(b, { settings: { get: (k) => data[k] }, myApplied: [], myStatus: null, engine: ElectronBlocker.parse('') });
  const blocked = (url) => !!b.engine.match(fromElectronDetails({ id: 1, url, resourceType: 'script', referrer: 'https://page.test/' })).match;
  const cache = b.engine.serialize();
  assert.deepStrictEqual(b.applyMyFilters(), { rules: 1, bad: [], more: 0 });
  assert.ok(blocked('https://ads.test/x.js'), 'blocked at once');
  assert.ok(!ElectronBlocker.deserialize(cache).match(fromElectronDetails({ id: 2, url: 'https://ads.test/x.js', resourceType: 'script', referrer: 'https://page.test/' })).match, 'the cache built before has no user rules');
  data.myFilters = '||other.test^';
  b.applyMyFilters();
  assert.ok(!blocked('https://ads.test/x.js') && blocked('https://other.test/y.js'), 'the old rule went, the new one is on');
  b.engine = ElectronBlocker.parse(''); // a list update brings a new engine
  b.applyMyFilters(true);
  assert.ok(blocked('https://other.test/y.js'), 'still applied after a list update');
});
