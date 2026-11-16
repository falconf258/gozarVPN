'use strict';

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkAll } = require('./bridges');
const { httpsGetText, downloadToFile, sha256File, tryDirectThenTunnel } = require('./githubDownload');

/**
 * Fourth engine: Tor. The official Tor Expert Bundle (tor.exe + the
 * lyrebird pluggable transport + GeoIP files) is run as a child process,
 * exactly like the other engines, and exposes a local SOCKS5 port plus an
 * HTTP CONNECT tunnel port, so the system proxy and TUN layers work on it
 * unchanged.
 *
 * Reaching Tor from a filtered network means going through *bridges*.
 * They come from Delta-Kronecker/Tor-Bridges-Collector (a public list that
 * re-tests bridges every hour); a snapshot ships with the app so the very
 * first connection works offline, and the "update bridges" button
 * refreshes it.
 *
 * Approach credit: the bundle pin, the bridge lists and the idea of
 * mixing transports come from the MIT-licensed Delta-Kronecker/Delta-Tor.
 */
const TOR_SOCKS = '127.0.0.1:2059';
const TOR_HTTP = '127.0.0.1:2060';

// Official bundle, pinned by SHA-256 (same pin Delta-Tor ships; the hash is
// from the Tor Project's signed checksums for this release).
const BUNDLE_VERSION = '15.0.25';
const BUNDLE_NAME = `tor-expert-bundle-windows-x86_64-${BUNDLE_VERSION}`;
const BUNDLE_URL = `https://dist.torproject.org/torbrowser/${BUNDLE_VERSION}/${BUNDLE_NAME}.tar.gz`;
const BUNDLE_SHA256 = 'c1988c701de2f24f7d098d1d6d7f507b58f27740d097f29c246e0524d639b252';

const BRIDGE_RAW = 'https://raw.githubusercontent.com/Delta-Kronecker/Tor-Bridges-Collector/main/bridge';
const BRIDGE_FILES = ['obfs4', 'webtunnel', 'vanilla', 'snowflake'];
const BRIDGE_REMOTE_NAME = { obfs4: 'obfs4_tested.txt', webtunnel: 'webtunnel_tested.txt', vanilla: 'vanilla_tested.txt', snowflake: 'snowflake.txt' };

const MODES = ['auto', 'obfs4', 'webtunnel', 'snowflake', 'vanilla'];

/* ------------------------------------------------------------------ */
/* Bundle install                                                      */
/* ------------------------------------------------------------------ */

function findBundleRoot(dir) {
  const ok = (r) => fs.existsSync(path.join(r, 'tor', 'tor.exe'));
  if (ok(dir)) return dir;
  for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    if (entry.isDirectory() && ok(path.join(dir, entry.name))) return path.join(dir, entry.name);
  }
  return null;
}

class TorBundle {
  constructor(dir) {
    this.dir = dir; // userData/tor-bin
    this.versionFile = path.join(dir, 'tor-version.json');
  }

  root() { return findBundleRoot(this.dir); }
  hasBinary() { return !!this.root(); }
  torExe() { const r = this.root(); return r && path.join(r, 'tor', 'tor.exe'); }
  ptDir() { const r = this.root(); return r && path.join(r, 'tor', 'pluggable_transports'); }
  geoip() { const r = this.root(); return r && path.join(r, 'data', 'geoip'); }
  geoip6() { const r = this.root(); return r && path.join(r, 'data', 'geoip6'); }

  getInstalledVersion() {
    try { return JSON.parse(fs.readFileSync(this.versionFile, 'utf8')).tag || null; } catch { return null; }
  }

  _extract(archive, dest) {
    return new Promise((resolve, reject) => {
      // Windows 10/11 ship bsdtar as tar.exe, which reads .tar.gz natively.
      execFile('tar', ['-xzf', archive, '-C', dest], { windowsHide: true }, (err, _o, stderr) => {
        if (err) reject(new Error(`استخراج فایل Tor ناموفق بود: ${(stderr || err.message).toString().slice(0, 200)}`));
        else resolve();
      });
    });
  }

