'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Scheduler, isInWindow, nextStart, normalizeQueues } = require('../src/main/scheduler');

// Fri 9 Oct 2026 at the given time (getDay() === 5).
const at = (hh, mm = 0, day = 9) => new Date(2026, 9, day, hh, mm, 0);

test('daytime window with days of the week', () => {
  const s = { enabled: true, start: '09:00', stop: '17:30', days: [1, 2, 3, 4, 5] };
  assert.equal(isInWindow(s, at(8, 59)), false);
  assert.equal(isInWindow(s, at(9, 0)), true);
  assert.equal(isInWindow(s, at(17, 29)), true);
  assert.equal(isInWindow(s, at(17, 30)), false);
  assert.equal(isInWindow(s, at(12, 0, 10)), false, 'Saturday is not a scheduled day');
  assert.equal(isInWindow({ ...s, enabled: false }, at(12)), false);
});

test('overnight window belongs to the day it starts', () => {
  const s = { enabled: true, start: '23:00', stop: '06:00', days: [5] }; // Friday night
  assert.equal(isInWindow(s, at(23, 30)), true);
  assert.equal(isInWindow(s, at(3, 0, 10)), true, 'Saturday 03:00 is still Friday night');
  assert.equal(isInWindow(s, at(3, 0, 9)), false, 'Friday 03:00 belongs to Thursday night');
  assert.equal(isInWindow(s, at(6, 0, 10)), false);
});

test('without a stop time the queue runs from the start time on', () => {
  const s = { enabled: true, start: '01:30', stop: '', days: [] };
  assert.equal(isInWindow(s, at(1, 29)), false);
  assert.equal(isInWindow(s, at(1, 30)), true);
  assert.equal(isInWindow(s, at(23, 59)), true);
});

test('next start skips days that are not scheduled', () => {
  const s = { enabled: true, start: '02:00', stop: '05:00', days: [1] }; // Mondays
  const n = nextStart(s, at(12, 0)); // Friday noon -> Monday 12 Oct 02:00
  assert.equal(n.getDay(), 1);
  assert.equal(n.getDate(), 12);
  assert.equal(n.getHours(), 2);
});

test('queues always include Main and drop broken entries', () => {
  const q = normalizeQueues([{ id: 'night', name: 'Night', maxActive: 99, schedule: { enabled: 1, start: '01:00', days: ['1', 9] } }, { name: 'no id' }]);
  assert.deepEqual(q.map((x) => x.id), ['main', 'night']);
  assert.equal(q[1].maxActive, 10);
  assert.deepEqual(q[1].schedule.days, [1]);
});

test('the scheduler starts a queue when its window opens and pauses it when it closes', () => {
  let clock = at(0, 59);
  const calls = [];
  const settings = { get: () => [{ id: 'night', name: 'Night', schedule: { enabled: true, start: '01:00', stop: '05:00', days: [] } }] };
  const downloads = { startQueue: (id) => calls.push(['start', id]), stopQueue: (id) => calls.push(['stop', id]) };
  const s = new Scheduler({ settings, downloads, now: () => clock });
  s.tick();
  assert.equal(s.waitsForSchedule('night'), true);
  assert.equal(s.waitsForSchedule('main'), false);
  clock = at(1, 0); s.tick();
  clock = at(3, 0); s.tick(); // still inside: nothing new
  clock = at(5, 0); s.tick();
  assert.deepEqual(calls, [['start', 'night'], ['stop', 'night']]);
});

test('starting NovaDM in the middle of a window starts the queue', () => {
  const calls = [];
  const settings = { get: () => [{ id: 'q', name: 'Q', schedule: { enabled: true, start: '10:00', stop: '18:00', days: [] } }] };
  const s = new Scheduler({ settings, downloads: { startQueue: (id) => calls.push(id), stopQueue() {} }, now: () => at(12) });
  s.tick();
  assert.deepEqual(calls, ['q']);
});
