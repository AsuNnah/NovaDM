'use strict';
// Right-click menu for web pages.
const { Menu } = require('electron');
const { copyText } = require('./clipboard-watch');

function isHttp(u) { return /^https?:\/\//i.test(u || ''); }

/**
 * Menu items for a right-click (testable without opening a menu).
 * @param {object} ctx { tab, params, browser, downloads, settings, extensions, addDownload }
 *   addDownload(spec): the "new download" flow (dialog); defaults to adding straight to the list.
 */
function buildContextMenuTemplate({ tab, params, browser, downloads, settings, extensions, addDownload }) {
  const wc = tab.wc;
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
  const download = (url, kind) => {
    const hls = /\.m3u8(\?|#|$)/i.test(url);
    const spec = {
      kind: hls ? 'hls' : 'http', url: hls ? undefined : url, sources: hls ? undefined : [url], playlistUrl: hls ? url : '', name: '',
      headers: { referer: tab.url }, pageUrl: tab.url, tabId: tab.id, incognito: !!tab.incognito,
      category: kind === 'image' ? 'images' : kind === 'video' ? 'video' : kind === 'audio' ? 'music' : undefined,
      convertTs: settings.get('convertTsToMp4') !== false,
    };
    if (addDownload) addDownload(spec, { origin: 'menu' }); else downloads.add(spec);
  };

  if (isHttp(params.linkURL)) {
    items.push(
      { label: 'Open link in new tab', click: () => browser.createTab({ url: params.linkURL, background: true, incognito: tab.incognito }) },
      { label: 'Open link in private tab', click: () => browser.createTab({ url: params.linkURL, incognito: true }) },
      { label: 'Download link with NovaDM', click: () => download(params.linkURL) },
      { label: 'Copy link address', click: () => copyText(params.linkURL) },
    );
  }

  if (params.mediaType === 'image' && isHttp(params.srcURL)) {
    sep();
    items.push(
      { label: 'Open image in new tab', click: () => browser.createTab({ url: params.srcURL, background: true, incognito: tab.incognito }) },
      { label: 'Download image', click: () => download(params.srcURL, 'image') },
      { label: 'Copy image', click: () => wc.copyImageAt(params.x, params.y) },
      { label: 'Copy image address', click: () => copyText(params.srcURL) },
    );
  }

  if ((params.mediaType === 'video' || params.mediaType === 'audio') && isHttp(params.srcURL)) {
    sep();
    const what = params.mediaType === 'video' ? 'video' : 'audio';
    items.push(
      { label: `Download ${what} with NovaDM`, click: () => download(params.srcURL, what) },
      { label: `Copy ${what} address`, click: () => copyText(params.srcURL) },
    );
  }

  if (params.isEditable) {
    sep();
    const f = params.editFlags || {};
    items.push(
      { label: 'Undo', role: 'undo', enabled: !!f.canUndo },
      { label: 'Redo', role: 'redo', enabled: !!f.canRedo },
      { type: 'separator' },
      { label: 'Cut', role: 'cut', enabled: !!f.canCut },
      { label: 'Copy', role: 'copy', enabled: !!f.canCopy },
      { label: 'Paste', role: 'paste', enabled: !!f.canPaste },
      { label: 'Select all', role: 'selectAll' },
    );
  } else if (params.selectionText && params.selectionText.trim()) {
    sep();
    const text = params.selectionText.trim();
    const short = text.length > 30 ? text.slice(0, 30) + '…' : text;
    items.push(
      { label: 'Copy', role: 'copy' },
      { label: `Search for “${short}”`, click: () => browser.createTab({ url: settings.searchUrl(text), incognito: tab.incognito }) },
    );
    if (isHttp(text)) items.push({ label: 'Download this link with NovaDM', click: () => download(text) });
  }

  if (!items.length) {
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
    );
  }

  const extItems = extensions ? extensions.contextMenuItems(wc, params) : [];
  if (extItems.length) { sep(); items.push(...extItems); }

  sep();
  items.push({ label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) });
  return items;
}

function showContextMenu(ctx) {
  Menu.buildFromTemplate(buildContextMenuTemplate(ctx)).popup({ window: ctx.win });
}

module.exports = { showContextMenu, buildContextMenuTemplate };
