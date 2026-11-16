'use strict';

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { ENV_SCHEMA, DEFAULT_SOCKS, DEFAULT_HTTP_PROXY } = require('./constants');

// Maps a settings object (as saved by the renderer) to the exact env vars
// the Rust core reads (see aether/src/cli.rs::parse_args). Using env vars
// directly means we never have to reproduce the CLI's flag parser.
function buildEnv(settings) {
  const env = {};
  for (const field of ENV_SCHEMA) {
    const envKey = field.envKey || field.key;
    const value = settings[field.key];
    if (value === undefined || value === null || value === '') continue;
    if (field.type === 'bool') {
      if (value) env[envKey] = '1';
      continue;
    }
    if (field.type === 'textarea') {
      // Newline-or-comma separated lists are accepted as-is by the core.
      env[envKey] = String(value).trim();
      continue;
    }
    env[envKey] = String(value);
  }
  // The HTTP proxy is force-enabled even if the user never turned it on:
  // Windows' system-wide proxy setting needs an "http="/"https=" mapping
  // as well as "socks=", or many apps (notably Chromium-based browsers)
  // fail to route ANY traffic — not just unproxied traffic — once a
  // SOCKS-only proxy string is set system-wide. See systemProxy.js.
  if (!env.AETHER_HTTP_PROXY) env.AETHER_HTTP_PROXY = DEFAULT_HTTP_PROXY;
  // Force predictable, colorless, line-based logs so we can parse them.
  env.RUST_LOG_STYLE = 'never';
  env.NO_COLOR = '1';
  return env;
}

// Recognizes the handful of log lines that matter for GUI state, based on
// the literal strings the core prints (see aether/src/lib.rs / socks.rs).
// SOCKS and HTTP listener lines are told apart (not merged into one
// "address") because the system proxy needs both separately.
function classifyLine(line) {
  const stripped = line.replace(/^\[[^\]]*\]\s*/, '');

  const socksMatch = stripped.match(/socks5 server listening on\s+([^\s]+)/i);
  if (socksMatch) return { state: 'connected', kind: 'socks', address: socksMatch[1] };

  const httpMatch = stripped.match(/http proxy listening on\s+([^\s]+)/i);
  if (httpMatch) return { state: 'connected', kind: 'http', address: httpMatch[1] };

  if (/hunting for a working|verifying (the )?endpoint|verifying cached gateway|retrying last known-good/i.test(stripped)) {
    return { state: 'scanning' };
  }
  if (/using cloudflare edge|selected MASQUE gateway|using forced peer/i.test(stripped)) {
    return { state: 'gateway-selected' };
  }
  if (/tunnel closed|tunnel ended|no usable .*(endpoint|gateway) found|rescanning/i.test(stripped)) {
    return { state: 'reconnecting' };
  }
  if (/ERROR/.test(line)) {
    return { state: 'error' };
  }
  return null;
}

