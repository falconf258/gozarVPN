'use strict';

// OpenVPN engine (Windows). Runs the official openvpn.exe (OpenVPN Community, GPLv2) as a
// separate program; nothing of it is part of GozarVpn. It builds its own system tunnel, so the
// app's TUN / system-proxy modes are not used with it.

const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');

/* ------------------------------ .ovpn parsing ------------------------------ */

// Directives that run programs, load code, write files or take over the management port. Configs
// come from public Telegram groups and openvpn.exe runs as Administrator, so these never pass.
const BLOCKED = new Set([
  'up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'tls-verify', 'auth-user-pass-verify',
  'client-connect', 'client-disconnect', 'learn-address', 'plugin', 'script-security', 'setenv-safe',
  'management', 'management-client', 'management-hold', 'management-query-passwords', 'management-signal',
  'management-forget-disconnect', 'management-external-key', 'management-external-cert', 'management-client-auth',
  'management-up-down', 'management-log-cache', 'management-query-proxy', 'management-query-remote',
  'log', 'log-append', 'config', 'cd', 'chroot', 'writepid', 'status', 'status-version', 'daemon', 'service',
  'tmp-dir', 'askpass', 'tls-export-cert', 'dns-updown', 'auth-gen-token-secret', 'replay-persist',
  'ifconfig-pool-persist', 'syslog', 'user', 'group', 'mlock', 'cryptoapicert', 'win-sys',
]);
const SERVER_ONLY = new Set(['server', 'server-bridge', 'mode', 'tls-server', 'client-config-dir', 'dh', 'push']);
const INLINE = new Set(['ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'pkcs12', 'secret', 'extra-certs', 'crl-verify', 'auth-user-pass', 'http-proxy-user-pass', 'peer-fingerprint']);
const LEGACY_CIPHER = /^(BF|DES|DESX|RC2|RC4|CAST|CAST5|SEED|IDEA)\b|^DES-/i;

/** Splits a config line into words (OpenVPN quoting: "..." and '...', backslash escapes). */
function words(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { quote = c; any = true; }
    else if (c === '\\' && i + 1 < line.length) { cur += line[++i]; any = true; }
    else if (/\s/.test(c)) { if (any) { out.push(cur); cur = ''; any = false; } }
    else if ((c === '#' || c === ';') && !any) break;
    else { cur += c; any = true; }
  }
  if (any) out.push(cur);
  return out;
}

/**
 * Reads an .ovpn text. Returns { ok, lines (cleaned config), remotes [{host, port, proto}],
 * needsAuth, cipher, removed [directive names], problems [Persian messages] }.
 * Inline blocks (<ca>...</ca>) are kept verbatim; dangerous directives are dropped.
 */
function parseOvpn(text) {
  const src = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  const remotes = [];
  const removed = [];
  const problems = [];
  const inline = new Set();
  let defPort = '1194';
  let defProto = 'udp';
  let needsAuth = false;
  let cipher = null;
  let dataCiphers = false;
  let compression = false;
  let isServer = false;
  let fileRefs = [];
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const t = raw.trim();
    const open = t.match(/^<([a-z0-9-]+)>$/i);
    if (open) {
      const tag = open[1].toLowerCase();
      const end = src.findIndex((l, j) => j > i && l.trim().toLowerCase() === `</${tag}>`);
      if (end < 0) { problems.push(`بلوک <${tag}> بسته نشده است`); break; }
      if (INLINE.has(tag) || tag === 'connection') {
        if (tag === 'connection') {
          // a <connection> block holds its own remote; keep it and read the remote for the list
          for (const l of src.slice(i + 1, end)) {
            const w = words(l.trim());
            if (w[0] && w[0].toLowerCase() === 'remote' && w[1]) remotes.push({ host: w[1], port: w[2] || defPort, proto: (w[3] || '').toLowerCase() || null });
            if (w[0] && BLOCKED.has(w[0].toLowerCase())) { removed.push(w[0]); }
          }
          lines.push(...src.slice(i, end + 1).filter((l) => { const w = words(l.trim()); return !(w[0] && BLOCKED.has(w[0].toLowerCase())); }));
        } else {
          lines.push(...src.slice(i, end + 1).map((l) => l.replace(/\s+$/, '')));
          inline.add(tag);
          if (tag === 'auth-user-pass') needsAuth = false; // credentials are inside the file
        }
      } else removed.push(`<${tag}>`);
      i = end;
      continue;
    }
    const w = words(t);
    if (!w.length) continue;
    const d = w[0].toLowerCase().replace(/^--/, '');
    if (BLOCKED.has(d)) { removed.push(d); continue; }
    if (SERVER_ONLY.has(d) && !(d === 'mode' && (w[1] || '').toLowerCase() === 'p2p')) { isServer = true; continue; }
    switch (d) {
      case 'remote':
        if (w[1]) remotes.push({ host: w[1], port: w[2] || null, proto: (w[3] || '').toLowerCase() || null });
        break;
      case 'port': if (w[1]) defPort = w[1]; break;
      case 'rport': if (w[1]) defPort = w[1]; break;
      case 'proto': if (w[1]) defProto = w[1].toLowerCase(); break;
      case 'auth-user-pass':
        if (!inline.has('auth-user-pass')) needsAuth = true;
        // a file name points somewhere on the user's disk: ask instead
        lines.push('auth-user-pass');
        continue;
      case 'cipher': cipher = w[1] || null; break;
      case 'ncp-ciphers': case 'data-ciphers': dataCiphers = true; break;
      case 'comp-lzo': case 'compress': compression = true; break;
      case 'client': case 'tls-client': break;
      default:
        if (INLINE.has(d) && w[1] && w[1] !== '[inline]' && d !== 'auth-user-pass') fileRefs.push(d);
    }
    lines.push(raw.replace(/\s+$/, ''));
  }
  for (const r of remotes) {
    if (!r.port) r.port = defPort;
    if (!r.proto) r.proto = defProto;
    r.proto = r.proto.startsWith('tcp') ? 'tcp' : 'udp';
  }
  fileRefs = fileRefs.filter((d) => !inline.has(d));
  if (isServer) problems.push('این فایل کانفیگ سرور است، نه کلاینت');
  if (!remotes.length) problems.push('هیچ آدرس سروری (remote) در فایل نیست');
  if (!inline.has('ca') && !inline.has('pkcs12') && !inline.has('secret') && !inline.has('peer-fingerprint') && !fileRefs.includes('ca')) problems.push('گواهی CA در فایل نیست');
  if (fileRefs.length) problems.push(`این فایل به فایل‌های جداگانه اشاره می‌کند (${[...new Set(fileRefs)].join('، ')})؛ فقط کانفیگ‌هایی که گواهی‌ها داخلشان است پشتیبانی می‌شوند`);
  return {
    ok: !isServer && remotes.length > 0 && !fileRefs.length,
    lines, remotes, needsAuth, cipher, dataCiphers, compression,
    removed: [...new Set(removed)], problems,
  };
}

