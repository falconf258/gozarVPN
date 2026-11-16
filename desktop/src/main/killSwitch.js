'use strict';

// Kill switch: while armed, Windows Firewall blocks every outbound connection except our own
// processes (the engines dial the real network), loopback (proxy mode), LAN/DHCP and the
// GozarTun adapter (TUN mode). If the engine dies, apps lose internet instead of leaking.
// Block rules always beat allow rules in Windows Firewall, so this flips the profiles'
// default outbound action to Block and adds allow rules; the original profile settings are
// saved to a file first and put back on disarm (also after a crash, on the next start).

const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GROUP = 'GozarVpn-KillSwitch';
const LAN = ['LocalSubnet', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10',
  '224.0.0.0/4', '255.255.255.255', 'fe80::/10', 'fc00::/7', 'ff00::/8'];

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function armScript(stateFile, programs) {
  const rule = (name, extra) => `New-NetFirewallRule -Group ${q(GROUP)} -DisplayName ${q(`GozarVpn kill switch: ${name}`)} -Direction Outbound -Action Allow -Profile Any ${extra} | Out-Null`;
  return [
    "$ErrorActionPreference = 'Stop'",
    // keep the settings from before the first arm (a re-arm must not save our own Block)
    `if (-not (Test-Path ${q(stateFile)})) { $p = @(Get-NetFirewallProfile | ForEach-Object { @{ Name = [string]$_.Name; Enabled = [string]$_.Enabled; Out = [string]$_.DefaultOutboundAction } }); ConvertTo-Json -InputObject $p | Set-Content -Encoding UTF8 ${q(stateFile)} }`,
    `Remove-NetFirewallRule -Group ${q(GROUP)} -ErrorAction SilentlyContinue`,
    rule('loopback', '-RemoteAddress 127.0.0.0/8,::1'),
    rule('LAN', `-RemoteAddress ${LAN.join(',')}`),
    rule('DHCP', '-Protocol UDP -LocalPort 68 -RemotePort 67'),
    rule('DHCPv6', '-Protocol UDP -LocalPort 546 -RemotePort 547'),
    ...programs.map((p, i) => rule(`app ${i + 1}`, `-Program ${q(p)}`)),
    // allow rules first, then the switch: no window where our engines are blocked
    'Set-NetFirewallProfile -All -Enabled True -DefaultOutboundAction Block',
  ].join('\n');
}

// [alias] may be a wildcard (OpenVPN's own adapters: 'OpenVPN*')
function tunScript(alias = 'GozarTun') {
  return `New-NetFirewallRule -Group ${q(GROUP)} -DisplayName ${q(`GozarVpn kill switch: tunnel ${alias}`)} -Direction Outbound -Action Allow -Profile Any -InterfaceAlias ${q(alias)} -ErrorAction Stop | Out-Null`;
}

function disarmScript(stateFile) {
  return [
    `Remove-NetFirewallRule -Group ${q(GROUP)} -ErrorAction SilentlyContinue`,
    `if (Test-Path ${q(stateFile)}) {`,
    `  foreach ($p in @(Get-Content -Raw ${q(stateFile)} | ConvertFrom-Json)) { Set-NetFirewallProfile -Name $p.Name -Enabled $p.Enabled -DefaultOutboundAction $p.Out }`,
    `  Remove-Item -Force ${q(stateFile)}`,
    '}',
  ].join('\n');
}

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(script)];

function runPs(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', psArgs(script), { windowsHide: true, timeout: 60000 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).toString().trim().split('\n')[0]));
      else resolve();
    });
  });
}

/** Runs [script] in an elevated PowerShell (UAC prompt) and waits for it. */
function runPsElevated(script) {
  const inner = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList ${psArgs(script).map(q).join(',')}`;
  return runPs(inner);
}

/** All .exe files under [dir] (a few levels deep): the engines live in userData and resources. */
function findExes(dir, depth = 4, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) findExes(p, depth - 1, out);
    else if (e.isFile() && /\.exe$/i.test(e.name)) out.push(p);
  }
  return out;
}

class KillSwitch {
  constructor(stateFile) {
    this.stateFile = stateFile;
    this.armed = false;
    this.tunAllowed = false;
  }

  /** Rules left over from a run that crashed or was killed (the state file still exists). */
  leftover() { return fs.existsSync(this.stateFile); }

  async arm(programs) {
    const list = [...new Set(programs.map((p) => path.resolve(p)))];
    await runPs(armScript(this.stateFile, list));
    this.armed = true;
    this.tunAllowed = false;
  }

  async allowTun() {
    if (!this.armed || this.tunAllowed) return;
    await runPs(tunScript());
    this.tunAllowed = true;
  }

  /** Lets traffic through another tunnel adapter (OpenVPN builds its own). */
  async allowAdapter(alias) {
    if (this.armed) await runPs(tunScript(alias));
  }

  async disarm({ elevate = false } = {}) {
    const script = disarmScript(this.stateFile);
    if (elevate) await runPsElevated(script); else await runPs(script);
    this.armed = false;
    this.tunAllowed = false;
  }

  /** Blocking version for app quit (an async child could be cut off when the process exits). */
  disarmSync() {
    try { execFileSync('powershell.exe', psArgs(disarmScript(this.stateFile)), { windowsHide: true, timeout: 30000 }); } catch { /* best-effort */ }
    this.armed = false;
    this.tunAllowed = false;
  }
}

module.exports = { KillSwitch, findExes, GROUP, armScript, disarmScript };
