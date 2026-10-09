'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const { app } = require('electron');
const { JsonStore } = require('./store');

const SEARCH_ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=%s' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=%s' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/do/search?q=%s' },
  yandex: { name: 'Yandex', url: 'https://yandex.com/search/?text=%s' },
};

function defaults() {
  return {
    // General
    theme: 'system', // system | dark | light
    searchEngine: 'google',
    homepage: 'novadm://newtab',
    restoreTabs: true,
    askBeforeExternalApps: true,
    secureDns: 'cloudflare', // off | cloudflare | google | quad9 | adguard | custom
    secureDnsCustom: '',

    // Downloads
    downloadDir: path.join(app.getPath('downloads'), 'NovaDM'),
    categoryFolders: true,
    connections: 8, // parts per download (1-32)
    maxActive: 3,
    speedLimitKBps: 0, // 0 = unlimited
    retries: 10,
    retryDelaySec: 3,
    timeoutSec: 30,
    minSplitKB: 512,
    downloadTransport: 'auto', // auto | browser | direct (see transport.js)
    skipEditor: false, // start downloads without the "new download" dialog
    autoResume: false, // resume unfinished downloads when NovaDM starts
    notifyOnComplete: true,
    queues: [{ id: 'main', name: 'Main', maxActive: 0, schedule: null }], // see scheduler.js
    afterAllDone: 'nothing', // nothing | exit | sleep | shutdown (once, then back to nothing)

    // Background and safety
    closeToTray: 'downloading', // downloading | always | never
    startWithWindows: false,
    preventSleep: true, // keep the PC awake while downloading
    scanDownloads: 'programs', // programs (programs + archives) | all | off
    markOfTheWeb: true,

    // After a download
    extractArchives: false, // unpack archives into a folder next to them
    deleteAfterExtract: false,
    afterProgram: '', // a program to start for each finished download
    afterArgs: '"{file}"', // its arguments: {file} {folder} {name} {url} {page}
    webhookUrl: '', // POST a JSON note when a download finishes or fails

    // Rules
    categoryRules: [], // [{ by: 'type' | 'site' | 'text', value, category, folder }]
    siteSettings: [], // [{ site, connections, userAgent, speedLimitKBps, user, passEnc }]

    // Appearance
    accent: '#5b7cfa',
    uiScale: '100', // size of NovaDM's own screens, in percent
    showBookmarksBar: true, // shown when there are bookmarks

    // Tabs and pages
    discardTabsAfter: '30', // unload background tabs after this many idle minutes ('0' = never)

    // Privacy and speed
    blockThirdPartyCookies: true, // Chromium's own switch, applied when NovaDM starts
    clearCookiesOnExit: false,
    clearCacheOnExit: false,
    clearHistoryOnExit: false,
    httpsUpgrade: true, // open http:// links over HTTPS when the site supports it
    debounceLinks: true, // skip known tracking redirects (google.com/url?q=…)
    stripTrackingParams: true, // remove fbclid, gclid… from addresses
    deAmp: true, // open the publisher's page instead of its Google AMP copy
    ffmpegPath: '', // the user's own ffmpeg.exe (empty: NovaDM's copy, if installed)
    ytdlpPath: '', // the user's own yt-dlp.exe

    // Torrents (aria2)
    aria2Path: '', // the user's own aria2c.exe
    torrentAskFiles: true, // choose the files of a torrent before it downloads
    torrentSeedRatio: 1, // stop seeding at this upload/download ratio (0 = no ratio limit)
    torrentSeedMinutes: 60, // ...or after this many minutes (0 = no time limit)
    torrentUploadKBps: 0, // upload limit (0 = none)
    torrentPort: 0, // listening port (0 = aria2's default range)
    torrentTrackerList: true, // add an up-to-date list of public trackers
    openTorrentFiles: true, // .torrent links open in NovaDM

    // Integration
    apiEnabled: false, // local API for the browser extension and scripts (127.0.0.1 only, with a key)
    apiPort: 9614,
    apiKey: '',
    magnetHandler: false, // open magnet: links from other apps in NovaDM
    siteExtensionsOff: [], // installed site extensions that are switched off

    // Proxy (browsing and downloads): system | none | manual | pac
    proxyMode: 'system',
    proxyType: 'http', // http | https | socks4 | socks5
    proxyServer: '', // host:port
    proxyBypass: '<local>',
    proxyPac: '',
    proxyUser: '',
    proxyPassEnc: '', // encrypted with Windows DPAPI (safeStorage)

    // Auto downloader
    clipboardWatch: true,
    clipboardExtensions: 'zip rar 7z exe msi apk iso mp4 mkv avi webm mov mp3 m4a flac pdf epub torrent m3u8',
    pageTitleNames: true,
    convertTsToMp4: true,
    minMediaKB: 300, // ignore smaller video/audio responses picked up by the sniffer

    // Ad blocker
    adblock: true,
    adblockWhitelist: [], // sites where ad blocking is off
    adblockUpdatedAt: 0,

    // Pop-ups
    popupMode: 'ask', // ask | block | allow
    popupAllow: [], // sites allowed to open pop-ups

    // Site permissions: { [origin]: { media, geolocation, notifications, ... : true|false } }
    sitePermissions: {},
  };
}

class Settings extends EventEmitter {
  constructor() {
    super();
    this.store = new JsonStore(path.join(app.getPath('userData'), 'settings.json'), {});
    this.data = { ...defaults(), ...this.store.data };
    // Profiles from "Swoop" (before 0.2.0) kept the old default folder name: follow the rename.
    if (this.data.downloadDir === path.join(app.getPath('downloads'), 'Swoop')) this.data.downloadDir = defaults().downloadDir;
    this.store.data = this.data;
  }

  get(key) { return this.data[key]; }

  all() {
    const { proxyPassEnc, ...rest } = this.data;
    // Site sign-in passwords stay here (encrypted); the settings page only learns that one is set.
    rest.siteSettings = (rest.siteSettings || []).map(({ passEnc, ...s }) => ({ ...s, hasPassword: !!passEnc }));
    return { ...rest, proxyHasPassword: !!proxyPassEnc, searchEngines: SEARCH_ENGINES };
  }

  set(patch) {
    const changed = {};
    if (patch && Array.isArray(patch.siteSettings)) {
      // A site list saved from the settings page keeps the stored passwords of its sites.
      const old = new Map((this.data.siteSettings || []).map((s) => [String(s.site).toLowerCase(), s.passEnc]));
      patch = { ...patch, siteSettings: patch.siteSettings.map(({ hasPassword, passEnc, ...s }) => ({ ...s, passEnc: passEnc !== undefined ? passEnc : old.get(String(s.site).toLowerCase()) || '' })) };
    }
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in defaults())) continue;
      if (JSON.stringify(this.data[k]) === JSON.stringify(v)) continue;
      this.data[k] = v;
      changed[k] = v;
    }
    if (this.data.connections < 1) this.data.connections = 1;
    if (this.data.connections > 32) this.data.connections = 32;
    if (this.data.maxActive < 1) this.data.maxActive = 1;
    if (Object.keys(changed).length) {
      this.store.save();
      this.emit('change', changed);
    }
    return changed;
  }

  searchUrl(q) {
    const eng = SEARCH_ENGINES[this.data.searchEngine] || SEARCH_ENGINES.google;
    return eng.url.replace('%s', encodeURIComponent(q));
  }

  flush() { this.store.flush(); }
}

module.exports = { Settings, SEARCH_ENGINES };
