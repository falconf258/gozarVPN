'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

/**
 * AmneziaWG: WireGuard with junk/header obfuscation (Jc, Jmin, Jmax, S1-S4, H1-H4, I1-I5) that
 * stock sing-box cannot do. wireproxy-awg (ISC) runs it in userspace and serves a local SOCKS
 * port; sing-box then uses that port as its outbound, so proxy/TUN/routing work unchanged.
 * Same rules as the Android app (data/AwgConf.kt). The PrivateKey is never logged.
 */
const AWG_KEYS = new Set(['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1', 'I2', 'I3', 'I4', 'I5']);
const AWG_SOCKS_PORT = 2069;

function sections(conf) {
  const out = [];
  for (const raw of String(conf).split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^\[(\w+)\]$/);
    if (head) out.push({ name: head[1], lines: [] });
    else if (out.length && line && !line.startsWith('#') && !line.startsWith(';')) out[out.length - 1].lines.push(line);
  }
  return out;
}
const keysOf = (lines) => lines.filter((l) => l.indexOf('=') > 0).map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]);
const sec = (conf, name) => sections(conf).find((s) => s.name.toLowerCase() === name.toLowerCase());

function isAmnezia(conf) {
  const iface = sec(conf, 'Interface');
  return !!iface && keysOf(iface.lines).some(([k]) => AWG_KEYS.has(k));
}

function endpoint(conf) {
  const peer = sec(conf, 'Peer');
  const e = peer && keysOf(peer.lines).find(([k]) => k.toLowerCase() === 'endpoint');
  return e ? e[1] : null;
}

/** Only [Interface] and [Peer] kept (the user's own proxy sections dropped) plus our [Socks5]. */
function forProxy(conf, port) {
  let out = '';
  for (const s of sections(conf)) {
    if (!['interface', 'peer'].includes(s.name.toLowerCase())) continue;
    out += `[${s.name}]\n${s.lines.join('\n')}\n\n`;
  }
  return `${out}[Socks5]\nBindAddress = 127.0.0.1:${port}\n`;
}

function bundledExe() {
  const packaged = path.join(process.resourcesPath || '', 'resources', 'awg', 'awg-proxy.exe');
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'resources', 'awg', 'awg-proxy.exe');
}

const redact = (line) => line.replace(/(private_?key\s*[=:]\s*)\S+/gi, '$1***');

/** Runs one wireproxy-awg process; its conf (with the key) lives in a private temp file. */
class AwgHelper {
  constructor(log) {
    this.proc = null;
    this.file = null;
    this.log = log || (() => {});
  }

  start(conf, port = AWG_SOCKS_PORT) {
    this.stop();
    const exe = bundledExe();
    if (!fs.existsSync(exe)) throw new Error('هسته‌ی AmneziaWG (awg-proxy.exe) در برنامه پیدا نشد.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gozar-awg-'));
    this.file = path.join(dir, 'awg.conf');
    fs.writeFileSync(this.file, forProxy(conf, port), { mode: 0o600 });
    this.log('info', `[awg] AmneziaWG به ${endpoint(conf) || '?'} روی پورت ${port}`);
    const proc = spawn(exe, ['-c', this.file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    const onData = (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const l = line.trim();
        // the device logs every keepalive; keep handshake news and problems only
        if (l && /handshake|error|fail|unable|listen/i.test(l)) this.log(/error|fail|unable/i.test(l) ? 'warn' : 'info', `[awg] ${redact(l)}`);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (code) => { if (this.proc === proc) { this.log('info', `[awg] پروسه تمام شد (کد ${code})`); this.proc = null; this._cleanup(); } });
    return `127.0.0.1:${port}`;
  }

  stop() {
    if (this.proc) {
      const pid = this.proc.pid;
      this.proc = null;
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
    }
    this._cleanup();
  }

  _cleanup() {
    if (this.file) { fs.rm(path.dirname(this.file), { recursive: true, force: true }, () => {}); this.file = null; }
  }
}

function waitPort(port, ms) {
  const deadline = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => { s.destroy(); if (Date.now() > deadline) resolve(false); else setTimeout(tick, 250); });
    };
    tick();
  });
}

/** A real handshake test: the engine on a spare port, one real request through it. */
async function testAwg(conf, verifyTunnel) {
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on('error', reject); });
  const h = new AwgHelper();
  try {
    h.start(conf, port);
    if (!(await waitPort(port, 8000))) return { ok: false, error: 'هسته‌ی AmneziaWG بالا نیامد' };
    const r = await verifyTunnel(`127.0.0.1:${port}`, { timeoutMs: 10000 });
    return r.ok ? { ok: true, latencyMs: r.latencyMs } : { ok: false, error: 'دست‌دادن AmneziaWG انجام نشد' };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    h.stop();
  }
}

module.exports = { isAmnezia, endpoint, forProxy, AwgHelper, testAwg, waitPort, bundledExe, AWG_SOCKS_PORT };
