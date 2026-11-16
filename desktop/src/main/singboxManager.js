'use strict';

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { SINGBOX_SOCKS } = require('./constants');

/**
 * @param {{outbound?: object, endpoint?: object}} proxyEntry Either a
 *   regular outbound (VLESS/VMess/Trojan/Shadowsocks) or a WireGuard
 *   endpoint — sing-box moved WireGuard out of the "outbounds" array into
 *   a separate top-level "endpoints" concept (since 1.11.0; the old
 *   outbound-style config was removed entirely in 1.13.0), so the two
 *   need slightly different config shapes even though both end up as the
 *   route's `final` target.
 */
function buildConfig(proxyEntry, { socksAddr, httpAddr }) {
  const [socksHost, socksPort] = socksAddr.split(':');
  const [httpHost, httpPort] = httpAddr.split(':');

  const base = {
    log: { level: 'info', timestamp: true },
    // sing-box resolves proxy-server hostnames itself over plain UDP
    // instead of the Windows resolver: in TUN mode the system resolver's
    // queries are captured by the TUN and would need this very tunnel to
    // be answered.
    dns: { servers: [{ type: 'udp', tag: 'bootstrap', server: '1.1.1.1' }] },
    inbounds: [
      { type: 'socks', tag: 'socks-in', listen: socksHost, listen_port: Number(socksPort) },
      { type: 'http', tag: 'http-in', listen: httpHost, listen_port: Number(httpPort) }
    ],
    outbounds: [
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' }
    ],
    route: {
      rules: [{ ip_is_private: true, outbound: 'direct' }],
      default_domain_resolver: 'bootstrap',
      final: 'direct'
    }
  };

  if (proxyEntry.endpoint) {
    base.endpoints = [{ ...proxyEntry.endpoint, tag: 'proxy' }];
    base.route.final = 'proxy';
    return base;
  }

  base.outbounds.unshift({ ...proxyEntry.outbound, tag: 'proxy' });
  base.route.final = 'proxy';
  return base;
}

function classifyLine(line) {
  if (/tcp server started at\s+([^\s]+)/i.test(line)) {
    const m = line.match(/inbound\/(socks|http)\[[^\]]*\]:\s*tcp server started at\s+([^\s]+)/i);
    if (m) return { state: 'listening', kind: m[1], address: m[2] };
  }
  if (/sing-box started/i.test(line)) return { state: 'started' };
  if (/FATAL|panic:/i.test(line)) return { state: 'error' };
  if (/ERROR/i.test(line) && /outbound|connection refused|no route/i.test(line)) return { state: 'warn-error' };
  return null;
}

class SingboxManager extends EventEmitter {
  constructor(configDir) {
    super();
    this.configDir = configDir;
    this.proc = null;
    this.status = 'stopped';
    this.socksAddress = null;
    this.httpAddress = null;
    this.startedAt = null;
    this.logBuffer = [];
    this.maxLogLines = 4000;
    this._sawStartedLine = false;
  }

  isRunning() {
    return this.proc !== null;
  }

  getState() {
    return {
      status: this.status,
      address: this.socksAddress,
      socksAddress: this.socksAddress,
      httpAddress: this.httpAddress,
      startedAt: this.startedAt,
      running: this.isRunning()
    };
  }

  _setStatus(status, extra) {
    this.status = status;
    if (extra && extra.kind === 'http') this.httpAddress = extra.address;
    else if (extra && extra.kind === 'socks') this.socksAddress = extra.address;
    this.emit('status', this.getState());
  }

  _pushLog(level, text) {
    const entry = { t: Date.now(), level, text };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogLines) this.logBuffer.shift();
    this.emit('log', entry);
  }

  log(level, text) {
    this._pushLog(level, text);
  }

  clearLogs() {
    this.logBuffer = [];
  }

  start(exePath, proxyEntry) {
    if (this.proc) throw new Error('sing-box is already running');
    if (!fs.existsSync(exePath)) throw new Error(`sing-box.exe not found at ${exePath}`);

    fs.mkdirSync(this.configDir, { recursive: true });
    const configPath = path.join(this.configDir, 'config.json');
    const config = buildConfig(proxyEntry, { socksAddr: SINGBOX_SOCKS, httpAddr: `127.0.0.1:${Number(SINGBOX_SOCKS.split(':')[1]) + 1}` });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    this.socksAddress = null;
    this.httpAddress = null;
    this.startedAt = Date.now();
    this._sawStartedLine = false;

    const proc = spawn(exePath, ['run', '--disable-color', '-c', configPath], {
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
        this._pushLog(level, line);

        const c = classifyLine(line);
        if (!c) continue;
        if (c.state === 'listening') {
          this._setStatus('connected', { kind: c.kind, address: c.address });
        } else if (c.state === 'started') {
          this._sawStartedLine = true;
          if (this.status !== 'connected') this._setStatus('connected');
        } else if (c.state === 'error') {
          this._setStatus('error');
        }
      }
    };

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);

    proc.on('error', (err) => {
      this._pushLog('error', `[gui] failed to launch sing-box.exe: ${err.message}`);
      this.proc = null;
      this._setStatus('error');
    });

    proc.on('exit', (code, signal) => {
      this._pushLog('info', `[gui] sing-box process exited (code=${code}, signal=${signal})`);
      this.proc = null;
      this.socksAddress = null;
      this.httpAddress = null;
      this._setStatus('stopped');
    });

    return true;
  }

  stop() {
    if (!this.proc) return false;
    const pid = this.proc.pid;
    this._pushLog('info', `[gui] stopping sing-box (pid ${pid})…`);
    try {
      this.proc.kill();
    } catch (err) {
      this._pushLog('error', `[gui] error stopping sing-box: ${err.message}`);
    }
    setTimeout(() => {
      if (this.proc && this.proc.pid === pid) {
        this._pushLog('warn', '[gui] sing-box did not exit in time, forcing termination…');
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
        } else {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    }, 3000);
    return true;
  }

  stopAndWait(timeoutMs = 6000) {
    if (!this.proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.once('status', function onStatus(state) {
        if (!state.running) {
          clearTimeout(timer);
          resolve(true);
        } else {
          this.once('status', onStatus);
        }
      });
      this.stop();
    });
  }
}

module.exports = { SingboxManager, buildConfig };
