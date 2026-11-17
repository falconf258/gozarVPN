'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const store = require('./store');
const { CoreManager } = require('./coreManager');
const { CoreUpdater } = require('./coreUpdater');
const { SystemProxy } = require('./systemProxy');
const { IpScanner, parseCandidatesFile } = require('./ipScanner');
const { SingboxManager } = require('./singboxManager');
const { SingboxUpdater } = require('./singboxUpdater');
const { TunManager, isElevated } = require('./tunManager');
const { MihomoManager } = require('./mihomoManager');
const { BinaryUpdater } = require('./binaryUpdater');
const { TorManager, TorBundle, BridgeStore, MODES: TOR_MODES } = require('./torManager');
const { parseSubscription } = require('./vpnLinkParser');
const { registerWarp } = require('./warp');
const { httpsGetText, tryDirectThenTunnel, downloadToFile } = require('./githubDownload');
const { testOutbound } = require('./singboxTester');
const { testMany, tunInterceptsTcp } = require('./singboxBatchTester');
const { verifyTunnel } = require('./connectivityCheck');
const { SelfUpdater, RELEASES_PAGE } = require('./selfUpdate');
const { createTray } = require('./tray');
const { ENV_SCHEMA } = require('./constants');
const psiphon = require('./psiphon');
const { LiveStats, exitInfo } = require('./liveStats');
const { KillSwitch, findExes } = require('./killSwitch');
const openvpn = require('./openvpn');

const isWindows = process.platform === 'win32';
const coreDir = path.join(app.getPath('userData'), 'core');
const scannerDir = path.join(app.getPath('userData'), 'scanner');
const singboxBinDir = path.join(app.getPath('userData'), 'singbox-bin');
const singboxConfigDir = path.join(app.getPath('userData'), 'singbox');
const bundledExe = path.join(process.resourcesPath || path.join(__dirname, '..', '..', 'resources'), 'core', 'aether.exe');

// Prevent multiple GozarVpn instances: without this, opening the app while
// it's already running (e.g. minimized to the tray) launches a second,
// completely independent copy — which would try to bind the same SOCKS/HTTP
// ports and stomp on the first instance's system-proxy state. Must be
// requested before app.whenReady(); if we don't get the lock, someone else
// already has it, so this instance just quits and the original one handles
// getting focused via the 'second-instance' event below.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

const coreManager = new CoreManager();
// Psiphon runs inside the same Aether core, in its own process and with its own state
const psiphonManager = new CoreManager();
const liveStats = new LiveStats();
const coreUpdater = new CoreUpdater(coreDir);
const ipScanner = new IpScanner(scannerDir);
const singboxManager = new SingboxManager(singboxConfigDir);
const singboxUpdater = new SingboxUpdater(singboxBinDir);
const mihomoManager = new MihomoManager(path.join(app.getPath('userData'), 'mihomo'));
const mihomoUpdater = new BinaryUpdater({
  dir: path.join(app.getPath('userData'), 'mihomo-bin'),
  owner: 'MetaCubeX',
  repo: 'mihomo',
  // "compatible" = no AVX2 requirement, runs on every x64 CPU.
  assetPattern: /^mihomo-windows-amd64-compatible-v[\d.]+\.zip$/,
  exeName: 'mihomo.exe'
});
const torManager = new TorManager(path.join(app.getPath('userData'), 'tor'));
const torBundle = new TorBundle(path.join(app.getPath('userData'), 'tor-bin'));
const torBridges = new BridgeStore(path.join(app.getPath('userData'), 'tor', 'bridges'), path.join(__dirname, 'bridges-seed'));
const tunManager = new TunManager(path.join(app.getPath('userData'), 'tun'));
// system-proxy mode with Iran routing: a local sing-box router in front of the engine
const routerManager = new TunManager(path.join(app.getPath('userData'), 'router'));
// OpenVPN: the official openvpn.exe builds its own system tunnel (no SOCKS port, no TUN/proxy of ours)
const openvpnRunDir = path.join(app.getPath('userData'), 'openvpn', 'run');
const openvpnManager = new openvpn.OpenVpnManager(openvpnRunDir);
let openvpnExe = null;
const routingRules = require('./routing');
const awg = require('./awg');
// AmneziaWG entries: wireproxy-awg serves a local SOCKS port that sing-box then uses as its outbound
const awgHelper = new awg.AwgHelper((level, text) => singboxManager.log(level, text));
const rulesUserDir = path.join(app.getPath('userData'), 'rules');
const ROUTER_ADDR = '127.0.0.1:2080';
function uiRouting() {
  const ui = store.get('ui');
  return { mode: ui.routingMode || 'iran', direct: ui.routeDirect || '', proxy: ui.routeProxy || '' };
}
const systemProxy = new SystemProxy(path.join(app.getPath('userData'), 'system-proxy-backup.json'));
const killSwitch = new KillSwitch(path.join(app.getPath('userData'), 'killswitch-state.json'));

function ksState() {
  const st = activeManager().getState();
  return { enabled: !!store.get('ui').killSwitch, armed: killSwitch.armed, leftover: killSwitch.leftover(), connected: st.status === 'connected' };
}
function ksNotify() { send('killswitch:status', ksState()); }

/** Arms the firewall kill switch before a connect (when it is on in Settings). */
async function ksArm(m) {
  if (!isWindows || !store.get('ui').killSwitch) return;
  if (!(await isElevated())) {
    m.log('error', '[gui] کیل‌سوییچ به دسترسی Administrator نیاز دارد؛ این اتصال بدون کیل‌سوییچ است. از تنظیمات «اجرای مجدد با دسترسی مدیر» را بزنید.');
    return;
  }
  try {
    const own = [process.execPath, ...(openvpnExe ? [openvpnExe] : []), ...findExes(app.getPath('userData')), ...findExes(process.resourcesPath || ''), ...findExes(path.join(__dirname, '..', '..', 'resources'))];
    await killSwitch.arm(own);
    m.log('info', '[gui] کیل‌سوییچ فعال شد: اگر اتصال قطع شود، اینترنت برنامه‌های دیگر مسدود می‌ماند تا «قطع» را بزنید.');
    if (m === openvpnManager) await killSwitch.allowAdapter('OpenVPN*').catch((e) => m.log('error', `[gui] کیل‌سوییچ: اجازه‌ی آداپتور OpenVPN داده نشد (${e.message})`));
    if (tunManager.isRunning()) await killSwitch.allowTun().catch((e) => m.log('error', `[gui] کیل‌سوییچ: اجازه‌ی آداپتور TUN داده نشد (${e.message})`));
  } catch (err) {
    m.log('error', `[gui] کیل‌سوییچ فعال نشد: ${err.message}`);
  }
  ksNotify();
}

/** Removes the rules (user disconnect, quit). [elevate] = ask UAC when we are not admin. */
async function ksDisarm(elevate = false) {
  if (!killSwitch.armed && !killSwitch.leftover()) return;
  try {
    await killSwitch.disarm({ elevate });
    activeManager().log('info', '[gui] کیل‌سوییچ برداشته شد؛ قوانین فایروال به حالت قبل برگشت.');
  } catch (err) {
    activeManager().log('error', `[gui] برداشتن قوانین کیل‌سوییچ نشد: ${err.message}`);
  }
  ksNotify();
}

let mainWindow = null;
// updates of the app itself from GitHub Releases (direct, else through the running tunnel)
const selfUpdater = new SelfUpdater({
  send: (channel, payload) => send(channel, payload),
  currentVersion: app.getVersion(),
  socks: () => anyLiveTunnelSocksAddress(),
  workDir: path.join(app.getPath('userData'), 'update'),
  prefs: () => store.get('ui'),
});
let trayCtl = null;
let quitting = false;

// --- Engine abstraction: GozarVpn can drive either the Aether/WARP core
// or sing-box (VLESS/VMess/Trojan/Shadowsocks configs) as the active
// connection. Both managers expose the same shape (start/stop/getState,
// 'status'/'log' events), so most of the app (dashboard, system proxy,
// tunnel verification) doesn't need to know which one is active.
function activeEngine() {
  return store.get('ui').engine || 'aether';
}
function managerFor(engine) {
  if (engine === 'singbox') return singboxManager;
  if (engine === 'mihomo') return mihomoManager;
  if (engine === 'tor') return torManager;
  if (engine === 'psiphon') return psiphonManager;
  if (engine === 'openvpn') return openvpnManager;
  return coreManager;
}
function anyEngineRunning() {
  return [coreManager, singboxManager, mihomoManager, torManager, psiphonManager, openvpnManager].some((m) => m.isRunning());
}
function activeManager() {
  return managerFor(activeEngine());
}

/**
 * Whichever engine currently has a live, connected tunnel (regardless of
 * which one is "selected" in the UI) — used purely as a fallback path for
 * GitHub/subscription downloads when the direct connection is filtered.
 * Previously this was hardcoded to Aether's socks address everywhere,
 * which meant the fallback silently never applied while someone was
 * connected via the Xray engine instead.
 */
function anyLiveTunnelSocksAddress() {
  if (coreManager.isRunning() && coreManager.getState().socksAddress) return coreManager.getState().socksAddress;
  if (singboxManager.isRunning() && singboxManager.getState().socksAddress) return singboxManager.getState().socksAddress;
  if (mihomoManager.isRunning() && mihomoManager.getState().socksAddress) return mihomoManager.getState().socksAddress;
  if (torManager.isRunning() && torManager.getState().socksAddress) return torManager.getState().socksAddress;
  if (psiphonManager.isRunning() && psiphonManager.getState().socksAddress) return psiphonManager.getState().socksAddress;
  return null;
}

