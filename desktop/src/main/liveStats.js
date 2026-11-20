'use strict';

const { spawn } = require('child_process');
const https = require('https');
const { EventEmitter } = require('events');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * Download/upload speed for the home screen. Windows keeps no per-app network counters we
 * can read cheaply, so this samples the physical adapters' byte counters once a second from
 * one long-lived PowerShell (virtual adapters, incl. our own TUN, are skipped so TUN mode
 * isn't counted twice). While connected nearly all of that traffic is the tunnel's.
 */
// second pair: the tunnel adapters (our TUN, OpenVPN's), i.e. what apps sent through the VPN
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $rx = 0; $tx = 0; $trx = 0; $ttx = 0
  Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | ForEach-Object {
    if ($_.Name -match 'wintun|gozar|openvpn|tap-windows|data channel offload') { $trx += [double]$_.BytesReceivedPersec; $ttx += [double]$_.BytesSentPersec }
    elseif ($_.Name -notmatch 'tunnel|loopback|isatap|teredo|virtual|vethernet|hyper-v|vmware|virtualbox|pseudo|wireguard') { $rx += [double]$_.BytesReceivedPersec; $tx += [double]$_.BytesSentPersec }
  }
  [Console]::Out.WriteLine("$rx $tx $trx $ttx")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}`;

class LiveStats extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
  }

  start() {
    if (this.proc) return;
    let base = null;
    let last = null;
    let buf = '';
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.proc = proc;
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const [rx, tx, trx = 0, ttx = 0] = line.trim().split(/\s+/).map(Number);
        if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
        if (!base) base = { rx, tx };
        if (last) {
          // a counter that went down (adapter re-created) counts as zero for that second
          this.emit('stats', {
            down: Math.max(0, rx - last.rx), up: Math.max(0, tx - last.tx),
            totalDown: Math.max(0, rx - base.rx), totalUp: Math.max(0, tx - base.tx),
            tunDown: Math.max(0, trx - last.trx), tunUp: Math.max(0, ttx - last.ttx),
          });
        }
        last = { rx, tx, trx, ttx };
      }
    });
    proc.on('exit', () => { if (this.proc === proc) this.proc = null; });
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.kill(); } catch { /* already gone */ }
    this.proc = null;
  }
}

/** Exit IP + country (Cloudflare's trace page) and the round-trip time, through the tunnel's SOCKS port. */
function exitInfo(socksAddr, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // no SOCKS port = a system tunnel (OpenVPN): a plain request already goes through it
    const req = https.get('https://cloudflare.com/cdn-cgi/trace', { agent: socksAddr ? new SocksProxyAgent(`socks5h://${socksAddr}`) : undefined, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        const kv = Object.fromEntries(body.split('\n').map((l) => l.split('=')).filter((p) => p.length === 2));
        resolve(kv.ip ? { ip: kv.ip, cc: kv.loc || '', ms: Date.now() - t0 } : null);
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

module.exports = { LiveStats, exitInfo };
