'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalize, kindForUrl } = require('../src/main/grabber');

test('kinds come from the file extension, with tag hints for extensionless media', () => {
  assert.equal(kindForUrl('https://x.com/a/photo.JPG'), 'image');
  assert.equal(kindForUrl('https://x.com/a/movie.mkv?x=1'), 'video');
  assert.equal(kindForUrl('https://x.com/song.flac'), 'audio');
  assert.equal(kindForUrl('https://x.com/doc.pdf'), 'document');
  assert.equal(kindForUrl('https://x.com/pack.7z'), 'archive');
  assert.equal(kindForUrl('https://x.com/setup.exe'), 'program');
  assert.equal(kindForUrl('https://cdn.x.com/image?id=42', 'image'), 'image');
  assert.equal(kindForUrl('https://x.com/about', 'link'), null); // a web page, not a file
});

test('normalize keeps downloadable items, de-duplicates and names them', () => {
  const raw = [
    { url: 'https://x.com/i/a.png', kind: 'image', w: 800, h: 600, from: 'img' },
    { url: 'https://x.com/i/a.png#zoom', kind: 'image', w: 0, h: 0, from: 'link' },
    { url: 'https://x.com/files/My%20Report.pdf', kind: 'link', alt: 'Report', from: 'link' },
    { url: 'https://x.com/contact', kind: 'link', from: 'link' },
  ];
  const out = normalize(raw, 'https://x.com/page', 'Page', 3);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, 'https://x.com/i/a.png');
  assert.equal(out[0].w, 800);
  assert.equal(out[1].kind, 'document');
  assert.equal(out[1].name, 'My Report.pdf');
  assert.equal(out[1].pageUrl, 'https://x.com/page');
  assert.equal(out[1].tabId, 3);
});