function ensureCoreSeeded() {
  fs.mkdirSync(coreDir, { recursive: true });
  const dest = path.join(coreDir, 'aether.exe');
  if (!fs.existsSync(dest) && fs.existsSync(bundledExe)) {
    fs.copyFileSync(bundledExe, dest);
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  // Compact, phone-like window (same proportions the Android build will
  // use) instead of the old 1180x760 desktop layout. Height is clamped to
  // the work area so it still fits on 768px-tall laptop screens.
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const height = Math.min(800, workArea.height - 40);
  mainWindow = new BrowserWindow({
    // fixed size: the layout is designed for exactly this window
    width: 450,
    height,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#0d0d0f',
    title: 'GozarVpn',
    icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${sourceId}:${line} ${message}`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] failed to load ${url}: ${desc} (${code})`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details);
  });

  mainWindow.on('close', (e) => {
    if (quitting || !isWindows) return;
    const action = closeAction();
    if (action === 'quit') {
      e.preventDefault();
      quitting = true;
      app.quit();
      return;
    }
    e.preventDefault();
    if (action === 'tray') {
      mainWindow.hide();
      return;
    }
    askWhatToDoOnClose();
  });

}

// What the window's X button does: 'ask' (default), 'tray' or 'quit'.
// Older settings only had the closeToTray boolean; an explicit `false`
// there meant "quit", anything else falls through to asking.
function closeAction() {
  const ui = store.get('ui');
  if (ui.closeAction === 'tray' || ui.closeAction === 'quit' || ui.closeAction === 'ask') return ui.closeAction;
  return ui.closeToTray === false ? 'quit' : 'ask';
}

let askingClose = false;
async function askWhatToDoOnClose() {
  if (askingClose) return;
  askingClose = true;
  try {
    const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'GozarVpn',
      message: 'با بستن پنجره چه کنم؟',
      detail: 'اگر به تسک‌بار بروم، برنامه (و اتصال فعلی) در پس‌زمینه باقی می‌ماند. اگر بسته شود، اتصال هم قطع می‌شود.',
      buttons: ['رفتن به تسک‌بار', 'بستن کامل برنامه', 'انصراف'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      checkboxLabel: 'دیگر نپرس (بعداً از تنظیمات قابل تغییر است)',
      checkboxChecked: false
    });
    if (response === 2) return;
    const choice = response === 1 ? 'quit' : 'tray';
    if (checkboxChecked) store.set('ui', { ...store.get('ui'), closeAction: choice });
    if (choice === 'quit') {
      quitting = true;
      app.quit();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  } finally {
    askingClose = false;
  }
}

function currentSettings() {
  const active = store.get('activeProfile');
  const profiles = store.get('profiles');
  return profiles[active] || {};
}

function activeV2rayConfig() {
  const id = store.get('activeV2rayConfig');
  if (!id) return null;
  return store.get('v2rayConfigs')[id] || null;
}

let lastKnownRunning = { aether: false, singbox: false, mihomo: false, tor: false, psiphon: false, openvpn: false };
let verifiedAddress = { aether: null, singbox: null, mihomo: null, tor: null, psiphon: null, openvpn: null };
let verifyInProgress = { aether: false, singbox: false, mihomo: false, tor: false, psiphon: false, openvpn: false };

// --- Smart anti-DPI (V2ray/Xray): ClientHello-splitting variants of a TLS outbound ---
const DPI_PROFILES = ['none', 'record', 'fragment', 'both'];
const DPI_LABELS = { none: 'بدون تغییر', record: 'تکه‌کردن رکورد', fragment: 'تکه‌کردن بسته', both: 'هر دو' };
function withDpi(cfg, profile) {
  if (profile === 'none' || !cfg.outbound || !cfg.outbound.tls) return cfg;
  const tls = { ...cfg.outbound.tls, record_fragment: profile === 'record' || profile === 'both' };
  if (profile === 'fragment' || profile === 'both') { tls.fragment = true; tls.fragment_fallback_delay = tls.fragment_fallback_delay || '500ms'; } else { delete tls.fragment; delete tls.fragment_fallback_delay; }
  return { ...cfg, outbound: { ...cfg.outbound, tls } };
}
/** The variant to run: a hand-set fragment wins; else the one that last worked, if smart mode is on. */
function dpiVariantFor(cfg) {
  if (cfg.dpiManual || !store.get('ui').dpiSmart) return 'none';
  return DPI_PROFILES.includes(cfg.dpiLearned) ? cfg.dpiLearned : 'none';
}
/** Smart mode: tries the variants (last good one first) with a real request and remembers the first that passes. */
async function learnDpi(cfg) {
  if (cfg.dpiManual || !store.get('ui').dpiSmart || !cfg.outbound || !cfg.outbound.tls) return;
  const order = [...new Set([cfg.dpiLearned, ...DPI_PROFILES].filter((p) => DPI_PROFILES.includes(p)))];
  for (const p of order) {
    singboxManager.log('info', `[gui] ضد DPI هوشمند: امتحان «${DPI_LABELS[p]}»…`);
    const r = await testOutbound(singboxUpdater.exePath, withDpi(cfg, p));
    if (r.ok) {
      const configs = store.get('v2rayConfigs');
      if (configs[cfg.id]) { configs[cfg.id].dpiLearned = p; store.set('v2rayConfigs', configs); }
      singboxManager.log('info', `[gui] ضد DPI هوشمند: «${DPI_LABELS[p]}» کار کرد (${r.latencyMs} ms) و برای این سرور ذخیره شد`);
      return;
    }
  }
  singboxManager.log('warn', '[gui] ضد DPI هوشمند: هیچ روشی در تست جواب نداد؛ با تنظیم فعلی وصل می‌شود');
}

function activeMihomoProfile() {
  const id = store.get('activeMihomoProfile');
  if (!id) return null;
  return (store.get('mihomoProfiles') || {})[id] || null;
}

/* ---------------- OpenVPN profiles ---------------- */
function openvpnProfiles() { return store.get('openvpnProfiles') || {}; }
function activeOpenvpnProfile() { return openvpnProfiles()[store.get('activeOpenvpnProfile')] || null; }

/** Saved username/password, encrypted with Windows DPAPI (safeStorage); null when none. */
function openvpnCreds(id) {
  const enc = (store.get('openvpnCreds') || {})[id];
  if (!enc || !safeStorage.isEncryptionAvailable()) return null;
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))); } catch { return null; }
}
function setOpenvpnCreds(id, creds) {
  const all = { ...(store.get('openvpnCreds') || {}) };
  if (creds && creds.username) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('رمزنگاری امن ویندوز در دسترس نیست؛ رمز ذخیره نشد.');
    all[id] = safeStorage.encryptString(JSON.stringify({ username: String(creds.username), password: String(creds.password || '') })).toString('base64');
  } else delete all[id];
  store.set('openvpnCreds', all);
}

/** IPv4 ranges that stay outside the OpenVPN tunnel: Iranian ones (iran mode) and the user's direct list. */
function openvpnDirectRoutes() {
  const r = uiRouting();
  const mine = r.direct.split(/[\s,]+/).map((x) => x.trim()).filter((x) => openvpn.cidrToRoute(x));
  const skipped = r.direct.split(/[\s,]+/).filter((x) => x.trim() && !openvpn.cidrToRoute(x)).length;
  if (skipped) openvpnManager.log('warn', `[gui] با OpenVPN فقط IP / محدوده‌ی IP در لیست مستقیم کار می‌کند؛ ${skipped} دامنه نادیده گرفته شد.`);
  if (r.mode === 'custom') openvpnManager.log('warn', '[gui] حالت «فقط لیست من از VPN» با OpenVPN پشتیبانی نمی‌شود؛ همه‌چیز (به‌جز ایران و لیست مستقیم) از تونل می‌رود.');
  const ir = r.mode === 'iran' ? routingRules.irCidrsV4(rulesUserDir, singboxUpdater.hasSingbox() ? singboxUpdater.exePath : null) : [];
  return [...new Set([...ir, ...mine])];
}

async function openvpnPreflight() {
  openvpnExe = await openvpn.findOpenVpn(store.get('ui').openvpnExe);
  if (!openvpnExe) throw new Error('برنامه‌ی رسمی OpenVPN پیدا نشد. از تب «کانفیگ‌ها › OpenVPN» نصبش کنید یا مسیر openvpn.exe را بدهید.');
  if (!(await isElevated())) throw new Error('OpenVPN برای ساختن تونل به دسترسی Administrator نیاز دارد. از «بیشتر › تنظیمات»، «اجرای مجدد با دسترسی مدیر» را بزنید.');
  if (tunManager.isRunning()) tunManager.stop();
  if (routerManager.isRunning()) routerManager.stop();
  if (systemProxy.applied) { try { await systemProxy.restore(); } catch { /* best-effort */ } }
  await openvpn.killLeftovers(openvpnRunDir);
}

function openvpnSummary(p) {
  const parsed = openvpn.parseOvpn(p.text);
  const r = parsed.remotes[0];
  return {
    id: p.id, name: p.name, addedAt: p.addedAt,
    server: r ? `${r.host}:${r.port}/${r.proto}` : '', servers: parsed.remotes.length,
    needsAuth: parsed.needsAuth, hasCreds: !!(store.get('openvpnCreds') || {})[p.id],
    problems: parsed.problems, removed: parsed.removed, test: (store.get('openvpnTests') || {})[p.id] || null,
  };
}

