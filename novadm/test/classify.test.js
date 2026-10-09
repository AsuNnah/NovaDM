'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { classify, dedupeKey, mirrorKey } = require('../src/main/media/classify');

const r = (url, headers, extra = {}) => ({ url, method: 'GET', statusCode: 200, resourceType: 'xhr', headers, ...extra });

test('HLS playlists by MIME or extension', () => {
  assert.equal(classify(r('https://a.com/v/master.m3u8', { 'content-type': 'application/vnd.apple.mpegurl' })).kind, 'hls');
  assert.equal(classify(r('https://a.com/v/index.m3u8?t=1', { 'content-type': 'text/plain' })).kind, 'hls');
  assert.equal(classify(r('https://a.com/play', { 'content-type': 'application/x-mpegURL' })).kind, 'hls');
  assert.equal(classify(r('https://a.com/v/page.m3u8', { 'content-type': 'text/html' })), null);
});

test('stream fragments are segments, not downloads', () => {
  const mb = String(2 * 1024 * 1024);
  assert.equal(classify(r('https://c.com/u/seg_00000.mp4', { 'content-type': 'video/mp4', 'content-length': mb })).kind, 'segment');
  assert.equal(classify(r('https://c.com/u/chunk-12.m4s', { 'content-type': 'video/iso.segment' })).kind, 'segment');
  assert.equal(classify(r('https://c.com/u/a.ts', { 'content-type': 'video/mp2t' })).kind, 'segment');
  assert.equal(classify(r('https://c.com/u/init.mp4', { 'content-type': 'video/mp4' })).kind, 'segment');
  // later part of a ranged file fetched by script
  assert.equal(classify(r('https://c.com/movie.mp4', { 'content-type': 'video/mp4', 'content-range': 'bytes 5000000-5999999/900000000' }, { statusCode: 206 })).kind, 'segment');
});

test('direct media played by a <video> element', () => {
  const v = classify(r('https://c.com/movie.mp4', { 'content-type': 'video/mp4', 'content-range': 'bytes 0-1/8800000' }, { statusCode: 206, resourceType: 'media' }));
  assert.equal(v.kind, 'video');
  assert.equal(v.size, 8800000);
  // tiny ad clip ignored
  assert.equal(classify(r('https://ads.com/noop-1s.mp4', { 'content-type': 'video/mp4', 'content-length': '2000' }, { resourceType: 'media' })), null);
  // octet-stream with video extension
  assert.equal(classify(r('https://c.com/dl/file.mkv', { 'content-type': 'application/octet-stream' }, { resourceType: 'media' })).kind, 'video');
  // audio
  assert.equal(classify(r('https://c.com/song.mp3', { 'content-type': 'audio/mpeg', 'content-length': '5000000' }, { resourceType: 'media' })).kind, 'audio');
});

test('large whole file fetched by script is kept', () => {
  const v = classify(r('https://c.com/files/movie.mp4', { 'content-type': 'video/mp4', 'content-length': String(50 * 1024 * 1024) }));
  assert.equal(v.kind, 'video');
});

test('subtitles, but not storyboard thumbnails', () => {
  assert.equal(classify(r('https://c.com/en.vtt', { 'content-type': 'text/vtt' })).kind, 'subtitle');
  assert.equal(classify(r('https://c.com/u/thumbnails.vtt', { 'content-type': 'text/vtt' })), null);
  assert.equal(classify(r('https://c.com/subs/movie.srt', { 'content-type': 'application/octet-stream' })).kind, 'subtitle');
});

test('noise is ignored', () => {
  assert.equal(classify(r('https://c.com/page', { 'content-type': 'text/html' }, { resourceType: 'mainFrame' })), null);
  assert.equal(classify(r('https://c.com/a.png', { 'content-type': 'image/png' })), null);
  assert.equal(classify(r('https://c.com/a.js', { 'content-type': 'application/javascript' })), null);
  assert.equal(classify({ ...r('https://c.com/m.mp4', { 'content-type': 'video/mp4' }), method: 'POST' }), null);
  assert.equal(classify({ ...r('https://c.com/m.mp4', { 'content-type': 'video/mp4' }), statusCode: 404 }), null);
});

test('dedupe and mirror keys', () => {
  assert.equal(dedupeKey('https://a.com/v.mp4?range=0-100&id=7'), 'https://a.com/v.mp4?id=7');
  assert.equal(mirrorKey('https://cdn1.example-cdn.com/u/x/master.m3u8?s=1'), mirrorKey('https://cdn2.example-cdn.com/u/x/master.m3u8?s=1'));
});
