'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { extractLinks, expandPattern, hashKind } = require('../src/main/util');

test('links are found in copied text, trailing punctuation dropped, duplicates removed', () => {
  const text = 'Get it here: https://a.example.com/file.zip, or (mirror https://b.example.org/x/file.zip).\nAgain https://a.example.com/file.zip';
  assert.deepEqual(extractLinks(text), ['https://a.example.com/file.zip', 'https://b.example.org/x/file.zip']);
  assert.deepEqual(extractLinks('no links here'), []);
  assert.deepEqual(extractLinks('https://s.example.com/img[01-03].jpg'), ['https://s.example.com/img[01-03].jpg']);
});

test('batch patterns expand numbers (with zero padding) and letters', () => {
  assert.deepEqual(expandPattern('https://s/img[01-03].jpg'), ['https://s/img01.jpg', 'https://s/img02.jpg', 'https://s/img03.jpg']);
  assert.deepEqual(expandPattern('https://s/p[8-11]'), ['https://s/p8', 'https://s/p9', 'https://s/p10', 'https://s/p11']);
  assert.deepEqual(expandPattern('https://s/[a-c].zip'), ['https://s/a.zip', 'https://s/b.zip', 'https://s/c.zip']);
  assert.equal(expandPattern('https://s/[1-3]/[a-b]').length, 6);
  assert.deepEqual(expandPattern('https://s/plain.zip'), ['https://s/plain.zip']);
  assert.equal(expandPattern('https://s/[1-99999]', 500).length, 500);
});

test('checksum kind is recognised by length', () => {
  assert.equal(hashKind('d41d8cd98f00b204e9800998ecf8427e'), 'md5');
  assert.equal(hashKind('da39a3ee5e6b4b0d3255bfef95601890afd80709'), 'sha1');
  assert.equal(hashKind('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855'), 'sha256');
  assert.equal(hashKind('xyz'), '');
});