function addOpenvpnProfile(text, name) {
  const parsed = openvpn.parseOvpn(text);
  if (!parsed.ok) throw new Error(parsed.problems.join('؛ ') || 'فایل OpenVPN معتبر نیست');
  const id = crypto.randomBytes(6).toString('hex');
  const all = { ...openvpnProfiles(), [id]: { id, name: (name || parsed.remotes[0].host).slice(0, 80), text: String(text), addedAt: Date.now() } };
  store.set('openvpnProfiles', all);
  if (!activeOpenvpnProfile()) store.set('activeOpenvpnProfile', id);
  return openvpnSummary(all[id]);
}

/** Starts whichever engine is selected; shared by the UI button and the tray. */
function startActiveEngine() {
  const engine = activeEngine();
  if (engine === 'openvpn') {
    const prof = activeOpenvpnProfile();
    if (!prof) throw new Error('هیچ کانفیگ OpenVPN فعالی انتخاب نشده. از تب «کانفیگ‌ها › OpenVPN» یکی اضافه/انتخاب کنید.');
    if (!openvpnExe) throw new Error('برنامه‌ی رسمی OpenVPN پیدا نشد. از تب «کانفیگ‌ها › OpenVPN» نصبش کنید یا مسیرش را بدهید.');
    ksArm(openvpnManager);
    openvpnManager.log('info', '[gui] OpenVPN خودش تونل کل سیستم را می‌سازد؛ حالت TUN / پراکسی سیستمِ برنامه برای آن استفاده نمی‌شود.');
    return openvpnManager.start(openvpnExe, prof, { creds: openvpnCreds(prof.id), directRoutes: openvpnDirectRoutes() });
  }
  ksArm(managerFor(engine));
  if (engine === 'singbox') {
    if (!singboxUpdater.hasSingbox()) throw new Error('هسته‌ی sing-box نصب نشده. از تب V2ray/Xray دانلودش کنید.');
    const cfg = activeV2rayConfig();
    if (!cfg) throw new Error('هیچ کانفیگ V2ray/Xray فعالی انتخاب نشده. از تب V2ray/Xray یکی اضافه/انتخاب کنید.');
    if (cfg.awg) {
      const socks = awgHelper.start(cfg.awg.conf);
      const [h, p] = socks.split(':');
      return singboxManager.start(singboxUpdater.exePath, { ...cfg, outbound: { type: 'socks', server: h, server_port: Number(p), version: '5' } });
    }
    return singboxManager.start(singboxUpdater.exePath, withDpi(cfg, dpiVariantFor(cfg)));
  }
  if (engine === 'mihomo') {
    if (!mihomoUpdater.hasBinary()) throw new Error('هسته‌ی mihomo نصب نشده. از تب «کانفیگ‌ها › Clash» دانلودش کنید.');
    const prof = activeMihomoProfile();
    if (!prof) throw new Error('هیچ پروفایل Clash/mihomo فعالی انتخاب نشده.');
    return mihomoManager.start(mihomoUpdater.exePath, prof);
  }
  if (engine === 'tor') {
    if (!torBundle.hasBinary()) throw new Error('Tor نصب نشده. از تب «کانفیگ‌ها › Tor» دانلودش کنید.');
    const mode = (store.get('ui').torMode) || 'auto';
    const ui = store.get('ui');
    return torManager.start(torBundle, torBridges.load(), TOR_MODES.includes(mode) ? mode : 'auto', { custom: ui.torCustomBridges || '', onlyMine: !!ui.torOnlyMine });
  }
  ensureCoreSeeded();
  const aetherExe = path.join(coreDir, 'aether.exe');
  if (engine === 'psiphon') {
    if (!psiphon.aetherSupportsPsiphon(aetherExe)) throw new Error('سایفون به هسته‌ی Aether نسخه‌ی 2.4.0 یا جدیدتر نیاز دارد. از «بیشتر › به‌روزرسانی»، هسته‌ی Aether را به‌روز کنید.');
    if (!fs.existsSync(psiphon.psiphonExeFor(aetherExe))) throw new Error('فایل psiphon-tunnel-core.exe پیدا نشد.');
    psiphon.killLeftovers(aetherExe);
    return psiphonManager.start(aetherExe, currentSettings(), psiphon.launchOptions(store.get('ui'), path.join(app.getPath('userData'), 'psiphon'), aetherExe));
  }
  return coreManager.start(aetherExe, currentSettings());
}

/**
 * The core (or sing-box) printing "listening on ..." only proves the local
 * listener bound — it says nothing about whether the actual tunnel behind
 * it ever finished a working handshake. On heavily filtered networks the
 * listener can come up while zero bytes ever pass through it. Turning the
 * system proxy on for a dead tunnel is what caused "connected, but
 * literally no site opens" — every request in the OS now goes through a
 * proxy that accepts TCP connections but forwards nothing. So: verify
 * first, and only touch the system-wide proxy setting if that succeeds.
 * This is shared by both engines so neither can regress the other's fix.
 */
async function handleSystemProxyForStatus(engine, manager, state) {
  const ui = store.get('ui');

  if (state.status === 'connected' && state.address && state.httpAddress) {
    if (verifyInProgress[engine] || verifiedAddress[engine] === state.address) {
      // already verified (or verifying) this exact listener — nothing to do
    } else {
      verifyInProgress[engine] = true;
      send('tunnel:verify', { status: 'checking' });
      manager.log('info', '[gui] در حال بررسی اینکه تونل واقعاً ترافیک را رد می‌کند…');

      // engines' first requests can be slow (Psiphon especially), so retry before calling it dead
      const result = await verifyTunnel(state.address, { attempts: engine === 'psiphon' ? 6 : 3, log: (lvl, txt) => manager.log(lvl, txt) });
      verifyInProgress[engine] = false;

      if (result.ok) {
        verifiedAddress[engine] = state.address;
        manager.log('info', `[gui] تونل سالم است و ترافیک واقعی از آن رد می‌شود (${result.latencyMs} ms).`);
        await applyRouting(manager, state, ui);
      } else {
        manager.log('error', `[gui] تونل بالا آمد اما ترافیک واقعی رد نمی‌کند (${result.error}). برای همین پراکسی سیستم روشن نشد و تا این مشکل حل نشود، اینترنت شما دست‌نخورده می‌ماند.`);
        send('tunnel:verify', { status: 'failed', error: result.error });
      }
    }
  }

  const stillRunning = state.running;
  if (!stillRunning && lastKnownRunning[engine]) {
    verifiedAddress[engine] = null;
    send('tunnel:verify', { status: 'idle' });
    if (!anyEngineRunning()) liveStats.stop();
    if (tunManager.isRunning()) {
      manager.log('info', '[gui] در حال بستن آداپتور TUN…');
      tunManager.stop();
    }
    if (routerManager.isRunning()) routerManager.stop();
    if (systemProxy.applied) {
      systemProxy.restore()
        .then(() => manager.log('info', '[gui] system proxy restored to previous settings'))
        .catch((err) => manager.log('error', `[gui] failed to restore system proxy: ${err.message}`));
    }
  }
  lastKnownRunning[engine] = stillRunning;
}

/** Turns on TUN or the system proxy for a running tunnel (after the check, or when the user says go anyway). */
async function applyRouting(manager, state, ui) {
  liveStats.start();
  send('tunnel:verify', { status: 'ok', mode: ui.tunMode ? 'tun' : 'proxy' });
  if (ui.tunMode) {
    await startTunOver(manager, state.address, ui);
  } else if (ui.autoSystemProxy) {
    // with Iran routing, the system proxy points at the local router, which sends Iranian
    // sites direct and the rest to the engine (needs the sing-box core, as TUN does)
    const r = uiRouting();
    if (r.mode !== 'all' || r.direct.trim() || r.proxy.trim()) {
      if (singboxUpdater.hasSingbox()) {
        try {
          if (routerManager.isRunning()) routerManager.stop();
          routerManager.start(singboxUpdater.exePath, state.address, { mixedListen: ROUTER_ADDR, routing: r, rulesUserDir });
          const ok = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), 8000);
            const on = (s) => { if (s.status === 'up') { clearTimeout(t); resolve(true); } else if (!s.running) { clearTimeout(t); resolve(false); } else routerManager.once('status', on); };
            routerManager.once('status', on);
          });
          if (ok) {
            await systemProxy.enable(ROUTER_ADDR, ui.socksOnlySystemProxy ? null : ROUTER_ADDR);
            manager.log('info', `[gui] مسیر ترافیک: ${r.mode === 'iran' ? 'ایران مستقیم، بقیه از VPN' : r.mode === 'custom' ? 'فقط لیست من از VPN' : 'لیست‌های شما'} (روتر محلی ${ROUTER_ADDR})`);
            return;
          }
          manager.log('warn', '[gui] روتر مسیر ترافیک بالا نیامد؛ پراکسی سیستم بدون قوانین ایران فعال می‌شود.');
        } catch (err) {
          manager.log('warn', `[gui] روتر مسیر ترافیک شروع نشد (${err.message}); پراکسی سیستم بدون قوانین ایران فعال می‌شود.`);
        }
      } else {
        manager.log('warn', '[gui] برای «ایران مستقیم» در حالت پراکسی سیستم، هسته‌ی sing-box لازم است (تب کانفیگ‌ها › V2ray). فعلاً همه از VPN می‌رود.');
      }
    }
    try {
      await systemProxy.enable(state.address, ui.socksOnlySystemProxy ? null : state.httpAddress);
      manager.log('info', `[gui] system proxy set to ${ui.socksOnlySystemProxy ? '' : 'http/https+'}socks=${state.address}${!ui.socksOnlySystemProxy && state.httpAddress ? ` (http=${state.httpAddress})` : ''}`);
    } catch (err) {
      manager.log('error', `[gui] failed to set system proxy: ${err.message}`);
    }
  }
}

