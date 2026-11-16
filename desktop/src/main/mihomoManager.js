'use strict';

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * Third connection engine: mihomo (Clash.Meta) — the core WhiteVPN-Desktop
 * is built on. Its value over sing-box is the subscription handling: a
 * provider file can be a Clash YAML (`proxies:`), a base64 blob or plain
 * vless:// / vmess:// / hysteria2:// … lines, and mihomo parses all of
 * them itself. Every node of the subscription goes into one `url-test`
 * group, so mihomo keeps picking the fastest working server on its own
 * and fails over when one dies.
 *
 * The config is written as JSON (valid YAML 1.2), so no YAML library is
 * needed on our side.
 */
const MIHOMO_SOCKS = '127.0.0.1:2039';
const MIHOMO_HTTP = '127.0.0.1:2040';
const MIHOMO_CONTROLLER = '127.0.0.1:2041';
const GROUP = 'GOZAR';

function buildMihomoConfig(providerPath, { groupType = 'url-test', secret, testUrl = 'https://www.gstatic.com/generate_204' } = {}) {
  const [, socksPort] = MIHOMO_SOCKS.split(':');
  const [, httpPort] = MIHOMO_HTTP.split(':');
  return {
    'socks-port': Number(socksPort),
    port: Number(httpPort),
    'bind-address': '127.0.0.1',
    'allow-lan': false,
    mode: 'rule',
    'log-level': 'info',
    ipv6: false,
    'external-controller': MIHOMO_CONTROLLER,
    secret,
    // store-selected: mihomo remembers the server picked in a `select` group across restarts
    profile: { 'store-selected': true, 'store-fake-ip': false },
    // Resolve server hostnames over plain UDP from mihomo itself (never the
    // Windows resolver, which the TUN adapter captures).
    dns: {
      enable: true,
      ipv6: false,
      'enhanced-mode': 'redir-host',
      nameserver: ['1.1.1.1', '8.8.8.8'],
      'proxy-server-nameserver': ['1.1.1.1', '8.8.8.8']
    },
    'proxy-providers': {
      sub: {
        type: 'file',
        path: providerPath,
        'health-check': { enable: true, url: testUrl, interval: 300, lazy: false }
      }
    },
    'proxy-groups': [
      groupType === 'select'
        ? { name: GROUP, type: 'select', use: ['sub'] }
        : { name: GROUP, type: groupType, use: ['sub'], url: testUrl, interval: 300, tolerance: 80 }
    ],
    rules: ['IP-CIDR,127.0.0.0/8,DIRECT', 'IP-CIDR,10.0.0.0/8,DIRECT', 'IP-CIDR,192.168.0.0/16,DIRECT', `MATCH,${GROUP}`]
  };
}

