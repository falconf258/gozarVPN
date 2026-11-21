'use strict';

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const routing = require('./routing');

/**
 * Real system-wide TUN mode (no system proxy involved).
 *
 * A second sing-box process owns a Wintun virtual adapter (sing-box's
 * Windows build embeds the Wintun driver, so no separate wintun.dll is
 * needed) with auto_route, and forwards EVERYTHING it captures to the
 * local SOCKS5 listener of whichever engine is connected (Aether or the
 * V2ray/Xray sing-box). Layering it on top of the engine's SOCKS port —
 * instead of putting a tun inbound inside the engine's own config — keeps
 * three properties:
 *   1. It works identically for every engine (Aether only speaks SOCKS5).
 *   2. It's only started AFTER verifyTunnel() proved the tunnel carries
 *      traffic, so a dead tunnel can never black-hole the whole machine
 *      (same rule the system-proxy path follows).
 *   3. Stopping it is just killing one process; Windows removes the
 *      adapter and its routes with it.
 *
 * Loop prevention: the engines' own outgoing connections must NOT be
 * captured by the TUN, or they'd be sent into their own tunnel. They're
 * excluded by process name (route rule) and sing-box's
 * auto_detect_interface binds its own direct/outbound sockets to the real
 * NIC.
 */
const TUN_EXE_NAME = 'gozar-tun.exe';
const DEFAULT_BYPASS_PROCESSES = ['aether.exe', 'sing-box.exe', 'mihomo.exe', 'cfst.exe', 'tor.exe', 'lyrebird.exe', 'snowflake-client.exe', TUN_EXE_NAME];

/**
 * opts.routing / opts.rulesUserDir: Iran-direct routing (see routing.js).
 * opts.mixedListen ('127.0.0.1:2080'): build the system-proxy "router" instead: a local
 * HTTP+SOCKS listener applying the same rules in front of the engine, no adapter, no admin.
 * opts.statsApi ({ port, secret }): a local-only Clash API, read for the byte totals (liveStats.js).
 */
function buildTunConfig(upstreamSocks, opts = {}) {
  const [host, portStr] = upstreamSocks.split(':');
  const bypass = Array.from(new Set([...(opts.bypassProcesses || []), ...DEFAULT_BYPASS_PROCESSES]));
  const remoteDns = opts.remoteDns || '1.1.1.1';
  const directDns = opts.directDns || '1.1.1.1';

  const cfg = {
    log: { level: opts.logLevel || 'warn', timestamp: true },
    ...(opts.statsApi ? { experimental: { clash_api: { external_controller: `127.0.0.1:${opts.statsApi.port}`, secret: opts.statsApi.secret } } } : {}),
    dns: {
      // New (1.12+) typed DNS server format. DNS queries hijacked from the
      // TUN are answered over DoH *through the tunnel* so the ISP never
      // sees (or poisons) them.
      servers: [
        { type: 'https', tag: 'dns-remote', server: remoteDns, detour: 'proxy' },
        { type: 'udp', tag: 'dns-direct', server: directDns }
      ],
      final: 'dns-remote',
      strategy: 'ipv4_only'
    },
    inbounds: [
      {
        type: 'tun',
        tag: 'tun-in',
        interface_name: 'GozarTun',
        address: ['172.19.0.1/30'],
        mtu: 9000,
        auto_route: true,
        strict_route: true,
        stack: opts.stack || 'mixed'
      }
    ],
    outbounds: [
      { type: 'socks', tag: 'proxy', server: host, server_port: Number(portStr), version: '5' },
      { type: 'direct', tag: 'direct' }
    ],
    route: {
      auto_detect_interface: true,
      default_domain_resolver: 'dns-direct',
      rules: [
        { action: 'sniff' },
        // Bypass must come before hijack-dns: an engine resolving its own
        // server hostname must not have that query answered *through*
        // itself (deadlock on first connect).
        { process_name: bypass, outbound: 'direct' },
        { protocol: 'dns', action: 'hijack-dns' },
        { ip_is_private: true, outbound: 'direct' }
      ],
      final: 'proxy'
    }
  };
  if (opts.mixedListen) {
    const [lh, lp] = opts.mixedListen.split(':');
    cfg.inbounds = [{ type: 'mixed', tag: 'router-in', listen: lh, listen_port: Number(lp) }];
    // only proxied apps reach it: no adapter, no process bypass, no DNS to hijack
    cfg.route.rules = [{ action: 'sniff' }, { ip_is_private: true, outbound: 'direct' }];
    return routing.apply(cfg, opts.routing, opts.rulesUserDir, 1);
  }
  // after sniff, the engines' own bypass and hijack-dns
  return routing.apply(cfg, opts.routing, opts.rulesUserDir, 3);
}