async function enableSystemProxyFallback(manager, socksAddr, ui) {
  if (!ui.autoSystemProxy || systemProxy.applied) return;
  const httpAddr = activeManager().getState().httpAddress;
  try {
    await systemProxy.enable(socksAddr, ui.socksOnlySystemProxy ? null : httpAddr);
    manager.log('warn', '[gui] به‌جای TUN، موقتاً پراکسی سیستم فعال شد تا اینترنت شما قطع نماند.');
  } catch (err) {
    manager.log('error', `[gui] failed to set system proxy: ${err.message}`);
  }
}

/**
 * TUN mode: once the engine's SOCKS listener is verified, bring up the
 * Wintun adapter (a separate sing-box, see tunManager.js) that captures
 * all system traffic and feeds it into that listener. No system proxy is
 * touched. If TUN can't start (not elevated / sing-box missing) we fall
 * back to the system proxy rather than leaving the user without internet.
 */
async function startTunOver(manager, socksAddr, ui) {
  if (tunManager.isRunning()) return;
  if (!(await isElevated())) {
    manager.log('error', '[gui] حالت TUN به دسترسی Administrator نیاز دارد. از تنظیمات، «اجرای مجدد با دسترسی مدیر» را بزنید.');
    send('tun:status', { status: 'needs-admin', running: false });
    await enableSystemProxyFallback(manager, socksAddr, ui);
    return;
  }
  if (!singboxUpdater.hasSingbox()) {
    manager.log('error', '[gui] حالت TUN از هسته‌ی sing-box استفاده می‌کند که هنوز نصب نشده. از تب «کانفیگ‌ها» دانلودش کنید.');
    send('tun:status', { status: 'missing-singbox', running: false });
    await enableSystemProxyFallback(manager, socksAddr, ui);
    return;
  }
  if (systemProxy.applied) {
    try { await systemProxy.restore(); } catch { /* best-effort */ }
  }
  try {
    manager.log('info', `[gui] در حال ساخت آداپتور TUN (GozarTun) روی ${socksAddr}…`);
    tunManager.start(singboxUpdater.exePath, socksAddr, { remoteDns: ui.tunDns || '1.1.1.1', routing: uiRouting(), rulesUserDir });
  } catch (err) {
    manager.log('error', `[gui] TUN start failed: ${err.message}`);
    send('tun:status', { status: 'error', running: false, error: err.message });
    await enableSystemProxyFallback(manager, socksAddr, ui);
  }
}

// Log lines can arrive dozens-per-second during active browsing (every
// VLESS/HTTP connection logs 2-3 lines) — sending each one as its own IPC
// message and DOM append/reflow is what makes the UI feel laggy while
// connected. Batching them into one flush every ~120ms cuts both the IPC
// traffic and the DOM churn dramatically without making the console feel
// noticeably less "live".
let logQueue = [];
let logFlushTimer = null;
function queueLog(entry) {
  logQueue.push(entry);
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(() => {
      const batch = logQueue;
      logQueue = [];
      logFlushTimer = null;
      send('core:logBatch', batch);
    }, 120);
  }
}

function wireCoreEvents() {
  coreManager.on('status', (state) => {
    // IMPORTANT: system-proxy handling must run unconditionally, even if
    // the engine selector has already been flipped to 'singbox' by the
    // time this event arrives. A disconnect's "stopped" status is
    // asynchronous (fires only once the OS process actually exits) — if
    // the person switches engines in that brief window, gating this on
    // activeEngine() would silently skip restoring the system proxy,
    // leaving stale registry entries pointing at a now-dead port. Only
    // the *UI-facing* forwarding (what the dashboard displays) should be
    // limited to whichever engine is currently selected.
    handleSystemProxyForStatus('aether', coreManager, state);
    if (activeEngine() !== 'aether') return;
    send('core:status', state);
    trayCtl && trayCtl.refresh();
  });
  coreManager.on('log', (entry) => {
    if (activeEngine() !== 'aether') return;
    queueLog(entry);
  });

  mihomoManager.on('status', (state) => {
    handleSystemProxyForStatus('mihomo', mihomoManager, state);
    if (activeEngine() !== 'mihomo') return;
    send('core:status', state);
    trayCtl && trayCtl.refresh();
  });
  mihomoManager.on('log', (entry) => {
    if (activeEngine() !== 'mihomo') return;
    queueLog(entry);
  });

  torManager.on('status', (state) => {
    handleSystemProxyForStatus('tor', torManager, state);
    if (activeEngine() !== 'tor') return;
    send('core:status', state);
    trayCtl && trayCtl.refresh();
  });
  torManager.on('log', (entry) => {
    if (activeEngine() !== 'tor') return;
    queueLog(entry);
  });

  psiphonManager.on('status', (state) => {
    handleSystemProxyForStatus('psiphon', psiphonManager, state);
    if (activeEngine() !== 'psiphon') return;
    send('core:status', state);
    trayCtl && trayCtl.refresh();
  });
  psiphonManager.on('log', (entry) => {
    if (activeEngine() !== 'psiphon') return;
    queueLog(entry);
  });
  openvpnManager.on('status', (state) => {
    handleSystemProxyForStatus('openvpn', openvpnManager, state);
    if (state.status === 'connected') liveStats.start();
    if (activeEngine() !== 'openvpn') return;
    send('core:status', state);
    trayCtl && trayCtl.refresh();
  });
  openvpnManager.on('log', (entry) => {
    if (activeEngine() !== 'openvpn') return;
    queueLog(entry);
  });
  liveStats.on('stats', (s) => send('stats:update', s));

  singboxManager.on('status', (state) => {
    if (!state.running && awgHelper.proc) awgHelper.stop();
    handleSystemProxyForStatus('singbox', singboxManager, state);
    if (activeEngine() !== 'singbox') return;
    send('core:status', state);
    trayCtl && trayCtl.refresh();
  });
  singboxManager.on('log', (entry) => {
    if (activeEngine() !== 'singbox') return;
    queueLog(entry);
  });

  // The TUN helper's log lines are copied into the active engine's buffer
  // so they show up in the same live console (and survive a tab switch).
  tunManager.on('log', (entry) => {
    activeManager().log(entry.level, entry.text);
  });
  routerManager.on('log', (entry) => {
    activeManager().log(entry.level, entry.text.replace('[tun]', '[router]'));
  });
  tunManager.on('status', (state) => {
    send('tun:status', state);
    if (state.status === 'up' && killSwitch.armed) killSwitch.allowTun().catch((e) => activeManager().log('error', `[gui] کیل‌سوییچ: اجازه‌ی آداپتور TUN داده نشد (${e.message})`));
    trayCtl && trayCtl.refresh();
    // TUN died on its own while the engine is still up (e.g. adapter
    // creation failed): keep the user online through the system proxy.
    if (state.status === 'error') {
      const m = activeManager();
      const st = m.getState();
      if (st.running && st.socksAddress) enableSystemProxyFallback(m, st.socksAddress, store.get('ui'));
    }
  });
}

