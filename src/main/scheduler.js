'use strict';
// Download queues with schedules. Each queue: { id, name, maxActive (0 = the global setting),
// schedule: { enabled, start: 'HH:MM', stop: 'HH:MM' | '', days: [0..6] (0 = Sunday) } }.
// Inside its time window a queue's downloads run; when the window ends they are paused and wait
// for the next one. Without a stop time a queue just starts at its start time.
const { EventEmitter } = require('events');

const MAIN_QUEUE = { id: 'main', name: 'Main', maxActive: 0, schedule: null };

function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/** Is `date` inside the schedule's window? Overnight windows (22:00-06:00) count from the start day. */
function isInWindow(schedule, date = new Date()) {
  if (!schedule || !schedule.enabled) return false;
  const start = minutesOf(schedule.start);
  if (start == null) return false;
  const stop = minutesOf(schedule.stop);
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  const now = date.getHours() * 60 + date.getMinutes();
  const today = date.getDay();
  const yesterday = (today + 6) % 7;
  if (stop == null || stop === start) return days.includes(today) && now >= start; // no stop: rest of the day
  if (start < stop) return days.includes(today) && now >= start && now < stop;
  // Overnight: today's evening part, or the early-morning tail of yesterday's window.
  return (days.includes(today) && now >= start) || (days.includes(yesterday) && now < stop);
}

/** Next start of the schedule after `date` (a Date), or null. */
function nextStart(schedule, date = new Date()) {
  if (!schedule || !schedule.enabled) return null;
  const start = minutesOf(schedule.start);
  if (start == null) return null;
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [0, 1, 2, 3, 4, 5, 6];
  for (let add = 0; add <= 7; add++) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + add, Math.floor(start / 60), start % 60, 0, 0);
    if (d > date && days.includes(d.getDay())) return d;
  }
  return null;
}

function normalizeQueues(list) {
  const out = [];
  const seen = new Set();
  for (const q of Array.isArray(list) ? list : []) {
    if (!q || !q.id || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push({
      id: String(q.id), name: String(q.name || 'Queue').slice(0, 40), maxActive: Math.max(0, Math.min(10, Number(q.maxActive) || 0)),
      schedule: q.schedule ? {
        enabled: !!q.schedule.enabled, start: String(q.schedule.start || ''), stop: String(q.schedule.stop || ''),
        days: (q.schedule.days || []).map(Number).filter((d) => d >= 0 && d <= 6),
      } : null,
    });
  }
  if (!seen.has('main')) out.unshift({ ...MAIN_QUEUE });
  return out;
}

class Scheduler extends EventEmitter {
  /** ctx: { settings, downloads, now (tests) } */
  constructor({ settings, downloads, now }) {
    super();
    this.settings = settings;
    this.downloads = downloads;
    this.now = now || (() => new Date());
    this.inside = new Map(); // queue id -> was inside its window at the last check
    this.timer = null;
  }

  queues() { return normalizeQueues(this.settings.get('queues')); }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), 20000);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  // Start a queue when its window opens (also when NovaDM starts inside a window), pause it when the
  // window closes.
  tick() {
    const now = this.now();
    for (const q of this.queues()) {
      if (!q.schedule || !q.schedule.enabled) { this.inside.delete(q.id); continue; }
      const inside = isInWindow(q.schedule, now);
      const was = this.inside.get(q.id);
      if (inside && was !== true) { this.downloads.startQueue(q.id); this.emit('started', q); }
      if (!inside && was === true && minutesOf(q.schedule.stop) != null) { this.downloads.stopQueue(q.id); this.emit('stopped', q); }
      this.inside.set(q.id, inside);
    }
  }

  /** Should a download added to this queue wait for the schedule? */
  waitsForSchedule(queueId) {
    const q = this.queues().find((x) => x.id === queueId);
    return !!(q && q.schedule && q.schedule.enabled && !isInWindow(q.schedule, this.now()));
  }
}

module.exports = { Scheduler, isInWindow, nextStart, normalizeQueues, minutesOf, MAIN_QUEUE };
