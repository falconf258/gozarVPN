'use strict';

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * Download/upload speed for the home screen and the usage log. The physical adapters' byte
 * counters also hold LAN traffic (file copies, remote desktop) and apps outside the VPN, so
 * the numbers shown come from what actually went through GozarVpn (see source()):
 *   'tun' - OpenVPN's tunnel adapter; LAN routes never use it
 *   'api' - the local sing-box (TUN, or the system-proxy router) counting its VPN connections
 *   'nic' - nothing better is available (plain system proxy): the physical adapters.
 * The physical adapters are always reported too, as nicDown/nicUp.
 */
const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $rx = 0; $tx = 0; $trx = 0; $ttx = 0
  Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface | ForEach-Object {
    if ($_.Name -notmatch 'wintun|gozar|sing-tun|openvpn|tap-windows|data channel offload|tunnel|loopback|isatap|teredo|virtual|vethernet|hyper-v|vmware|virtualbox|pseudo|wireguard') { $rx += [double]$_.BytesReceivedPersec; $tx += [double]$_.BytesSentPersec }
  }
  Get-NetAdapterStatistics -IncludeHidden | Where-Object { $_.Name -match 'openvpn' -or $_.InterfaceDescription -match 'openvpn|tap-windows' } | ForEach-Object { $trx += [double]$_.ReceivedBytes; $ttx += [double]$_.SentBytes }
  [Console]::Out.WriteLine("$rx $tx $trx $ttx")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 1000
}`;

class LiveStats extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.source = () => 'nic'; // set by the main process
    this.api = null; // { port, secret } of the router's stats API, while it runs
    this.apiSeen = new Map(); // connection id -> [download, upload] already counted
    this.apiPending = [0, 0];
  }

  /**
   * Bytes of the connections that sing-box (TUN or router) sent to the VPN, from its local
   * Clash API. Direct connections (the engine's own, Iran-direct sites, LAN) are left out.
   * shortcut: a connection's last ~1 s before it closes is not seen, fine for a usage meter;
   * an exact per-outbound counter needs a sing-box build with v2ray_api.
   */
  _pollApi() {
    const api = this.api;
    if (!api) { this.apiSeen = new Map(); return; }
    const req = http.get({ host: '127.0.0.1', port: api.port, path: '/connections', headers: { Authorization: `Bearer ${api.secret}` }, timeout: 900 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (this.api !== api) return;
        let conns;
        try { conns = JSON.parse(body).connections || []; } catch { return; /* restarting */ }
        const seen = new Map();
        for (const c of conns) {
          if (!Array.isArray(c.chains) || !c.chains.includes('proxy')) continue;
          const cur = [Number(c.download) || 0, Number(c.upload) || 0];
          const prev = this.apiSeen.get(c.id) || [0, 0];
          this.apiPending[0] += Math.max(0, cur[0] - prev[0]);
          this.apiPending[1] += Math.max(0, cur[1] - prev[1]);
          seen.set(c.id, cur);
        }
        this.apiSeen = seen;
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
  }

  start() {
    if (this.proc) return;
    const total = { down: 0, up: 0 };
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
        this._pollApi();
        if (last) {
          // a counter that went down (adapter re-created) counts as zero for that second
          const nicDown = Math.max(0, rx - last.rx), nicUp = Math.max(0, tx - last.tx);
          const tunDown = Math.max(0, trx - last.trx), tunUp = Math.max(0, ttx - last.ttx);
          const src = this.source();
          let down = nicDown, up = nicUp;
          if (src === 'tun') { down = tunDown; up = tunUp; } else if (src === 'api') { [down, up] = this.apiPending; }
          this.apiPending = [0, 0];
          total.down += down; total.up += up;
          this.emit('stats', { down, up, totalDown: total.down, totalUp: total.up, nicDown, nicUp, source: src });
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