function registerIpc() {
  ipcMain.handle('env-schema:get', () => ENV_SCHEMA);

  ipcMain.handle('profiles:get', () => ({
    active: store.get('activeProfile'),
    profiles: store.get('profiles'),
    ui: store.get('ui')
  }));

  ipcMain.handle('profiles:save', (_e, { name, settings }) => {
    const profiles = store.get('profiles');
    profiles[name] = settings;
    store.set('profiles', profiles);
    store.set('activeProfile', name);
    return true;
  });

  ipcMain.handle('profiles:delete', (_e, name) => {
    const profiles = store.get('profiles');
    if (name === 'default') return false;
    delete profiles[name];
    store.set('profiles', profiles);
    if (store.get('activeProfile') === name) store.set('activeProfile', 'default');
    return true;
  });

  ipcMain.handle('profiles:setActive', (_e, name) => {
    store.set('activeProfile', name);
    return true;
  });

  ipcMain.handle('tun:state', () => tunManager.getState());
  ipcMain.handle('app:isElevated', () => isElevated());
  ipcMain.handle('app:relaunchAsAdmin', async () => {
    // Re-launch the same executable elevated (UAC prompt) and quit this
    // instance. The single-instance lock is released first, otherwise the
    // elevated copy would see us still holding it and exit immediately.
    if (!isWindows) return false;
    const exe = process.execPath.replace(/'/g, "''");
    const args = process.argv.slice(1).map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    const cwd = process.cwd().replace(/'/g, "''");
    const cmd = `Start-Process -FilePath '${exe}' ${args ? `-ArgumentList ${args} ` : ''}-WorkingDirectory '${cwd}' -Verb RunAs`;
    quitting = true;
    coreManager.stop();
    singboxManager.stop();
    mihomoManager.stop();
    torManager.stop();
    psiphonManager.stop();
    openvpnManager.stop();
    awgHelper.stop();
    tunManager.stop();
    routerManager.stop();
    if (systemProxy.applied) { try { await systemProxy.restore(); } catch { /* best-effort */ } }
    await ksDisarm();
    app.releaseSingleInstanceLock();
    require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true }, (err) => {
      if (err) {
        // UAC was declined — keep running unelevated.
        quitting = false;
        app.requestSingleInstanceLock();
        send('tun:status', { status: 'needs-admin', running: false, error: 'UAC declined' });
        return;
      }
      app.quit();
    });
    return true;
  });

  ipcMain.handle('ui:setPrefs', (_e, prefs) => {
    store.set('ui', { ...store.get('ui'), ...prefs });
    return true;
  });

  // --- Engine selection ---
  ipcMain.handle('engine:get', () => activeEngine());
  ipcMain.handle('engine:set', (_e, engine) => {
    if (anyEngineRunning()) {
      throw new Error('برای تغییر موتور اتصال، ابتدا قطع اتصال کنید.');
    }
    store.set('ui', { ...store.get('ui'), engine });
    trayCtl && trayCtl.refresh();
    return true;
  });

  // --- Connection control (engine-aware; routes to whichever is active) ---
  ipcMain.handle('core:start', async () => {
    // Safety net: if a previous run left the system proxy pointed at a
    // now-dead port (e.g. from the race the engine-switch fix above
    // closes, or an unclean shutdown some other way), never start a new
    // connection on top of that — always begin from a clean slate.
    if (systemProxy.applied && !anyEngineRunning()) {
      try { await systemProxy.restore(); } catch { /* best-effort */ }
    }
    if (tunManager.isRunning() && !anyEngineRunning()) {
      tunManager.stop();
    }
    if (routerManager.isRunning() && !anyEngineRunning()) routerManager.stop();
    if (activeEngine() === 'singbox' && activeV2rayConfig() && singboxUpdater.hasSingbox()) await learnDpi(activeV2rayConfig());
    if (activeEngine() === 'openvpn') await openvpnPreflight();
    startActiveEngine();
    return true;
  });

  ipcMain.handle('core:stop', async () => { const r = activeManager().stop(); await ksDisarm(); return r; });
  ipcMain.handle('killswitch:state', () => ksState());

  // --- OpenVPN ---
  ipcMain.handle('openvpn:list', async () => {
    openvpnExe = await openvpn.findOpenVpn(store.get('ui').openvpnExe);
    return {
      profiles: Object.values(openvpnProfiles()).sort((a, b) => a.addedAt - b.addedAt).map(openvpnSummary),
      active: store.get('activeOpenvpnProfile') || null,
      exe: openvpnExe, version: openvpnExe ? await openvpn.versionOf(openvpnExe) : null,
    };
  });
  ipcMain.handle('openvpn:importText', (_e, text, name) => addOpenvpnProfile(text, name));
  ipcMain.handle('openvpn:importClipboard', () => {
    const text = clipboard.readText();
    if (!/^\s*(client|remote|dev|proto)\b/m.test(text)) throw new Error('در کلیپ‌بورد کانفیگ OpenVPN نیست.');
    return addOpenvpnProfile(text, null);
  });
  ipcMain.handle('openvpn:importFiles', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'انتخاب فایل OpenVPN', properties: ['openFile', 'multiSelections'], filters: [{ name: 'OpenVPN', extensions: ['ovpn', 'conf'] }, { name: 'All', extensions: ['*'] }] });
    if (res.canceled) return { added: [], errors: [] };
    const added = [];
    const errors = [];
    for (const file of res.filePaths) {
      try {
        if (fs.statSync(file).size > 512 * 1024) throw new Error('فایل بیش از حد بزرگ است');
        added.push(addOpenvpnProfile(fs.readFileSync(file, 'utf8'), path.basename(file).replace(/\.(ovpn|conf)$/i, '')));
      } catch (err) { errors.push(`${path.basename(file)}: ${err.message}`); }
    }
    return { added, errors };
  });
  ipcMain.handle('openvpn:setActive', (_e, id) => {
    if (openvpnManager.isRunning()) throw new Error('برای تعویض کانفیگ، ابتدا قطع اتصال کنید.');
    if (!openvpnProfiles()[id]) throw new Error('کانفیگ پیدا نشد');
    store.set('activeOpenvpnProfile', id);
    return true;
  });
  ipcMain.handle('openvpn:delete', (_e, id) => {
    const all = { ...openvpnProfiles() };
    delete all[id];
    store.set('openvpnProfiles', all);
    setOpenvpnCreds(id, null);
    if (store.get('activeOpenvpnProfile') === id) store.set('activeOpenvpnProfile', Object.keys(all)[0] || null);
    return true;
  });
  ipcMain.handle('openvpn:rename', (_e, id, name) => {
    const all = { ...openvpnProfiles() };
    if (!all[id]) return false;
    all[id] = { ...all[id], name: String(name || '').slice(0, 80) || all[id].name };
    store.set('openvpnProfiles', all);
    return true;
  });
  ipcMain.handle('openvpn:setCreds', (_e, id, username, password) => { setOpenvpnCreds(id, username ? { username, password } : null); return true; });
  ipcMain.handle('openvpn:test', async (_e, id) => {
    const p = openvpnProfiles()[id];
    if (!p) throw new Error('کانفیگ پیدا نشد');
    const exe = await openvpn.findOpenVpn(store.get('ui').openvpnExe);
    if (!exe) throw new Error('برنامه‌ی رسمی OpenVPN پیدا نشد.');
    const r = await openvpn.testProfile(exe, p, { creds: openvpnCreds(id), runDir: openvpnRunDir });
    store.set('openvpnTests', { ...(store.get('openvpnTests') || {}), [id]: { ...r, at: Date.now() } });
    return r;
  });
  ipcMain.handle('openvpn:pickExe', async () => {
    const res = await dialog.showOpenDialog(mainWindow, { title: 'انتخاب openvpn.exe', properties: ['openFile'], filters: [{ name: 'openvpn.exe', extensions: ['exe'] }] });
    if (res.canceled) return null;
    const v = await openvpn.versionOf(res.filePaths[0]);
    if (!v) throw new Error('این فایل openvpn.exe نیست.');
    store.set('ui', { ...store.get('ui'), openvpnExe: res.filePaths[0] });
    openvpnExe = res.filePaths[0];
    return { exe: openvpnExe, version: v };
  });
  // downloads the official installer, checks it is signed by OpenVPN Inc., then opens it (UAC + setup wizard)
  ipcMain.handle('openvpn:install', async () => {
    const dir = path.join(app.getPath('userData'), 'openvpn');
    fs.mkdirSync(dir, { recursive: true });
    const msi = path.join(dir, path.basename(openvpn.INSTALLER_URL));
    send('openvpn:installProgress', { stage: 'download', pct: 0 });
    await tryDirectThenTunnel((socks) => downloadToFile(openvpn.INSTALLER_URL, msi, (pct) => send('openvpn:installProgress', { stage: 'download', pct }), socks), anyLiveTunnelSocksAddress());
    const sig = await openvpn.checkSignature(msi);
    if (!sig.ok) { try { fs.unlinkSync(msi); } catch { /* gone */ } throw new Error(`امضای فایل نصب معتبر نیست (${sig.status || '?'}); نصب نشد.`); }
    send('openvpn:installProgress', { stage: 'install' });
    const err = await shell.openPath(msi);
    if (err) throw new Error(err);
    return { msi, signer: sig.subject };
  });
  // emergency: remove the rules even when this copy is not elevated (UAC prompt then)
  ipcMain.handle('killswitch:emergency', async () => { await ksDisarm(!(await isElevated())); return ksState(); });
  // the check failed but the user wants to use the tunnel anyway
  ipcMain.handle('tunnel:forceEnable', async () => {
    const m = activeManager();
    const st = m.getState();
    if (st.status !== 'connected' || !st.address) throw new Error('اتصالی برقرار نیست.');
    verifiedAddress[activeEngine()] = st.address;
    m.log('warn', '[gui] بررسی تونل رد شد، ولی به درخواست شما پراکسی/TUN به هر حال فعال شد.');
    await applyRouting(m, st, store.get('ui'));
    return true;
  });
  ipcMain.handle('core:state', () => activeManager().getState());
  ipcMain.handle('core:logs', () => activeManager().logBuffer);
  ipcMain.handle('core:clearLogs', () => { activeManager().clearLogs(); return true; });
  // last ~2000 lines of the active engine, repeats collapsed, for pasting into a bug report
  const logText = () => {
    const out = [];
    let lastKey = null;
    for (const e of activeManager().logBuffer.slice(-2000)) {
      const key = e.text.replace(/^\[[^\]]*\]\s*/, '');
      if (key === lastKey) { out[out.length - 1].n++; continue; }
      lastKey = key;
      out.push({ text: `[${new Date(e.t).toLocaleTimeString('en-GB')}] ${e.text}`, n: 1 });
    }
    return `GozarVpn ${app.getVersion()} · ${activeEngine()}\n` + out.map((l) => (l.n > 1 ? `(×${l.n}) ` : '') + l.text).join('\n');
  };
  ipcMain.handle('logs:copy', () => { clipboard.writeText(logText()); return true; });
  ipcMain.handle('logs:save', async () => {
    const res = await dialog.showSaveDialog(mainWindow, { title: 'ذخیره لاگ', defaultPath: `gozarvpn-log-${Date.now()}.txt`, filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (res.canceled || !res.filePath) return false;
    fs.writeFileSync(res.filePath, logText(), 'utf8');
    return true;
  });

  ipcMain.handle('core:hasCore', () => {
    const engine = activeEngine();
    if (engine === 'singbox') return singboxUpdater.hasSingbox() && !!activeV2rayConfig();
    if (engine === 'mihomo') return mihomoUpdater.hasBinary() && !!activeMihomoProfile();
    if (engine === 'tor') return torBundle.hasBinary();
    if (engine === 'psiphon') return coreUpdater.hasCore() && fs.existsSync(psiphon.psiphonExeFor(path.join(coreDir, 'aether.exe')));
    if (engine === 'openvpn') return !!activeOpenvpnProfile();
    return coreUpdater.hasCore();
  });
  ipcMain.handle('core:installedVersion', () => coreUpdater.getInstalledVersion());

  ipcMain.handle('core:checkUpdate', async () => {
    ensureCoreSeeded();
    return coreUpdater.checkForUpdate(anyLiveTunnelSocksAddress());
  });

  ipcMain.handle('core:update', async () => {
    ensureCoreSeeded();
    // the Psiphon engine runs the same aether.exe, so it counts as running too
    const running = [coreManager, psiphonManager].filter((m) => m.isRunning());
    const wasRunning = running.length > 0;
    // Capture the tunnel's own SOCKS address so the download can fall
    // back to routing through it if GitHub is filtered directly — and
    // keep the core running through the download/verify steps (only
    // stopping right before the file swap, since Windows won't allow
    // overwriting a running exe) so that tunnel is actually still usable.
    const socksAddrForDownload = anyLiveTunnelSocksAddress();
    const result = await coreUpdater.update(
      (progress) => send('core-update:progress', progress),
      socksAddrForDownload,
      wasRunning ? () => Promise.all(running.map((m) => m.stopAndWait())) : null
    );
    if (wasRunning && result.updated) {
      setTimeout(() => { try { startActiveEngine(); } catch { /* user can retry from UI */ } }, 800);
    }
    return result;
  });

  ipcMain.handle('core:pickExeManually', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'انتخاب aether.exe یا فایل zip نسخه‌ی ویندوز Aether',
      filters: [{ name: 'Aether (exe / zip)', extensions: ['exe', 'zip'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return false;
    if ([coreManager, psiphonManager].some((m) => m.isRunning())) throw new Error('اول اتصال Aether/سایفون را قطع کنید، بعد هسته را جایگزین کنید.');
    const picked = res.filePaths[0];
    fs.mkdirSync(coreDir, { recursive: true });
    if (/\.zip$/i.test(picked)) await coreUpdater.installFromZip(picked, 'manual');
    else coreUpdater.installExe(picked);
    return true;
  });

  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:checkUpdate', () => selfUpdater.check());
  ipcMain.handle('app:downloadUpdate', () => selfUpdater.download().then(() => true).catch(() => false));
  ipcMain.handle('app:installUpdate', () => {
    if (!selfUpdater.install()) return false;
    if (!selfUpdater.portableDir) { quitting = true; app.quit(); }
    return true;
  });
  ipcMain.handle('app:openReleases', () => shell.openExternal(RELEASES_PAGE));
  ipcMain.handle('app:updateInfo', () => ({ portable: !!selfUpdater.portableDir, found: selfUpdater.found, downloaded: !!selfUpdater.downloaded }));
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));

  // --- IP scanner (finds candidate clean IPs to force as AETHER_PEER) ---
  ipcMain.handle('scanner:hasScanner', () => ipScanner.hasScanner());
  ipcMain.handle('scanner:installedVersion', () => ipScanner.getInstalledVersion());
  ipcMain.handle('scanner:checkUpdate', () => ipScanner.checkForUpdate(anyLiveTunnelSocksAddress()));
  ipcMain.handle('scanner:update', () => ipScanner.update((progress) => send('scanner-update:progress', progress), anyLiveTunnelSocksAddress()));

  ipcMain.handle('scanner:run', async (_e, opts) => {
    return ipScanner.runScan(opts, (line) => send('scanner:progressLine', line));
  });
  ipcMain.handle('scanner:cancel', () => ipScanner.cancelScan());

  ipcMain.handle('scanner:importFile', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'ایمپورت لیست IP',
      filters: [
        { name: 'CSV / Text', extensions: ['csv', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return parseCandidatesFile(res.filePaths[0]);
  });

  ipcMain.handle('scanner:applyPeer', (_e, { ip, port, target }) => {
    const active = store.get('activeProfile');
    const profiles = store.get('profiles');
    const settings = profiles[active] || {};
    const value = `${ip}:${port}`;
    if (target === 'wg') settings.AETHER_WG_PEER = value;
    else settings.AETHER_PEER = value;
    profiles[active] = settings;
    store.set('profiles', profiles);
    return settings;
  });

  ipcMain.handle('scanner:clearPeer', () => {
    const active = store.get('activeProfile');
    const profiles = store.get('profiles');
    const settings = profiles[active] || {};
    delete settings.AETHER_PEER;
    delete settings.AETHER_WG_PEER;
    profiles[active] = settings;
    store.set('profiles', profiles);
    return settings;
  });

  // --- sing-box binary (VLESS/VMess/Trojan/Shadowsocks engine) ---
  ipcMain.handle('singbox:hasSingbox', () => singboxUpdater.hasSingbox());
  ipcMain.handle('singbox:installedVersion', () => singboxUpdater.getInstalledVersion());
  ipcMain.handle('singbox:checkUpdate', () => singboxUpdater.checkForUpdate(anyLiveTunnelSocksAddress()));
  ipcMain.handle('singbox:update', async () => {
    // The download may be riding on a live sing-box tunnel, so keep it up
    // until right before the file swap, then restart it afterwards.
    const wasRunning = singboxManager.isRunning();
    const result = await singboxUpdater.update(
      (progress) => send('singbox-update:progress', progress),
      anyLiveTunnelSocksAddress(),
      wasRunning ? () => singboxManager.stopAndWait() : null
    );
    if (wasRunning) {
      setTimeout(() => { try { startActiveEngine(); } catch { /* user can reconnect */ } }, 800);
    }
    return result;
  });
  ipcMain.handle('singbox:pickExeManually', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'انتخاب sing-box.exe',
      filters: [{ name: 'Executable', extensions: ['exe'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return false;
    fs.mkdirSync(singboxBinDir, { recursive: true });
    fs.copyFileSync(res.filePaths[0], singboxUpdater.exePath);
    return true;
  });

  // --- Traffic routing (Iran direct) ---
  ipcMain.handle('routing:get', () => ({ ...uiRouting(), version: routingRules.version(rulesUserDir), hasSingbox: singboxUpdater.hasSingbox() }));
  ipcMain.handle('routing:set', (_e, prefs) => {
    const pick = {};
    if (['all', 'iran', 'custom'].includes(prefs.mode)) pick.routingMode = prefs.mode;
    if (typeof prefs.direct === 'string') pick.routeDirect = prefs.direct.slice(0, 20000);
    if (typeof prefs.proxy === 'string') pick.routeProxy = prefs.proxy.slice(0, 20000);
    store.set('ui', { ...store.get('ui'), ...pick });
    return true;
  });
  ipcMain.handle('routing:update', () => routingRules.update(rulesUserDir, anyLiveTunnelSocksAddress()));
  ipcMain.handle('routing:explain', (_e, host) => routingRules.explain(host, uiRouting(), rulesUserDir));

  // --- Live stats (home screen) ---
  ipcMain.handle('stats:probe', async () => {
    const st = activeManager().getState();
    if (st.status === 'connected' && st.systemTunnel) return exitInfo(null);
    return st.status === 'connected' && st.socksAddress ? exitInfo(st.socksAddress) : null;
  });

  // --- Psiphon engine options (stored with the other UI prefs) ---
  ipcMain.handle('psiphon:info', () => {
    const ui = store.get('ui');
    return {
      route: ui.psiphonRoute || 'aether', mode: ui.psiphonMode || 'auto', region: ui.psiphonRegion || '',
      coreSupports: psiphon.aetherSupportsPsiphon(path.join(coreDir, 'aether.exe')), coreVersion: coreUpdater.getInstalledVersion()
    };
  });
  ipcMain.handle('psiphon:set', (_e, prefs) => {
    const pick = {};
    if (['aether', 'only'].includes(prefs.route)) pick.psiphonRoute = prefs.route;
    if (['auto', 'cdn', 'direct'].includes(prefs.mode)) pick.psiphonMode = prefs.mode;
    if (typeof prefs.region === 'string' && /^([A-Za-z]{2})?$/.test(prefs.region)) pick.psiphonRegion = prefs.region.toUpperCase();
    store.set('ui', { ...store.get('ui'), ...pick });
    return true;
  });

  // --- Tor engine: bundle install, bridges, mode ---
  ipcMain.handle('tor:info', () => ({
    installed: torBundle.hasBinary(),
    version: torBundle.getInstalledVersion(),
    mode: (store.get('ui').torMode) || 'auto',
    bridges: torBridges.counts(),
    bridgesUpdatedAt: torBridges.updatedAt()
  }));
  ipcMain.handle('tor:setMode', (_e, mode) => {
    if (!TOR_MODES.includes(mode)) throw new Error('حالت نامعتبر');
    store.set('ui', { ...store.get('ui'), torMode: mode });
    return true;
  });
  ipcMain.handle('tor:install', async () => {
    const wasRunning = torManager.isRunning();
    const result = await torBundle.install(
      (progress) => send('tor-update:progress', progress),
      anyLiveTunnelSocksAddress(),
      wasRunning ? () => torManager.stopAndWait() : null
    );
    if (wasRunning) setTimeout(() => { try { startActiveEngine(); } catch { /* user can reconnect */ } }, 800);
    return result;
  });
  ipcMain.handle('tor:pickArchive', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'انتخاب tor-expert-bundle-windows-x86_64-*.tar.gz',
      filters: [{ name: 'Tor Expert Bundle', extensions: ['gz', 'tgz'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return false;
    return torBundle.installFromArchive(res.filePaths[0], torManager.isRunning() ? () => torManager.stopAndWait() : null);
  });
  ipcMain.handle('tor:getCustomBridges', () => { const ui = store.get('ui'); return { text: ui.torCustomBridges || '', onlyMine: !!ui.torOnlyMine }; });
  ipcMain.handle('tor:setCustomBridges', (_e, { text, onlyMine }) => {
    store.set('ui', { ...store.get('ui'), torCustomBridges: String(text || '').slice(0, 50000), torOnlyMine: !!onlyMine });
    return require('./bridges').checkAll(text).map((v) => ({ ok: v.ok, kind: v.kind, reason: v.reason }));
  });
  ipcMain.handle('tor:checkBridges', (_e, text) => require('./bridges').checkAll(text).map((v) => ({ ok: v.ok, kind: v.kind, reason: v.reason })));
  ipcMain.handle('tor:updateBridges', () => torBridges.update(anyLiveTunnelSocksAddress()));

  // --- mihomo (Clash.Meta) engine: binary + subscription profiles ---
  ipcMain.handle('mihomo:hasBinary', () => mihomoUpdater.hasBinary());
  ipcMain.handle('mihomo:installedVersion', () => mihomoUpdater.getInstalledVersion());
  ipcMain.handle('mihomo:update', async () => {
    const wasRunning = mihomoManager.isRunning();
    const result = await mihomoUpdater.update(
      (progress) => send('mihomo-update:progress', progress),
      anyLiveTunnelSocksAddress(),
      wasRunning ? () => mihomoManager.stopAndWait() : null
    );
    if (wasRunning) {
      setTimeout(() => { try { startActiveEngine(); } catch { /* user can reconnect */ } }, 800);
    }
    return result;
  });
  ipcMain.handle('mihomo:pickExeManually', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'انتخاب mihomo.exe',
      filters: [{ name: 'Executable', extensions: ['exe'] }],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return false;
    mihomoUpdater.installFrom(res.filePaths[0]);
    return true;
  });

  ipcMain.handle('mihomo:list', () => ({
    profiles: store.get('mihomoProfiles') || {},
    activeId: store.get('activeMihomoProfile') || null
  }));

  function addMihomoProfile({ name, text, sourceUrl, groupType }) {
    if (!text || !text.trim()) throw new Error('محتوای سابسکریپشن خالی است.');
    const id = crypto.randomUUID();
    mihomoManager.saveProfileContent(id, text);
    const profiles = store.get('mihomoProfiles') || {};
    let fallbackName = `Clash ${Object.keys(profiles).length + 1}`;
    if (sourceUrl) { try { fallbackName = new URL(sourceUrl).hostname; } catch { /* keep default */ } }
    profiles[id] = {
      id,
      name: name || fallbackName,
      sourceUrl: sourceUrl || null,
      groupType: groupType || 'url-test',
      addedAt: new Date().toISOString()
    };
    store.set('mihomoProfiles', profiles);
    if (!store.get('activeMihomoProfile')) store.set('activeMihomoProfile', id);
    return profiles[id];
  }

  ipcMain.handle('mihomo:addText', (_e, opts) => addMihomoProfile(opts));
  ipcMain.handle('mihomo:addUrl', async (_e, { url, name, groupType }) => {
    const text = await tryDirectThenTunnel((addr) => httpsGetText(url, addr), anyLiveTunnelSocksAddress());
    return addMihomoProfile({ name, text, sourceUrl: url, groupType });
  });
  ipcMain.handle('mihomo:refresh', async (_e, id) => {
    const prof = (store.get('mihomoProfiles') || {})[id];
    if (!prof || !prof.sourceUrl) throw new Error('این پروفایل لینک سابسکریپشن ندارد.');
    const text = await tryDirectThenTunnel((addr) => httpsGetText(prof.sourceUrl, addr), anyLiveTunnelSocksAddress());
    mihomoManager.saveProfileContent(id, text);
    return true;
  });
  ipcMain.handle('mihomo:setGroupType', (_e, { id, groupType }) => {
    const profiles = store.get('mihomoProfiles') || {};
    if (!profiles[id]) throw new Error('پروفایل یافت نشد');
    profiles[id].groupType = groupType;
    store.set('mihomoProfiles', profiles);
    return profiles[id];
  });
  ipcMain.handle('mihomo:delete', (_e, id) => {
    const profiles = store.get('mihomoProfiles') || {};
    delete profiles[id];
    store.set('mihomoProfiles', profiles);
    mihomoManager.deleteProfileContent(id);
    if (store.get('activeMihomoProfile') === id) store.set('activeMihomoProfile', null);
    return true;
  });
  ipcMain.handle('mihomo:setActive', (_e, id) => { store.set('activeMihomoProfile', id); return true; });
  ipcMain.handle('mihomo:nodes', () => mihomoManager.getNodes());
  ipcMain.handle('mihomo:selectNode', (_e, name) => mihomoManager.selectNode(name));
  ipcMain.handle('mihomo:testAll', () => mihomoManager.testAll());

  // --- V2ray/Xray config management ---
  ipcMain.handle('v2ray:list', () => ({
    configs: store.get('v2rayConfigs'),
    activeId: store.get('activeV2rayConfig'),
    groups: store.get('v2rayGroups') || {},
    testResults: store.get('v2rayTestResults') || {}
  }));

  /** Creates the group an import lands in (one per subscription/paste/file). */
  function createGroup({ name, sourceUrl }) {
    const groups = store.get('v2rayGroups') || {};
    const id = crypto.randomUUID();
    groups[id] = { id, name, sourceUrl: sourceUrl || null, addedAt: new Date().toISOString() };
    store.set('v2rayGroups', groups);
    return groups[id];
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return null; }
  }

  function storeImportedResults(results, options = {}, group = null) {
    const configs = store.get('v2rayConfigs');
    const added = [];
    for (const r of results) {
      // Fragmenting the TLS ClientHello (splitting it across multiple TLS
      // records) is what defeats the classic "handshake completes, then
      // gets RST'd ~200ms later" active-SNI-blocking pattern seen in Iran
      // — record_fragment needs no elevated privileges, so it's the safe
      // default; full packet-level `fragment` does need admin rights on
      // Windows, so it stays opt-in. WireGuard entries have no `.outbound`
      // (they use `.endpoint` instead) and no TLS layer, so this is
      // naturally skipped for them.
      if (r.outbound && r.outbound.tls) {
        if (options.recordFragment !== false) r.outbound.tls.record_fragment = true;
        if (options.fragment) {
          r.outbound.tls.fragment = true;
          r.outbound.tls.fragment_fallback_delay = '500ms';
        }
      }
      const id = crypto.randomUUID();
      configs[id] = {
        id,
        groupId: group ? group.id : null,
        name: r.remark,
        protocol: r.protocol,
        addedAt: new Date().toISOString(),
        ...(r.outbound ? { outbound: r.outbound } : r.awg ? { awg: r.awg } : { endpoint: r.endpoint })
      };
      added.push(configs[id]);
    }
    store.set('v2rayConfigs', configs);
    if (added.length && !store.get('activeV2rayConfig')) {
      store.set('activeV2rayConfig', added[0].id);
    }
    return added;
  }

  function collectWarnings(results) {
    return results.filter((r) => r.warning).map((r) => ({ name: r.remark, warning: r.warning }));
  }

  ipcMain.handle('v2ray:import', (_e, text, options = {}) => {
    const { results, errors } = parseSubscription(text);
    if (!results.length) return { added: 0, errors, warnings: [] };
    const n = Object.keys(store.get('v2rayGroups') || {}).length + 1;
    const group = createGroup({ name: options.groupName || `دستی ${n}` });
    const added = storeImportedResults(results, options, group);
    return { added: added.length, errors, warnings: collectWarnings(results), groupId: group.id };
  });

  ipcMain.handle('v2ray:importFromUrl', async (_e, url, options = {}) => {
    // Subscription links (including "BPB panel"-style ones that return a
    // JSON array of full configs rather than plain vless://... lines) are
    // fetched here directly — same direct-then-tunnel fallback as the
    // core/scanner updaters, so a filtered subscription host doesn't need
    // a second VPN either once GozarVpn's own tunnel is up.
    const socksAddr = anyLiveTunnelSocksAddress();
    const text = await tryDirectThenTunnel((addr) => httpsGetText(url, addr), socksAddr);
    const { results, errors } = parseSubscription(text);
    if (!results.length) return { added: 0, errors, warnings: [] };
    const group = createGroup({ name: options.groupName || hostOf(url) || 'سابسکریپشن', sourceUrl: url });
    const added = storeImportedResults(results, options, group);
    return { added: added.length, errors, warnings: collectWarnings(results), groupId: group.id };
  });

  ipcMain.handle('v2ray:importConfFile', async (_e, options = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'انتخاب فایل .conf (WireGuard / AmneziaWG)',
      filters: [
        { name: 'WireGuard config', extensions: ['conf', 'txt'] },
        { name: 'All files', extensions: ['*'] }
      ],
      properties: ['openFile']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const text = fs.readFileSync(res.filePaths[0], 'utf8');
    const { results, errors } = parseSubscription(text);
    if (!results.length) return { added: 0, errors, warnings: [] };
    const group = createGroup({ name: options.groupName || path.basename(res.filePaths[0]) });
    const added = storeImportedResults(results, options, group);
    return { added: added.length, errors, warnings: collectWarnings(results), groupId: group.id };
  });

  // --- Subscription groups: delete / refresh / rename / test as a unit ---
  function configsOfGroup(groupId) {
    const all = store.get('v2rayConfigs');
    // groupId null/undefined = configs from before groups existed.
    return Object.values(all).filter((c) => (c.groupId || null) === (groupId || null));
  }

  ipcMain.handle('v2ray:deleteGroup', (_e, groupId) => {
    if (singboxManager.isRunning()) {
      const act = activeV2rayConfig();
      if (act && (act.groupId || null) === (groupId || null)) {
        throw new Error('کانفیگ فعالِ این گروه در حال استفاده است؛ ابتدا قطع اتصال کنید.');
      }
    }
    const configs = store.get('v2rayConfigs');
    let removed = 0;
    for (const c of configsOfGroup(groupId)) { delete configs[c.id]; removed++; }
    store.set('v2rayConfigs', configs);
    if (groupId) {
      const groups = store.get('v2rayGroups') || {};
      delete groups[groupId];
      store.set('v2rayGroups', groups);
    }
    const active = store.get('activeV2rayConfig');
    if (active && !configs[active]) store.set('activeV2rayConfig', null);
    return { removed };
  });

  ipcMain.handle('v2ray:renameGroup', (_e, { groupId, name }) => {
    const groups = store.get('v2rayGroups') || {};
    if (!groups[groupId]) throw new Error('گروه یافت نشد');
    groups[groupId].name = String(name || '').trim() || groups[groupId].name;
    store.set('v2rayGroups', groups);
    return groups[groupId];
  });

  ipcMain.handle('v2ray:refreshGroup', async (_e, { groupId, options = {} }) => {
    const groups = store.get('v2rayGroups') || {};
    const group = groups[groupId];
    if (!group || !group.sourceUrl) throw new Error('این گروه لینک سابسکریپشن ندارد.');
    const text = await tryDirectThenTunnel((addr) => httpsGetText(group.sourceUrl, addr), anyLiveTunnelSocksAddress());
    const { results, errors } = parseSubscription(text);
    if (!results.length) throw new Error('سابسکریپشن هیچ کانفیگ معتبری نداشت؛ گروه دست‌نخورده ماند.');

    // Swap the group's configs for the fresh ones, keeping the active
    // selection when a config with the same name still exists.
    const activeNow = activeV2rayConfig();
    const activeName = activeNow && (activeNow.groupId || null) === groupId ? activeNow.name : null;
    const configs = store.get('v2rayConfigs');
    for (const c of configsOfGroup(groupId)) delete configs[c.id];
    store.set('v2rayConfigs', configs);
    const added = storeImportedResults(results, options, group);
    if (activeName) {
      const same = added.find((c) => c.name === activeName);
      store.set('activeV2rayConfig', same ? same.id : (added[0] ? added[0].id : null));
    }
    return { added: added.length, errors, warnings: collectWarnings(results) };
  });

  // One shared test runner: several sing-box probes in parallel, live
  // progress to the UI, and a cancel flag that stops handing out new work.
  let testRun = null;
  // Last result per config is saved so a scan is still there after a restart;
  // a new test of the same config simply overwrites it.
  let pendingResults = {};
  let flushTimer = null;
  function rememberResult(id, result) {
    pendingResults[id] = { ok: !!result.ok, latencyMs: result.latencyMs, error: result.error, at: Date.now() };
    if (!flushTimer) flushTimer = setTimeout(flushResults, 1500);
  }
  function flushResults() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const all = store.get('v2rayTestResults') || {};
    const configs = store.get('v2rayConfigs');
    Object.assign(all, pendingResults);
    pendingResults = {};
    for (const id of Object.keys(all)) if (!configs[id]) delete all[id];
    store.set('v2rayTestResults', all);
  }
  async function runTests(cfgs) {
    if (testRun) throw new Error('یک تست در حال اجراست. صبر کنید یا آن را متوقف کنید.');
    const run = { cancelled: false, total: cfgs.length, done: 0 };
    testRun = run;
    const results = {};
    const queue = [...cfgs];
    // another VPN/TUN on this PC answers every TCP connect itself; results then describe its path
    const otherTun = await tunInterceptsTcp();
    send('v2ray:testRun', { state: 'start', total: run.total, done: 0, otherTun });
    try {
      await testMany(singboxUpdater.exePath, queue, {
        isCancelled: () => run.cancelled,
        onResult: (cfg, result) => {
          results[cfg.id] = result;
          run.done++;
          rememberResult(cfg.id, result);
          send('v2ray:testProgress', { id: cfg.id, result });
          send('v2ray:testRun', { state: 'progress', total: run.total, done: run.done });
        }
      });
    } finally {
      testRun = null;
      flushResults();
      send('v2ray:testRun', { state: run.cancelled ? 'cancelled' : 'done', total: run.total, done: run.done });
    }
    return results;
  }

  // Free Cloudflare WARP: register a device, store it as a WireGuard config.
  ipcMain.handle('v2ray:addWarp', async () => {
    const result = await tryDirectThenTunnel((addr) => registerWarp(addr), anyLiveTunnelSocksAddress());
    const group = createGroup({ name: 'Cloudflare WARP', sourceUrl: null });
    const added = storeImportedResults([result], {}, group);
    return { added: added.length, id: added[0].id };
  });

  ipcMain.handle('v2ray:testGroup', (_e, groupId) => runTests(configsOfGroup(groupId)));
  ipcMain.handle('v2ray:testAll', () => runTests(Object.values(store.get('v2rayConfigs'))));
  ipcMain.handle('v2ray:testCancel', () => { if (testRun) testRun.cancelled = true; return !!testRun; });
  ipcMain.handle('v2ray:testFavorites', () => runTests(Object.values(store.get('v2rayConfigs')).filter((c) => c.favorite)));

  ipcMain.handle('v2ray:toggleFavorite', (_e, id) => {
    const configs = store.get('v2rayConfigs');
    if (!configs[id]) throw new Error('کانفیگ یافت نشد');
    configs[id].favorite = !configs[id].favorite;
    store.set('v2rayConfigs', configs);
    return configs[id].favorite;
  });

  ipcMain.handle('v2ray:setFragment', (_e, { id, recordFragment, fragment }) => {
    const configs = store.get('v2rayConfigs');
    const cfg = configs[id];
    if (!cfg) throw new Error('کانفیگ یافت نشد');
    if (!cfg.outbound || !cfg.outbound.tls) throw new Error('این کانفیگ TLS ندارد (مثلاً WireGuard یا Shadowsocks ساده)، پس تکه‌کردن روی آن اثری ندارد.');
    cfg.outbound.tls.record_fragment = !!recordFragment;
    // set by hand: smart anti-DPI leaves this config alone from now on
    cfg.dpiManual = true;
    if (fragment) {
      cfg.outbound.tls.fragment = true;
      cfg.outbound.tls.fragment_fallback_delay = cfg.outbound.tls.fragment_fallback_delay || '500ms';
    } else {
      delete cfg.outbound.tls.fragment;
      delete cfg.outbound.tls.fragment_fallback_delay;
    }
    store.set('v2rayConfigs', configs);
    return cfg;
  });

  ipcMain.handle('v2ray:delete', (_e, id) => {
    const configs = store.get('v2rayConfigs');
    delete configs[id];
    store.set('v2rayConfigs', configs);
    if (store.get('activeV2rayConfig') === id) store.set('activeV2rayConfig', null);
    return true;
  });

  ipcMain.handle('v2ray:setActive', (_e, id) => {
    store.set('activeV2rayConfig', id);
    return true;
  });

  ipcMain.handle('v2ray:testOne', async (_e, id) => {
    const configs = store.get('v2rayConfigs');
    const cfg = configs[id];
    if (!cfg) throw new Error('کانفیگ یافت نشد');
    const result = cfg.awg ? await awg.testAwg(cfg.awg.conf, verifyTunnel) : await testOutbound(singboxUpdater.exePath, cfg);
    rememberResult(id, result);
    flushResults();
    return result;
  });
}

app.on('second-instance', () => {
  // Someone tried to open a second copy — surface the existing window
  // instead of letting a duplicate process start.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return; // already quitting, nothing to set up
  ensureCoreSeeded();
  wireCoreEvents();
  registerIpc();
  createWindow();

  // Stale-proxy recovery runs in the background rather than blocking the
  // window from appearing — in the common case (no leftover state) this
  // resolves almost instantly anyway, but there's no reason to ever make
  // first paint wait on it.
  systemProxy.recoverStaleState().then((recovered) => {
    if (recovered) coreManager.log('info', '[gui] پراکسی سیستم باقی‌مانده از اجرای قبلی (که به‌درستی بسته نشده بود) بازگردانده شد.');
  });
  openvpn.findOpenVpn(store.get('ui').openvpnExe).then((p) => { openvpnExe = p; });
  if (store.get('ui').autoUpdateCheck !== false) setTimeout(() => selfUpdater.check({ quiet: true }), 25000);
  openvpn.killLeftovers(openvpnRunDir);
  // kill-switch rules left by a crash: remove them now if we can, else the UI offers the emergency button
  if (killSwitch.leftover()) {
    isElevated().then((admin) => {
      if (admin) ksDisarm();
      else { coreManager.log('warn', '[gui] قوانین کیل‌سوییچ از اجرای قبلی مانده و اینترنت ممکن است بسته باشد؛ در تنظیمات «اضطراری: حذف قوانین» را بزنید.'); ksNotify(); }
    });
  }

  trayCtl = createTray({
    getState: () => ({ ...activeManager().getState(), tun: tunManager.isRunning() }),
    onConnect: () => {
      try { startActiveEngine(); } catch { /* surfaced in UI on next open */ }
    },
    onDisconnect: () => { activeManager().stop(); ksDisarm(); },
    onShow: () => { mainWindow.show(); mainWindow.focus(); },
    onQuit: () => { quitting = true; app.quit(); }
  });

  const ui = store.get('ui');
  if (ui.startMinimized) mainWindow.hide();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else { mainWindow.show(); }
  });
});

app.on('before-quit', () => {
  quitting = true;
  coreManager.stop();
  singboxManager.stop();
  mihomoManager.stop();
  torManager.stop();
  psiphonManager.stop();
  openvpnManager.stop();
  awgHelper.stop();
  tunManager.stop();
  routerManager.stop();
  if (systemProxy.applied) systemProxy.restore().catch(() => {});
  if (killSwitch.armed || killSwitch.leftover()) killSwitch.disarmSync();
  if (selfUpdater.downloaded && !selfUpdater.portableDir) selfUpdater.install({ restart: false });
});

app.on('window-all-closed', () => {
  if (!isWindows) app.quit();
});
