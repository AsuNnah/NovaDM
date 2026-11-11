'use strict';
// SEC-106 (1.8.0): sites come from the Public Suffix List (with its private part), not a hand-kept list.
const test = require('node:test');
const assert = require('node:assert');
const { siteOf } = require('../src/main/util');

test('SEC-106: siteOf groups by the Public Suffix List', () => {
  // Shared hosts the old short list didn't have are now one site per name.
  assert.strictEqual(siteOf('https://a.s3.amazonaws.com/x'), 'a.s3.amazonaws.com');
  assert.notStrictEqual(siteOf('https://a.s3.amazonaws.com/'), siteOf('https://b.s3.amazonaws.com/'));
  assert.strictEqual(siteOf('https://shop.example.co.uk/'), 'example.co.uk');
  assert.strictEqual(siteOf('https://a.b.example.com.au/'), 'example.com.au');
  assert.strictEqual(siteOf('https://deep.sub.example.org/'), 'example.org');
  assert.strictEqual(siteOf('https://xn--80ak6aa92e.com/'), 'xn--80ak6aa92e.com');
  // Its own site: IP addresses (v4 and v6), localhost, a bare public suffix, a single label.
  assert.strictEqual(siteOf('http://[::1]:8080/'), '[::1]');
  assert.strictEqual(siteOf('http://192.168.1.1/'), '192.168.1.1');
  assert.strictEqual(siteOf('https://co.uk/'), 'co.uk');
  assert.strictEqual(siteOf('http://intranet/'), 'intranet');
});
