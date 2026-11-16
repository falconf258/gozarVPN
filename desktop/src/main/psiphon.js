'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Psiphon engine: run by the Aether core itself (its --psiphon / --psiphon-only modes, with
 * the public Psiphon config built into the core). We only ship psiphon-tunnel-core.exe,
 * built from source at the commit Aether pins (see resources/psiphon/README.txt).
 */
const PSIPHON_SOCKS = '127.0.0.1:1821';
const PSIPHON_HTTP = '127.0.0.1:1822';

function bundledPsiphonExe() {
  const packaged = path.join(process.resourcesPath || '', 'resources', 'psiphon', 'psiphon-tunnel-core.exe');
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'resources', 'psiphon', 'psiphon-tunnel-core.exe');
}

/** The official binary that Aether releases ship in pt/ wins; ours is the fallback. */
function psiphonExeFor(aetherExe) {
  const official = path.join(path.dirname(aetherExe), 'pt', 'psiphon-tunnel-core.exe');
  return fs.existsSync(official) ? official : bundledPsiphonExe();
}

// Aether before v2.4 has no Psiphon modes; the answer only changes when the core is updated.
const supportCache = new Map();
function aetherSupportsPsiphon(aetherExe) {
  let mtime = 0;
  try { mtime = fs.statSync(aetherExe).mtimeMs; } catch { return false; }
  const key = `${aetherExe}:${mtime}`;
  if (!supportCache.has(key)) {
    let help = '';
    try { help = execFileSync(aetherExe, ['--help'], { windowsHide: true, timeout: 8000, encoding: 'utf8' }); } catch (err) { help = `${err.stdout || ''}${err.stderr || ''}`; }
    supportCache.set(key, /--psiphon-only/.test(help));
  }
  return supportCache.get(key);
}

/**
 * Ends psiphon-tunnel-core processes left over from our own earlier runs (only our two binaries,
 * matched by path): a leftover keeps the Psiphon database locked and the next start fails with
 * "tryDatastoreOpenDB … timeout" / "psiphon stopped before it was ready".
 */
function killLeftovers(aetherExe) {
  if (process.platform !== 'win32') return;
  const paths = [path.join(path.dirname(aetherExe), 'pt', 'psiphon-tunnel-core.exe'), bundledPsiphonExe()].map((p) => p.toLowerCase());
  const ps = `Get-CimInstance Win32_Process -Filter "Name='psiphon-tunnel-core.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`;
  let out = '';
  try { out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000, encoding: 'utf8' }); } catch { return; }
  for (const line of out.split(/\r?\n/)) {
    const [pid, exe] = line.trim().split('|');
    if (pid && exe && paths.includes(exe.toLowerCase())) { try { process.kill(Number(pid)); } catch { /* already gone */ } }
  }
}

/** CoreManager.start options for the chosen route/mode/region. */
function launchOptions(ui, dataDir, aetherExe) {
  const only = ui.psiphonRoute === 'only';
  const env = {
    AETHER_PSIPHON_BIN: psiphonExeFor(aetherExe),
    AETHER_PSIPHON_DIR: dataDir,
    AETHER_PSIPHON_MODE: ui.psiphonMode || 'auto'
  };
  if (ui.psiphonRegion) env.AETHER_PSIPHON_REGION = String(ui.psiphonRegion).toUpperCase();
  if (only) {
    // psiphon-only serves Psiphon on the core's own --bind; its HTTP side comes from --psiphon-http
    // (tested: AETHER_HTTP_PROXY never opened a port in this mode, so "connected" never came)
    env.AETHER_SOCKS = PSIPHON_SOCKS;
    env.AETHER_PSIPHON_HTTP = PSIPHON_HTTP;
    env.AETHER_HTTP_PROXY = null;
  } else {
    env.AETHER_PSIPHON_BIND = PSIPHON_SOCKS;
    env.AETHER_PSIPHON_HTTP = PSIPHON_HTTP;
  }
  return { args: [only ? '--psiphon-only' : '--psiphon'], env, readyPorts: { socks: PSIPHON_SOCKS, http: PSIPHON_HTTP } };
}

module.exports = { bundledPsiphonExe, psiphonExeFor, killLeftovers, aetherSupportsPsiphon, launchOptions, PSIPHON_SOCKS };