function classifyLine(line) {
  const socks = line.match(/SOCKS proxy listening at:\s*([^\s"]+)/i);
  if (socks) return { state: 'listening', kind: 'socks', address: socks[1] };
  const httpM = line.match(/HTTP proxy listening at:\s*([^\s"]+)/i);
  if (httpM) return { state: 'listening', kind: 'http', address: httpM[1] };
  if (/level=fatal|panic:|Parse config error/i.test(line)) return { state: 'error' };
  return null;
}

class MihomoManager extends EventEmitter {
  constructor(workDir) {
    super();
    this.workDir = workDir;
    this.proc = null;
    this.status = 'stopped';
    this.socksAddress = null;
    this.httpAddress = null;
    this.startedAt = null;
    this.secret = null;
    this.logBuffer = [];
    this.maxLogLines = 4000;
  }

  isRunning() { return this.proc !== null; }

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

  log(level, text) { this._pushLog(level, text); }
  clearLogs() { this.logBuffer = []; }

  /** Path where a profile's raw subscription text is stored. */
  profilePath(id) {
    return path.join(this.workDir, 'profiles', `${id}.txt`);
  }

  saveProfileContent(id, text) {
    fs.mkdirSync(path.dirname(this.profilePath(id)), { recursive: true });
    fs.writeFileSync(this.profilePath(id), text);
  }

  deleteProfileContent(id) {
    try { fs.unlinkSync(this.profilePath(id)); } catch { /* already gone */ }
  }

  start(exePath, profile) {
    if (this.proc) throw new Error('mihomo is already running');
    if (!fs.existsSync(exePath)) throw new Error('هسته‌ی mihomo نصب نشده. از تب «کانفیگ‌ها › Clash» دانلودش کنید.');
    const providerPath = this.profilePath(profile.id);
    if (!fs.existsSync(providerPath)) throw new Error('فایل این پروفایل پیدا نشد؛ دوباره اضافه‌اش کنید.');

    fs.mkdirSync(this.workDir, { recursive: true });
    this.secret = crypto.randomBytes(12).toString('hex');
    const configPath = path.join(this.workDir, 'config.yaml');
    fs.writeFileSync(configPath, JSON.stringify(buildMihomoConfig(providerPath, { groupType: profile.groupType, secret: this.secret }), null, 2));

    this.socksAddress = null;
    this.httpAddress = null;
    this.startedAt = Date.now();

    const proc = spawn(exePath, ['-d', this.workDir, '-f', configPath], {
      cwd: this.workDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.proc = proc;
    this._setStatus('starting');

    const handleChunk = (raw) => {
      for (const rawLine of raw.toString('utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const lm = line.match(/level=(\w+)/);
        let level = lm ? lm[1].toLowerCase() : 'info';
        if (level === 'warning') level = 'warn';
        if (level === 'fatal') level = 'error';
        this._pushLog(level, line);
        const c = classifyLine(line);
        if (!c) continue;
        if (c.state === 'listening') {
          // "connected" only once both listeners are up, so the GUI's
          // verify/system-proxy step has both addresses.
          this._setStatus(this.status, c);
          if (this.socksAddress && this.httpAddress) this._setStatus('connected');
        } else if (c.state === 'error') {
          this._setStatus('error');
        }
      }
    };
    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);

    proc.on('error', (err) => {
      this._pushLog('error', `[gui] failed to launch mihomo: ${err.message}`);
      this.proc = null;
      this._setStatus('error');
    });
    proc.on('exit', (code, signal) => {
      this._pushLog('info', `[gui] mihomo exited (code=${code}, signal=${signal})`);
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
    this._pushLog('info', `[gui] stopping mihomo (pid ${pid})…`);
    try { this.proc.kill(); } catch (err) { this._pushLog('error', `[gui] error stopping mihomo: ${err.message}`); }
    setTimeout(() => {
      if (this.proc && this.proc.pid === pid) {
        if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
        else { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      }
    }, 3000);
    return true;
  }

  stopAndWait(timeoutMs = 6000) {
    if (!this.proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      const onStatus = (state) => {
        if (!state.running) { clearTimeout(timer); resolve(true); } else this.once('status', onStatus);
      };
      this.once('status', onStatus);
      this.stop();
    });
  }

  _api(method, apiPath, body) {
    if (!this.proc) return Promise.reject(new Error('mihomo is not running'));
    const [host, port] = MIHOMO_CONTROLLER.split(':');
    return new Promise((resolve, reject) => {
      const req = http.request({
        host, port: Number(port), method, path: apiPath, timeout: 6000,
        headers: { Authorization: `Bearer ${this.secret}`, 'Content-Type': 'application/json' }
      }, (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`mihomo API ${res.statusCode}: ${data}`));
          try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('mihomo API timeout')));
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /** Nodes of the running group, the one in use, and their last delays. */
  async getNodes() {
    const group = await this._api('GET', `/proxies/${GROUP}`);
    const all = await this._api('GET', '/proxies');
    const nodes = (group.all || []).map((name) => {
      const p = (all.proxies || {})[name] || {};
      const hist = p.history || [];
      return { name, type: p.type, delay: hist.length ? hist[hist.length - 1].delay : null };
    });
    return { now: group.now, type: group.type, nodes };
  }

  /** Pin a node (only meaningful for a `select` group). */
  selectNode(name) {
    return this._api('PUT', `/proxies/${GROUP}`, { name });
  }

  /** Ask mihomo to re-test every node now. */
  testAll() {
    return this._api('GET', `/group/${GROUP}/delay?url=${encodeURIComponent('https://www.gstatic.com/generate_204')}&timeout=5000`);
  }
}

module.exports = { MihomoManager, buildMihomoConfig, MIHOMO_SOCKS };