  async _installArchive(archive, tag, beforeSwap) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gozarvpn-tor-'));
    try {
      await this._extract(archive, tmp);
      if (!findBundleRoot(tmp)) throw new Error('داخل فایل، tor/tor.exe پیدا نشد؛ این فایل Tor Expert Bundle ویندوز نیست.');
      if (beforeSwap) await beforeSwap();
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.mkdirSync(this.dir, { recursive: true });
      fs.cpSync(tmp, this.dir, { recursive: true });
      fs.writeFileSync(this.versionFile, JSON.stringify({ tag, installedAt: new Date().toISOString() }, null, 2));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async install(onProgress, socksAddr, beforeSwap) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gozarvpn-torzip-'));
    const archive = path.join(tmp, `${BUNDLE_NAME}.tar.gz`);
    try {
      onProgress && onProgress({ phase: 'downloading', pct: 0 });
      await tryDirectThenTunnel(
        (addr) => downloadToFile(BUNDLE_URL, archive, (pct) => onProgress && onProgress({ phase: 'downloading', pct }), addr),
        socksAddr
      );
      const hash = await sha256File(archive);
      if (hash !== BUNDLE_SHA256) throw new Error('امضای SHA-256 فایل دانلودشده با مقدار رسمی Tor نمی‌خواند؛ نصب لغو شد.');
      onProgress && onProgress({ phase: 'extracting', pct: 1 });
      await this._installArchive(archive, BUNDLE_VERSION, beforeSwap);
      onProgress && onProgress({ phase: 'done', pct: 1 });
      return { updated: true, version: BUNDLE_VERSION };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Offline path: the person downloaded tor-expert-bundle-*.tar.gz by hand. */
  async installFromArchive(archivePath, beforeSwap) {
    await this._installArchive(archivePath, 'manual', beforeSwap);
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Bridges                                                             */
/* ------------------------------------------------------------------ */

class BridgeStore {
  constructor(dir, seedDir) {
    this.dir = dir; // userData/tor/bridges
    this.seedDir = seedDir; // src/main/bridges-seed
  }

  _file(kind) { return path.join(this.dir, `${kind}.txt`); }

  ensureSeeded() {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const kind of BRIDGE_FILES) {
      const dest = this._file(kind);
      const seed = path.join(this.seedDir, `${kind}.txt`);
      if (!fs.existsSync(dest) && fs.existsSync(seed)) fs.copyFileSync(seed, dest);
    }
  }

  load() {
    this.ensureSeeded();
    const out = {};
    for (const kind of BRIDGE_FILES) {
      let text = '';
      try { text = fs.readFileSync(this._file(kind), 'utf8'); } catch { /* none */ }
      out[kind] = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    }
    return out;
  }

  counts() {
    const b = this.load();
    return Object.fromEntries(BRIDGE_FILES.map((k) => [k, b[k].length]));
  }

  async update(socksAddr) {
    fs.mkdirSync(this.dir, { recursive: true });
    let got = 0;
    for (const kind of BRIDGE_FILES) {
      const url = `${BRIDGE_RAW}/${BRIDGE_REMOTE_NAME[kind]}`;
      const text = await tryDirectThenTunnel((addr) => httpsGetText(url, addr), socksAddr);
      if (text && text.trim()) { fs.writeFileSync(this._file(kind), text); got++; }
    }
    fs.writeFileSync(path.join(this.dir, 'updated.json'), JSON.stringify({ at: Date.now() }));
    return { files: got, counts: this.counts() };
  }

  updatedAt() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'updated.json'), 'utf8')).at; } catch { return null; }
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Pick the Bridge lines for a mode. Reshuffled every connect so one bad
 * bridge never poisons two attempts in a row. */
function pickBridges(all, mode, perKind = 40) {
  const take = (kind, n) => shuffle(all[kind] || []).slice(0, n).map((l) => (kind === 'vanilla' ? l : l));
  if (mode === 'auto') return [...take('obfs4', 30), ...take('webtunnel', 30), ...take('vanilla', 10)];
  return take(mode, perKind);
}

function tp(p) { return String(p).replace(/\\/g, '/'); }