/**
 * The config handed to openvpn.exe: the cleaned lines plus compatibility settings for older
 * servers and the Iran-direct routes ([directRoutes]: IPv4 CIDRs that go around the tunnel).
 */
function buildConfig(parsed, { directRoutes = [] } = {}) {
  const out = [...parsed.lines, '', '# --- added by GozarVpn ---', 'client', 'nobind', 'auth-nocache', 'verb 3'];
  if (parsed.cipher && !parsed.dataCiphers) {
    // OpenVPN 2.6+ negotiates only AEAD ciphers unless told otherwise; old servers need their own one
    out.push(`data-ciphers AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:${parsed.cipher}`, `data-ciphers-fallback ${parsed.cipher}`);
  }
  if (parsed.cipher && LEGACY_CIPHER.test(parsed.cipher)) out.push('providers legacy default');
  if (parsed.compression) out.push('allow-compression asym');
  for (const cidr of directRoutes) {
    const r = cidrToRoute(cidr);
    if (r) out.push(`route ${r[0]} ${r[1]} net_gateway`);
  }
  return out.join('\r\n') + '\r\n';
}

function cidrToRoute(cidr) {
  const m = String(cidr).trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/);
  if (!m) return null;
  const bits = m[2] === undefined ? 32 : Number(m[2]);
  if (bits < 1 || bits > 32 || m[1].split('.').some((o) => Number(o) > 255)) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const ip = m[1].split('.').reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0) & mask;
  const dot = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
  return [dot(ip >>> 0), dot(mask)];
}

/* ------------------------------ finding openvpn.exe ------------------------------ */

function regQuery(key, value) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, ...(value ? ['/v', value] : ['/ve'])], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null);
      const m = String(out).match(/REG_[A-Z_]+\s+(.+)\s*$/m);
      resolve(m ? m[1].trim() : null);
    });
  });
}

