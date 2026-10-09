'use strict';
// NovaDM in the background:
//  - Tray icon (speed in the tooltip; open, pause all, resume all, quit).
//  - Closing the window keeps NovaDM running in the tray while downloads run (or always / never).
//  - Start with Windows (in the tray), keep the PC awake while downloading.
//  - "When all downloads finish": close NovaDM, sleep or shut down, after a 60 s countdown that can
//    be cancelled. NOVADM_DRYRUN_POWER=<file> (tests) writes the action to a file instead.
const fs = require('fs');
const path = require('path');
const { app, Tray, Menu, nativeImage, powerSaveBlocker } = require('electron');
const { execFile } = require('child_process');

const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');

function fmtSpeed(b) {
  if (!(b > 0)) return '';
  const u = ['B/s', 'KB/s', 'MB/s', 'GB/s']; let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
}

class Background {
  /** ctx: { settings, downloads, getWindow, showWindow, notify, sendUI, setPanel } */
  constructor(ctx) {
    Object.assign(this, ctx);
    this.tray = null;
    this.quitting = false;
    this.blocker = null;
    this.toldAboutTray = false;
    this.countdown = null; // { action, endsAt, timer }
  }

  start() {
    app.on('before-quit', () => { this.quitting = true; });
    this.updateLoginItem();
    this.settings.on('change', (c) => {
      if ('startWithWindows' in c) this.updateLoginItem();
      if ('closeToTray' in c) this.updateTray();
    });
    this.downloads.on('changed', () => { this.updateTray(); this.updateAwake(); });
    this.downloads.on('all-done', () => this.onAllDone());
    this.updateTray();
    setInterval(() => this.updateTooltip(), 2000);
  }

  // ---- window close -----------------------------------------------------------------------------

  /** Should closing the window hide it to the tray instead of quitting? */
  keepRunningOnClose() {
    if (this.quitting) return false;
    const mode = this.settings.get('closeToTray') || 'downloading';
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return this.downloads.activeSummary().active > 0 || this.downloads.queue.length > 0;
  }

  hideToTray() {
    const win = this.getWindow();
    if (!win) return;
    this.updateTray(true);
    win.hide();
    if (!this.toldAboutTray) {
      this.toldAboutTray = true;
      this.notify({ title: 'NovaDM is still downloading', body: 'It keeps running in the system tray. Right-click the tray icon to quit.', silent: true, onClick: () => this.showWindow() });
    }
  }

  // ---- tray ---------------------------------------------------------------------------------------

  updateTray(force = false) {
    const mode = this.settings.get('closeToTray') || 'downloading';
    const win = this.getWindow();
    const want = force || mode === 'always' || (mode !== 'never' && (this.downloads.activeSummary().active > 0 || (win && !win.isVisible())));
    if (want && !this.tray) {
      let img = nativeImage.createFromPath(ICON);
      if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
      this.tray = new Tray(img);
      this.tray.setToolTip('NovaDM');
      this.tray.on('click', () => this.showWindow());
      this.tray.on('double-click', () => this.showWindow());
      this.tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open NovaDM', click: () => this.showWindow() },
        { type: 'separator' },
        { label: 'Pause all downloads', click: () => this.downloads.pauseAll() },
        { label: 'Resume all downloads', click: () => this.downloads.resumeAll() },
        { type: 'separator' },
        { label: 'Quit NovaDM', click: () => { this.quitting = true; app.quit(); } },
      ]));
      this.updateTooltip();
    } else if (!want && this.tray && (!win || win.isVisible())) {
      this.tray.destroy();
      this.tray = null;
    }
  }

  updateTooltip() {
    if (!this.tray) return;
    const s = this.downloads.activeSummary();
    const text = s.active ? `NovaDM: ${s.active} downloading${s.speed ? ', ' + fmtSpeed(s.speed) : ''}` : 'NovaDM';
    try { this.tray.setToolTip(text); } catch {}
  }

  // ---- start with Windows, keep awake -------------------------------------------------------------

  updateLoginItem() {
    if (process.platform !== 'win32' || process.env.NOVADM_USERDATA) return; // never from test runs
    const open = !!this.settings.get('startWithWindows');
    // The portable build runs from a temporary folder: register the portable .exe itself.
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
    try { app.setLoginItemSettings({ openAtLogin: open, path: exe, args }); } catch (e) { console.error('login item', e.message); }
  }

  updateAwake() {
    const want = this.settings.get('preventSleep') !== false && this.downloads.activeSummary().active > 0;
    if (want && this.blocker == null) this.blocker = powerSaveBlocker.start('prevent-app-suspension');
    else if (!want && this.blocker != null) { try { powerSaveBlocker.stop(this.blocker); } catch {} this.blocker = null; }
  }

  // ---- when all downloads finish ------------------------------------------------------------------

  onAllDone() {
    const action = this.settings.get('afterAllDone') || 'nothing';
    if (action === 'nothing' || this.countdown) return;
    const seconds = Number(process.env.NOVADM_AFTERDONE_SECONDS) || 60;
    this.countdown = { action, endsAt: Date.now() + seconds * 1000 };
    this.countdown.timer = setTimeout(() => this.runAction(), seconds * 1000);
    const label = { exit: 'NovaDM will close', sleep: 'The computer will go to sleep', shutdown: 'The computer will shut down' }[action];
    this.showWindow();
    this.setPanel(true);
    this.sendUI('afterdone-ask', { action, label, seconds });
    this.notify({ title: 'All downloads finished', body: `${label} in ${seconds} seconds. Open NovaDM to cancel.`, onClick: () => this.showWindow() });
  }

  cancelCountdown() {
    if (!this.countdown) return;
    clearTimeout(this.countdown.timer);
    this.countdown = null;
  }

  runAction(now = false) {
    if (!this.countdown) return;
    const { action } = this.countdown;
    this.cancelCountdown();
    if (!now) { this.setPanel(false); this.sendUI('close-panel', {}); }
    // One-shot: the next batch of downloads doesn't shut the computer down again.
    this.settings.set({ afterAllDone: 'nothing' });
    powerAction(action);
  }
}

function powerAction(action) {
  const dry = process.env.NOVADM_DRYRUN_POWER;
  if (dry) { try { fs.appendFileSync(dry, action + '\n'); } catch {} return; }
  if (action === 'exit') { app.quit(); return; }
  if (process.platform !== 'win32') return;
  if (action === 'shutdown') {
    // Normal shutdown: apps with unsaved work can still stop it.
    execFile('shutdown.exe', ['/s', '/t', '0'], { windowsHide: true }, () => {});
  } else if (action === 'sleep') {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)'],
    { windowsHide: true }, () => {});
  }
}

module.exports = { Background, powerAction, fmtSpeed };
