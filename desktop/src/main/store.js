'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const Store = require('electron-store');

// electron-store already writes atomically; this keeps a last-good copy so a
// damaged file (disk error, manual edit) restores configs instead of losing them.
const file = path.join(app.getPath('userData'), 'gozarvpn-config.json');
const backup = `${file}.bak`;
const readsAsJson = (p) => { try { JSON.parse(fs.readFileSync(p, 'utf8')); return true; } catch { return false; } };
if (fs.existsSync(file) && !readsAsJson(file) && fs.existsSync(backup) && readsAsJson(backup)) {
  fs.copyFileSync(file, `${file}.broken-${Date.now()}`);
  fs.copyFileSync(backup, file);
}

const store = new Store({
  name: 'gozarvpn-config',
  defaults: {
    activeProfile: 'default',
    profiles: {
      default: {
        AETHER_SOCKS: '127.0.0.1:1819',
        AETHER_PROTOCOL: 'masque',
        AETHER_SCAN: 'balanced',
        AETHER_NOIZE: 'balanced',
        AETHER_IP: 'v4',
        AETHER_QUICK_RECONNECT: true,
        AETHER_LOG_LEVEL: 'info'
      }
    },
    ui: {
      launchOnStartup: false,
      startMinimized: false,
      closeToTray: true,
      closeAction: 'ask', // 'ask' | 'tray' | 'quit' — what the window's X does,
      autoSystemProxy: true,
      engine: 'aether', // 'aether' | 'singbox'
      socksOnlySystemProxy: false,
      tunMode: false, // true = Wintun adapter instead of system proxy
      tunDns: '1.1.1.1'
    },
    v2rayConfigs: {},
    activeV2rayConfig: null,
    v2rayGroups: {}, // one entry per imported subscription / paste / .conf file
    v2rayTestResults: {}, // last ping/timeout per config id, survives restarts
    mihomoProfiles: {},
    activeMihomoProfile: null
  }
});

try { if (readsAsJson(file)) fs.copyFileSync(file, backup); } catch { /* backup is best-effort */ }

module.exports = store;
