'use strict';
// Did NovaDM's last session finish closing? Windows ends apps at shutdown or sign-out without a normal quit, so the
// "when NovaDM closes, clear…" steps may not have run; the next start runs them then (AU-11).

/** At start: true when the last session didn't finish closing. From now on this session counts as not closed. */
function startSession(settings) {
  const missed = settings.get('exitClean') === false; // undefined: first start, or an older version closed it
  settings.set({ exitClean: false });
  settings.flush();
  return missed;
}

/** At the end of a normal quit, after the clear-on-exit steps. */
function endSession(settings) {
  settings.set({ exitClean: true });
  settings.flush();
}

module.exports = { startSession, endSession };
