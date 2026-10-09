'use strict';
// Windows notifications (toasts). Kept referenced until closed, or click handlers can be lost.
const path = require('path');
const { Notification } = require('electron');

const ICON = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const live = new Set();

/** Show a notification. onClick runs when the user clicks it. */
function notify({ title, body, onClick, silent = false }) {
  try {
    if (!Notification.isSupported()) return null;
    const n = new Notification({ title, body: String(body || '').slice(0, 250), icon: ICON, silent });
    live.add(n);
    const drop = () => live.delete(n);
    n.on('click', () => { drop(); if (onClick) onClick(); });
    n.on('close', drop);
    n.on('failed', drop);
    n.show();
    return n;
  } catch {
    return null;
  }
}

module.exports = { notify };
