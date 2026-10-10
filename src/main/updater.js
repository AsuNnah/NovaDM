'use strict';
// Automatic updates for the installed NovaDM, like Chrome: a new version downloads in the background
// from the GitHub release, its SHA-512 is checked against the release's latest.yml, and it installs
// when the user clicks "Restart to update" or the next time NovaDM closes. The portable version and
// runs from source keep the "update available" notice (updates.js).
const { app } = require('electron');

const canAutoUpdate = () => app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE;

/** onState({ version, phase: 'downloading' | 'ready' | 'error', percent?, error? }) */
function createUpdater({ onState }) {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;
  let state = null;
  const set = (s) => { state = s; onState(s); };
  autoUpdater.on('update-available', (i) => set({ version: i.version, phase: 'downloading', percent: 0 }));
  autoUpdater.on('download-progress', (p) => { if (state) set({ ...state, percent: Math.round(p.percent) }); });
  autoUpdater.on('update-downloaded', (i) => set({ version: i.version, phase: 'ready' }));
  // A failed download (or a file that doesn't match its checksum) is never installed.
  autoUpdater.on('error', (e) => { if (state && state.phase !== 'ready') set({ ...state, phase: 'error', error: String(e && e.message || e).slice(0, 200) }); });
  return {
    autoUpdater,
    check: () => autoUpdater.checkForUpdates().catch(() => null),
    // Silent install, then NovaDM starts again (the tabs come back if "Open the tabs from last time" is on).
    install: () => { if (state && state.phase === 'ready') autoUpdater.quitAndInstall(true, true); },
    get state() { return state; },
  };
}

module.exports = { canAutoUpdate, createUpdater };
