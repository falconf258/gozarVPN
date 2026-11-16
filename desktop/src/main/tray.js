'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');

let tray = null;

function resourcesDir() {
  // In dev, __dirname is .../src/main, so resources/ is two levels up.
  // In a packaged app, extraResources places resources/ next to app.asar.
  const packaged = path.join(process.resourcesPath || '', 'resources');
  if (process.resourcesPath && require('fs').existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'resources');
}

function iconFor(status) {
  const name = status === 'connected' ? 'tray-on.png' : status === 'stopped' ? 'tray-off.png' : 'tray-mid.png';
  return path.join(resourcesDir(), name);
}

function createTray({ getState, onConnect, onDisconnect, onShow, onQuit }) {
  const iconDir = resourcesDir();
  let image = nativeImage.createFromPath(path.join(iconDir, 'tray-off.png'));
  if (image.isEmpty()) image = nativeImage.createEmpty();

  tray = new Tray(image);
  tray.setToolTip('GozarVpn');

  const rebuild = () => {
    const state = getState();
    const statusLabel = {
      stopped: 'قطع',
      starting: 'در حال شروع…',
      scanning: 'در حال اسکن…',
      'gateway-selected': 'در حال اتصال…',
      connected: state.tun ? 'متصل (TUN)' : `متصل (${state.address || ''})`,
      reconnecting: 'اتصال مجدد…',
      error: 'خطا'
    }[state.status] || state.status;

    const menu = Menu.buildFromTemplate([
      { label: `وضعیت: ${statusLabel}`, enabled: false },
      { type: 'separator' },
      { label: 'اتصال', enabled: !state.running, click: onConnect },
      { label: 'قطع اتصال', enabled: state.running, click: onDisconnect },
      { type: 'separator' },
      { label: 'باز کردن GozarVpn', click: onShow },
      { label: 'خروج', click: onQuit }
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(`GozarVpn — ${statusLabel}`);

    const img = nativeImage.createFromPath(iconFor(state.status));
    if (!img.isEmpty()) tray.setImage(img);
  };

  tray.on('click', onShow);
  rebuild();

  return {
    refresh: rebuild,
    destroy: () => tray && tray.destroy()
  };
}

module.exports = { createTray };