/** The installed openvpn.exe: the user's pick, then the official installer's registry entry, then the default folder. */
async function findOpenVpn(userPath) {
  const cands = [userPath];
  for (const key of ['HKLM\\SOFTWARE\\OpenVPN', 'HKLM\\SOFTWARE\\WOW6432Node\\OpenVPN']) {
    cands.push(await regQuery(key, 'exe_path'));
    const dir = await regQuery(key, null);
    if (dir) cands.push(path.join(dir, 'bin', 'openvpn.exe'));
  }
  cands.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'OpenVPN', 'bin', 'openvpn.exe'));
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

function versionOf(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { windowsHide: true, timeout: 8000 }, (_err, out) => {
      const m = String(out || '').match(/OpenVPN (\d+\.\d+\.\d+\S*)/);
      resolve(m ? m[1] : null);
    });
  });
}

/* ------------------------------ running openvpn.exe ------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const quoteMgmt = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Starts openvpn.exe with [configText] and drives it through its management port (credentials,
 * state, stop). [extraArgs] come after --config, so they override the file. Returns a handle
 * { proc, stop() }. Callbacks: onLine(level, text), onState(state, detail), onExit(code).
 */
async function runOpenVpn({ exe, exeArgs = [], configText, runDir, creds, extraArgs = [], onLine, onState, onExit }) {
  fs.mkdirSync(runDir, { recursive: true });
  const cfgPath = path.join(runDir, `gozar-${process.pid}-${Date.now()}.ovpn`);
  fs.writeFileSync(cfgPath, configText, { encoding: 'utf8', mode: 0o600 });
  const port = await freePort();
  // shortcut: the management port has no password (localhost only, open for the session); add a pw file if that ever matters
  const args = ['--config', cfgPath, '--script-security', '1',
    '--management', '127.0.0.1', String(port), '--management-query-passwords', '--management-hold', ...extraArgs];
  const proc = spawn(exe, [...exeArgs, ...args], { cwd: runDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let sock = null;
  let exited = false;
  let sentAuth = false;
  const cleanup = () => { try { fs.unlinkSync(cfgPath); } catch { /* gone */ } };

  const lineReader = (stream, level) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).replace(/\r$/, '').replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, '');
        buf = buf.slice(i + 1);
        if (l.trim()) onLine(level, l);
      }
    });
  };
  lineReader(proc.stdout, 'info');
  lineReader(proc.stderr, 'warn');
  proc.on('exit', (code) => { exited = true; cleanup(); if (sock) sock.destroy(); onExit(code); });
  proc.on('error', (err) => { onLine('error', `openvpn.exe اجرا نشد: ${err.message}`); });

  const send = (cmd) => { if (sock && !sock.destroyed) sock.write(`${cmd}\n`); };
  const handle = (msg) => {
    if (msg.startsWith('>HOLD:')) { send('state on'); send('hold release'); return; }
    if (msg.startsWith('>STATE:')) {
      const p = msg.slice(7).split(',');
      onState(p[1], p.slice(2).join(','));
      return;
    }
    if (msg.startsWith('>PASSWORD:')) {
      const body = msg.slice(10);
      if (body.startsWith('Verification Failed')) { onState('AUTH_FAILED', body); return; }
      const need = body.match(/^Need '([^']+)' (username\/password|password)/);
      if (!need) return;
      const type = need[1];
      if (type === 'Auth' && creds && creds.username) {
        if (sentAuth) { onState('AUTH_FAILED', 'credentials rejected'); return; }
        sentAuth = true;
        send(`username ${quoteMgmt(type)} ${quoteMgmt(creds.username)}`);
        send(`password ${quoteMgmt(type)} ${quoteMgmt(creds.password || '')}`);
      } else {
        onState('NEED_CREDS', type);
        send('signal SIGTERM');
      }
    }
  };

  // the management port opens a moment after start
  for (let i = 0; i < 50 && !exited && !sock; i++) {
    await new Promise((r) => setTimeout(r, 150));
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => { sock = s; resolve(); });
      s.once('error', () => resolve());
    });
  }
  if (sock) {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); handle(l); }
    });
    sock.on('error', () => { /* openvpn exited */ });
  } else if (!exited) {
    onLine('error', 'پورت مدیریت OpenVPN باز نشد');
  }

  const stop = () => new Promise((resolve) => {
    if (exited) return resolve();
    send('signal SIGTERM');
    const t = setTimeout(() => {
      // taskkill first (proc.kill alone left orphans with other engines)
      execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    }, 6000);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
  });
  return { proc, stop };
}