function buildTorrc({ dataDir, geoip, geoip6, ptDir, bridges, mode }) {
  const lines = [
    `DataDirectory ${tp(dataDir)}`,
    `SocksPort ${TOR_SOCKS}`,
    `HTTPTunnelPort ${TOR_HTTP}`,
    'ClientOnly 1',
    'AvoidDiskWrites 1',
    'SafeSocks 0',
    'Log notice stdout'
  ];
  if (geoip && fs.existsSync(geoip)) lines.push(`GeoIPFile ${tp(geoip)}`);
  if (geoip6 && fs.existsSync(geoip6)) lines.push(`GeoIPv6File ${tp(geoip6)}`);
  if (bridges.length) {
    lines.push('UseBridges 1');
    const lyrebird = path.join(ptDir, 'lyrebird.exe');
    const snowflake = path.join(ptDir, 'snowflake-client.exe');
    // plugins for whatever transports the chosen lines use (the user's own lines can mix them)
    const kinds = new Set(bridges.map((b) => b.split(' ')[0]));
    const viaLyrebird = ['obfs4', 'webtunnel', 'meek_lite'].filter((k) => kinds.has(k) || (k !== 'meek_lite' && mode !== 'snowflake'));
    if (viaLyrebird.length) lines.push(`ClientTransportPlugin ${viaLyrebird.join(',')} exec ${tp(lyrebird)}`);
    if (mode === 'snowflake' || kinds.has('snowflake')) {
      lines.push(fs.existsSync(snowflake) ? `ClientTransportPlugin snowflake exec ${tp(snowflake)}` : `ClientTransportPlugin snowflake exec ${tp(lyrebird)}`);
    }
    for (const b of bridges) lines.push(`Bridge ${b}`);
  }
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

class TorManager extends EventEmitter {
  constructor(workDir) {
    super();
    this.workDir = workDir; // userData/tor
    this.proc = null;
    this.status = 'stopped';
    this.socksAddress = null;
    this.httpAddress = null;
    this.startedAt = null;
    this.progress = 0;
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
      progress: this.progress,
      running: this.isRunning()
    };
  }

  _setStatus(status) {
    this.status = status;
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

  /** @param {TorBundle} bundle @param {object} bridgeLists @param {string} mode */
  /** opts.custom: the user's own bridge lines (text); opts.onlyMine: use only those. */
  start(bundle, bridgeLists, mode = 'auto', opts = {}) {
    if (this.proc) throw new Error('Tor is already running');
    if (!bundle.hasBinary()) throw new Error('Tor نصب نشده. از تب «کانفیگ‌ها › Tor» دانلودش کنید.');
    if (!MODES.includes(mode)) mode = 'auto';

    const mine = checkAll(opts.custom).filter((v) => v.ok).map((v) => v.line);
    const builtIn = opts.onlyMine && mine.length ? [] : (mode === 'vanilla' && !(bridgeLists.vanilla || []).length ? [] : pickBridges(bridgeLists, mode));
    const bridges = [...mine, ...builtIn];
    // counts only: bridge lines carry certs that do not belong in a log
    if (mine.length) this._pushLog('info', `[gui] پل‌های شما: ${mine.length} پل${opts.onlyMine ? ' (فقط پل‌های شما)' : ''}`);
    if (!bridges.length && mode !== 'vanilla') {
      throw new Error('فهرست پل (bridge) خالی است. در تب Tor دکمه‌ی «به‌روزرسانی پل‌ها» را بزنید.');
    }

    fs.mkdirSync(this.workDir, { recursive: true });
    const dataDir = path.join(this.workDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const torrcPath = path.join(this.workDir, 'torrc');
    fs.writeFileSync(torrcPath, buildTorrc({
      dataDir, geoip: bundle.geoip(), geoip6: bundle.geoip6(), ptDir: bundle.ptDir(), bridges, mode
    }));

    this.socksAddress = null;
    this.httpAddress = null;
    this.progress = 0;
    this.startedAt = Date.now();
    this._pushLog('info', `[gui] Tor با ${bridges.length} پل (${mode}) شروع می‌شود…`);

    const proc = spawn(bundle.torExe(), ['-f', torrcPath], {
      cwd: path.dirname(bundle.torExe()),
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
        if (/\[(warn|warning)\]/i.test(line)) level = 'warn';
        else if (/\[err\]/i.test(line)) level = 'error';
        this._pushLog(level, line);
        const m = line.match(/Bootstrapped (\d+)%/);
        if (m) {
          this.progress = Number(m[1]);
          if (this.progress >= 100) {
            this.socksAddress = TOR_SOCKS;
            this.httpAddress = TOR_HTTP;
            this._setStatus('connected');
          } else {
            this._setStatus('starting');
          }
        } else if (this.status !== 'connected' && /\[err\]|Could not bind|Failed to parse\/validate config/i.test(line)) {
          // Only fatal start-up problems flip the engine to "error". Once
          // Tor has bootstrapped, stray log lines must never knock a working
          // connection (and its uptime timer) back to an error state.
          this._pushLog('error', `[gui] Tor مشکل راه‌اندازی گزارش کرد: ${line}`);
          this._setStatus('error');
        }
      }
    };
    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', handleChunk);

    proc.on('error', (err) => {
      this._pushLog('error', `[gui] failed to launch Tor: ${err.message}`);
      this.proc = null;
      this._setStatus('error');
    });
    proc.on('exit', (code, signal) => {
      this._pushLog('info', `[gui] Tor exited (code=${code}, signal=${signal})`);
      this.proc = null;
      this.socksAddress = null;
      this.httpAddress = null;
      this.progress = 0;
      this._setStatus('stopped');
    });
    return true;
  }

  stop() {
    if (!this.proc) return false;
    const pid = this.proc.pid;
    this._pushLog('info', `[gui] stopping Tor (pid ${pid})…`);
    try { this.proc.kill(); } catch (err) { this._pushLog('error', `[gui] error stopping Tor: ${err.message}`); }
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
}

module.exports = { TorManager, TorBundle, BridgeStore, buildTorrc, pickBridges, MODES, TOR_SOCKS, TOR_HTTP, BUNDLE_VERSION };