/** `fltmc` only succeeds from an elevated process — the cheapest reliable
 * "am I admin?" check on Windows that needs no native module. */
function isElevated() {
  if (process.platform !== 'win32') return Promise.resolve(typeof process.getuid === 'function' && process.getuid() === 0);
  return new Promise((resolve) => {
    execFile('fltmc', [], { windowsHide: true }, (err) => resolve(!err));
  });
}

class TunManager extends EventEmitter {
  constructor(configDir) {
    super();
    this.configDir = configDir;
    this.proc = null;
    this.status = 'stopped'; // stopped | starting | up | error
    this.upstream = null;
  }

  isRunning() {
    return this.proc !== null;
  }

  getState() {
    return { status: this.status, upstream: this.upstream, running: this.isRunning() };
  }

  _setStatus(status) {
    this.status = status;
    this.emit('status', this.getState());
  }

  _log(level, text) {
    this.emit('log', { t: Date.now(), level, text });
  }

  start(exePath, upstreamSocks, opts = {}) {
    if (this.proc) throw new Error('TUN is already running');
    if (!fs.existsSync(exePath)) throw new Error('برای حالت TUN، هسته‌ی sing-box لازم است. از تب «کانفیگ‌ها» آن را دانلود کنید.');

    fs.mkdirSync(this.configDir, { recursive: true });
    const configPath = path.join(this.configDir, 'tun-config.json');
    fs.writeFileSync(configPath, JSON.stringify(buildTunConfig(upstreamSocks, opts), null, 2));

    // Run a private copy of sing-box, never the installed sing-box.exe:
    // Windows refuses to overwrite a running exe (EBUSY), so while TUN was
    // up the sing-box updater could not replace the file.
    const tunExe = path.join(this.configDir, TUN_EXE_NAME);
    try {
      const src = fs.statSync(exePath);
      let same = false;
      try { const dst = fs.statSync(tunExe); same = dst.size === src.size && dst.mtimeMs >= src.mtimeMs; } catch { /* not copied yet */ }
      if (!same) fs.copyFileSync(exePath, tunExe);
    } catch (err) {
      throw new Error(`could not prepare TUN helper: ${err.message}`);
    }

    this.upstream = upstreamSocks;
    const proc = spawn(tunExe, ['run', '--disable-color', '-c', configPath], {
      cwd: this.configDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc = proc;
    this._setStatus('starting');

    const handleChunk = (raw) => {
      for (const rawLine of raw.toString('utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        let level = 'info';
        const lm = line.match(/\b(FATAL|ERROR|WARN|INFO|DEBUG|TRACE)\b/);
        if (lm) level = lm[1].toLowerCase();
        this._log(level === 'fatal' ? 'error' : level, `[tun] ${line}`);
        if (/sing-box started/i.test(line)) this._setStatus('up');
        else if (/FATAL|panic:|access is denied|requires administrator/i.test(line)) this._setStatus('error');
      }
    };
    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);

    proc.on('error', (err) => {
      this._log('error', `[tun] failed to launch: ${err.message}`);
      this.proc = null;
      this._setStatus('error');
    });
    proc.on('exit', (code) => {
      this._log('info', `[tun] TUN adapter closed (code=${code})`);
      const wasError = this.status === 'error' || (code !== 0 && code !== null && this.status !== 'up');
      this.proc = null;
      this.upstream = null;
      this._setStatus(wasError ? 'error' : 'stopped');
    });
    return true;
  }

  stop() {
    if (!this.proc) return false;
    const pid = this.proc.pid;
    try { this.proc.kill(); } catch { /* already gone */ }
    setTimeout(() => {
      if (this.proc && this.proc.pid === pid && process.platform === 'win32') {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
      }
    }, 3000);
    return true;
  }
}

module.exports = { TunManager, buildTunConfig, isElevated, DEFAULT_BYPASS_PROCESSES };