/** openvpn.exe processes this app started (their config lives in our run folder). Not the user's own ones. */
function killLeftovers(runDir) {
  const like = runDir.replace(/'/g, "''").replace(/[[\]]/g, '`$&');
  const ps = `Get-CimInstance Win32_Process -Filter "Name='openvpn.exe'" | Where-Object { $_.CommandLine -like '*${like}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000 }, () => resolve()));
}

/* ------------------------------ engine manager ------------------------------ */

const FRIENDLY = [
  [/There are no TAP-Windows|no (usable )?(wintun|ovpn-dco|TAP)/i, 'کارت شبکه‌ی OpenVPN پیدا نشد؛ برنامه‌ی رسمی OpenVPN را (دوباره) نصب کنید'],
  [/TLS key negotiation failed|TLS handshake failed/i, 'دست‌دادن TLS با سرور انجام نشد (سرور در دسترس نیست یا فیلتر شده)'],
  [/Cannot resolve host address|RESOLVE: Cannot resolve/i, 'آدرس سرور پیدا نشد (DNS)'],
  [/AUTH_FAILED/, 'نام کاربری یا رمز را سرور قبول نکرد'],
  [/Unrecognized option or missing or extra parameter/i, 'یکی از تنظیمات این کانفیگ را OpenVPN نمی‌شناسد (جزئیات در لاگ)'],
  [/cipher .* not supported|Unsupported cipher/i, 'رمزنگاری این کانفیگ پشتیبانی نمی‌شود'],
];

class OpenVpnManager extends EventEmitter {
  constructor(runDir) {
    super();
    this.runDir = runDir;
    this.handle = null;
    this.status = 'stopped';
    this.startedAt = null;
    this.lastError = null;
    this.logBuffer = [];
    this.maxLogLines = 4000;
    this.userStop = false;
  }

  isRunning() { return this.handle !== null; }

  getState() {
    return { status: this.status, address: null, socksAddress: null, httpAddress: null, startedAt: this.startedAt, running: this.isRunning(), error: this.lastError, systemTunnel: true };
  }

  _setStatus(status) { this.status = status; this.emit('status', this.getState()); }

  log(level, text) {
    const entry = { t: Date.now(), level, text };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > this.maxLogLines) this.logBuffer.shift();
    this.emit('log', entry);
  }

  clearLogs() { this.logBuffer = []; }

  /** Starts in the background; status events report the progress. */
  start(exe, profile, { creds, directRoutes = [] } = {}) {
    if (this.handle) throw new Error('OpenVPN در حال اجراست');
    const parsed = parseOvpn(profile.text);
    if (!parsed.ok) throw new Error(parsed.problems.join('؛ '));
    if (parsed.needsAuth && !(creds && creds.username)) throw new Error('این کانفیگ نام کاربری و رمز می‌خواهد؛ در تب «OpenVPN» واردش کنید.');
    this.userStop = false;
    this.lastError = null;
    this.startedAt = null;
    this.handle = { stop: async () => {} }; // placeholder: running from now on
    this._setStatus('starting');
    if (parsed.removed.length) this.log('warn', `[openvpn] این دستورها از کانفیگ حذف شدند (امنیت): ${parsed.removed.join(', ')}`);
    if (directRoutes.length) this.log('info', `[openvpn] ${directRoutes.length} محدوده‌ی IP ایران مستقیم (بیرون از تونل) می‌رود`);
    const r0 = parsed.remotes[0];
    this.log('info', `[openvpn] اتصال به «${profile.name}» (${r0.host}:${r0.port}/${r0.proto}${parsed.remotes.length > 1 ? ` و ${parsed.remotes.length - 1} سرور دیگر` : ''})`);
    const fail = (msg) => { if (!this.lastError) this.lastError = msg; };
    runOpenVpn({
      exe,
      configText: buildConfig(parsed, { directRoutes }),
      runDir: this.runDir,
      creds,
      extraArgs: ['--connect-retry-max', '5'],
      onLine: (level, text) => {
        this.log(/ERROR|FATAL|failed/i.test(text) ? 'error' : level, `[openvpn] ${text}`);
        for (const [re, msg] of FRIENDLY) if (re.test(text)) fail(msg);
        if (/Initialization Sequence Completed/.test(text) && this.status !== 'connected') {
          this.startedAt = Date.now();
          this._setStatus('connected');
        }
      },
      onState: (state, detail) => {
        if (state === 'CONNECTED' && this.status !== 'connected') { this.startedAt = Date.now(); this._setStatus('connected'); }
        else if (state === 'RECONNECTING' && this.status === 'connected') this._setStatus('reconnecting');
        else if (state === 'AUTH_FAILED') { fail('نام کاربری یا رمز را سرور قبول نکرد'); this.stop(); }
        else if (state === 'NEED_CREDS') fail(detail === 'Auth' ? 'نام کاربری و رمز لازم است' : `«${detail}» لازم است (پشتیبانی نمی‌شود)`);
      },
      onExit: (code) => {
        this.handle = null;
        if (!this.userStop && code !== 0 && !this.lastError) this.lastError = 'OpenVPN متوقف شد (جزئیات در لاگ)';
        if (this.lastError && !this.userStop) this.log('error', `[openvpn] ${this.lastError}`);
        this._setStatus(this.lastError && !this.userStop ? 'error' : 'stopped');
        this.startedAt = null;
      },
    }).then((h) => {
      if (this.handle) this.handle = h;
      if (this.userStop) h.stop();
    }).catch((err) => {
      this.handle = null;
      this.lastError = err.message;
      this.log('error', `[openvpn] ${err.message}`);
      this._setStatus('error');
    });
  }

  stop() {
    this.userStop = true;
    if (this.handle) return this.handle.stop();
    return Promise.resolve();
  }
}

/**
 * Pre-connect test: a real handshake with a short timeout, without a network adapter (--dev null),
 * so it needs no Administrator and changes nothing. OK once the server accepted us
 * ("Peer Connection Initiated"); the TLS / auth errors are reported as they come.
 */
async function testProfile(exe, profile, { creds, runDir, timeoutMs = 20000 } = {}) {
  const parsed = parseOvpn(profile.text);
  if (!parsed.ok) return { ok: false, error: parsed.problems.join('؛ ') };
  if (parsed.needsAuth && !(creds && creds.username)) return { ok: false, error: 'نام کاربری و رمز لازم است' };
  const begun = Date.now();
  return new Promise((resolve) => {
    let done = false;
    let handle = null;
    let lastLine = '';
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (handle) handle.stop();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `در ${Math.round(timeoutMs / 1000)} ثانیه جوابی نیامد${lastLine ? ` (${lastLine.slice(0, 80)})` : ''}` }), timeoutMs);
    runOpenVpn({
      exe,
      configText: buildConfig(parsed),
      runDir,
      creds,
      extraArgs: ['--dev', 'null', '--route-noexec', '--ifconfig-noexec', '--connect-retry-max', '1', '--pull-filter', 'ignore', 'block-outside-dns'],
      onLine: (_lvl, text) => {
        lastLine = text;
        if (/Peer Connection Initiated/.test(text)) finish({ ok: true, latencyMs: Date.now() - begun });
        for (const [re, msg] of FRIENDLY) if (re.test(text)) finish({ ok: false, error: msg });
      },
      onState: (state, detail) => {
        if (state === 'AUTH_FAILED') finish({ ok: false, error: 'نام کاربری یا رمز را سرور قبول نکرد' });
        if (state === 'NEED_CREDS') finish({ ok: false, error: detail === 'Auth' ? 'نام کاربری و رمز لازم است' : `«${detail}» لازم است` });
      },
      onExit: () => finish({ ok: false, error: lastLine ? `OpenVPN بسته شد: ${lastLine.slice(0, 100)}` : 'OpenVPN بسته شد' }),
    }).then((h) => { handle = h; if (done) h.stop(); }).catch((err) => finish({ ok: false, error: err.message }));
  });
}