class CoreManager extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.status = 'stopped'; // stopped | starting | scanning | connected | reconnecting | error
    this.address = null; // kept for backward compat = socksAddress
    this.socksAddress = null;
    this.httpAddress = null;
    this.startedAt = null;
    this.logBuffer = [];
    this.maxLogLines = 4000;
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
    else if (extra && extra.address) this.socksAddress = extra.address;
    this.emit('status', this.getState());
  }

  _pushLog(level, text) {
    const entry = { t: Date.now(), level, text };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogLines) this.logBuffer.shift();
    this.emit('log', entry);
  }

  /**
   * @param {object} [opts] extra launch options, used by the Psiphon engine (which runs this same core):
   *   args: extra CLI flags; env: extra env vars (null removes one); readyPorts: {socks, http} that
   *   become "connected" when the core logs "psiphon is ready" (its own listener lines describe its
   *   own ports, not Psiphon's; poking the port instead made Psiphon log an EOF error every second).
   */
  start(exePath, settings, opts = {}) {
    if (this.proc) {
      throw new Error('core is already running');
    }
    if (!fs.existsSync(exePath)) {
      throw new Error(`aether.exe not found at ${exePath}`);
    }

    const env = { ...process.env, ...buildEnv(settings), ...(opts.env || {}) };
    for (const k of Object.keys(env)) if (env[k] == null) delete env[k];
    const cwd = path.dirname(exePath);

    this.address = null;
    this.socksAddress = null;
    this.httpAddress = null;
    this.startedAt = Date.now();

    const proc = spawn(exePath, opts.args || [], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc = proc;
    // Only mark "starting" once this.proc is actually set, so getState()
    // (and therefore the Connect/Disconnect button) reports running:true
    // from the very first status event instead of momentarily reporting
    // running:false and leaving the UI stuck on "Connect".
    this._setStatus('starting');

    const handleChunk = (raw) => {
      const text = raw.toString('utf8');
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        let level = 'info';
        const lm = line.match(/\b(ERROR|WARN|INFO|DEBUG|TRACE)\b/);
        if (lm) level = lm[1].toLowerCase();

        this._pushLog(level, line);

        if (opts.readyPorts && this.status !== 'connected' && /psiphon is ready/i.test(line)) {
          this._setStatus('connected', { kind: 'socks', address: opts.readyPorts.socks });
          this._setStatus('connected', { kind: 'http', address: opts.readyPorts.http });
          continue;
        }
        const classification = classifyLine(line);
        if (classification) {
          if (classification.state === 'connected' && opts.readyPorts) {
            // the core's own listener; Psiphon readiness comes from its "is ready" line below
          } else if (classification.state === 'connected') {
            this._setStatus('connected', classification.kind === 'http'
              ? { kind: 'http', address: classification.address }
              : { kind: 'socks', address: classification.address || DEFAULT_SOCKS });
          } else if (classification.state === 'error') {
            // Don't downgrade an already-connected tunnel just because one
            // line logged at ERROR (e.g. a single probe failing during
            // background rescanning); only reflect it if we're not already up.
            if (this.status !== 'connected') this._setStatus('error');
          } else if (this.status !== 'connected' || classification.state === 'reconnecting') {
            this._setStatus(classification.state);
          }
        }
      }
    };

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);

    proc.on('error', (err) => {
      this._pushLog('error', `[gui] failed to launch aether.exe: ${err.message}`);
      this.proc = null;
      this._setStatus('error');
    });

    proc.on('exit', (code, signal) => {
      this._pushLog('info', `[gui] core process exited (code=${code}, signal=${signal})`);
      this.proc = null;
      this.address = null;
      this.socksAddress = null;
      this.httpAddress = null;
      this._setStatus('stopped');
    });

    return true;
  }

  stop() {
    if (!this.proc) return false;
    const pid = this.proc.pid;
    this._pushLog('info', `[gui] stopping core (pid ${pid})…`);
    // On Windows kill() ends aether.exe alone and its Psiphon/Tor children kept running
    // (found orphaned psiphon-tunnel-core.exe processes). The tree kill must come first:
    // once aether.exe is gone, taskkill /T can no longer find its children.
    const proc = this.proc;
    const killSelf = () => {
      try { proc.kill(); } catch (err) { this._pushLog('error', `[gui] error stopping core: ${err.message}`); }
    };
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], (err) => { if (err) killSelf(); });
    else killSelf();

    // Belt-and-suspenders: on Windows, child.kill() is normally an
    // immediate forceful terminate, but if for any reason the process is
    // still alive a couple seconds later (e.g. it spawned its own
    // detached helper, or the handle was already stale), fall back to
    // `taskkill /T /F` which kills the whole process tree by PID. This is
    // what fixes "Disconnect does nothing" if it ever happens.
    setTimeout(() => {
      if (this.proc && this.proc.pid === pid) {
        this._pushLog('warn', '[gui] core did not exit in time, forcing termination…');
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
        } else {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      }
    }, 3000);

    return true;
  }

  /**
   * Like stop(), but resolves only once the process has actually exited
   * (or after a hard timeout) — needed before overwriting aether.exe on
   * disk, since Windows generally won't let a running executable be
   * renamed/replaced out from under itself.
   */
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

  clearLogs() {
    this.logBuffer = [];
  }

  /** Lets other main-process modules (e.g. systemProxy) surface messages
   * in the same live log console the core's own output goes to. */
  log(level, text) {
    this._pushLog(level, text);
  }
}

module.exports = { CoreManager, buildEnv };