/* ------------------------------ official installer ------------------------------ */

const INSTALLER_URL = 'https://swupdate.openvpn.org/community/releases/OpenVPN-2.7.9-I001-amd64.msi';
const INSTALLER_VERSION = INSTALLER_URL.match(/OpenVPN-(\d+\.\d+\.\d+)/)[1];

/** -1 / 0 / 1 for "2.6.12" vs "2.7.9" (suffixes like "_git" are ignored). */
function cmpVersion(a, b) {
  const pa = String(a).split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
}

/** What the install button should do: install (none found), installed (same or newer), update (older). */
function installState(installedVersion) {
  if (!installedVersion) return 'install';
  return cmpVersion(installedVersion, INSTALLER_VERSION) >= 0 ? 'installed' : 'update';
}

/** Accepts the installer only with a valid Authenticode signature from OpenVPN Inc. */
function checkSignature(file) {
  const ps = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000 }, (err, out) => {
      const [status, subject] = String(out || '').trim().split('|');
      resolve({ ok: !err && status === 'Valid' && /O="?OpenVPN Inc/i.test(subject || ''), status, subject });
    });
  });
}

module.exports = { runOpenVpn, parseOvpn, buildConfig, cidrToRoute, words, findOpenVpn, versionOf, OpenVpnManager, testProfile, killLeftovers, checkSignature, INSTALLER_URL, INSTALLER_VERSION, cmpVersion, installState };
