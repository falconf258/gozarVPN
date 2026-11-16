'use strict';

const { execFile } = require('child_process');
const fs = require('fs');

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr && stderr.trim() ? stderr.trim() : err.message));
      else resolve(stdout);
    });
  });
}

async function queryValue(name) {
  try {
    const out = await run('reg', ['query', REG_PATH, '/v', name]);
    const m = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(\\S+)`));
    return m ? m[1] : null;
  } catch {
    return null; // value doesn't exist, which is a valid "off" state
  }
}

// Tells Windows (and anything using WinINet/WinHTTP, which covers most
// browsers including Chrome/Edge when set to "use system proxy") that the
// Internet Settings registry keys changed, without requiring a logoff.
async function notifySystem() {
  const script = [
    "Add-Type -MemberDefinition '[DllImport(\"wininet.dll\",SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet,int dwOption,IntPtr lpBuffer,int dwBufferLength);' -Name Internet -Namespace Win32Api",
    '[Win32Api.Internet]::InternetSetOption([IntPtr]::Zero,39,[IntPtr]::Zero,0) | Out-Null',
    '[Win32Api.Internet]::InternetSetOption([IntPtr]::Zero,37,[IntPtr]::Zero,0) | Out-Null'
  ].join('; ');
  await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

class SystemProxy {
  /**
   * @param {string} [backupFilePath] where the pre-connect proxy settings
   * are persisted to disk. If the app crashes or is killed while connected,
   * this file survives and recoverStaleState() can undo the change on the
   * next launch instead of leaving the user's system proxy stuck pointing
   * at a tunnel that no longer exists.
   */
  constructor(backupFilePath) {
    this.backup = null;
    this.applied = false;
    this.backupFilePath = backupFilePath || null;
  }

  /** Snapshot current values so disconnect can restore them exactly. */
  async _backupCurrent() {
    this.backup = {
      ProxyEnable: await queryValue('ProxyEnable'),
      ProxyServer: await queryValue('ProxyServer'),
      ProxyOverride: await queryValue('ProxyOverride')
    };
    if (this.backupFilePath) {
      try { fs.writeFileSync(this.backupFilePath, JSON.stringify(this.backup)); } catch { /* best-effort */ }
    }
  }

  _clearBackupFile() {
    if (this.backupFilePath) {
      try { fs.unlinkSync(this.backupFilePath); } catch { /* already gone */ }
    }
  }

  /**
   * Call once at app startup, before any connection is made. If a backup
   * file is sitting on disk, the previous run never got to restore() —
   * most likely it crashed or was force-killed while connected. Restore
   * the system proxy to whatever it was before that run touched it.
   */
  async recoverStaleState() {
    if (!this.backupFilePath || !fs.existsSync(this.backupFilePath)) return false;
    try {
      const prev = JSON.parse(fs.readFileSync(this.backupFilePath, 'utf8'));
      this.backup = prev;
      this.applied = true;
      await this.restore();
      return true;
    } catch {
      this._clearBackupFile();
      return false;
    }
  }

  /**
   * Points the Windows system proxy at the local proxy(ies) the core just
   * started listening on. This maps BOTH "http="/"https=" (to the core's
   * HTTP proxy) AND "socks=" (to its SOCKS5 proxy). A SOCKS-only mapping
   * (what earlier versions did) is what caused total internet loss on
   * connect: WinINet/Chromium need an explicit http=/https= entry, and
   * without one many apps fail EVERY request — not just proxied ones —
   * once a proxy is "on" system-wide, instead of falling back to direct.
   */
  async enable(socksAddr, httpAddr) {
    if (process.platform !== 'win32') return;
    await this._backupCurrent();
    await run('reg', ['add', REG_PATH, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);

    const mapping = httpAddr
      ? `http=${httpAddr};https=${httpAddr};socks=${socksAddr}`
      : `socks=${socksAddr}`;
    await run('reg', ['add', REG_PATH, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', mapping, '/f']);
    // Keep local/loopback traffic direct so LAN devices and localhost
    // dev servers aren't broken while connected.
    await run('reg', ['add', REG_PATH, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', '<local>', '/f']);
    await notifySystem();
    this.applied = true;
  }

  /** Restores exactly what was there before enable() was called. */
  async restore() {
    if (process.platform !== 'win32') return;
    if (!this.applied) return;
    const prev = this.backup || {};
    const wasEnabled = prev.ProxyEnable === '0x1';
    await run('reg', ['add', REG_PATH, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', wasEnabled ? '1' : '0', '/f']);
    if (prev.ProxyServer) {
      await run('reg', ['add', REG_PATH, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', prev.ProxyServer, '/f']);
    } else {
      await run('reg', ['delete', REG_PATH, '/v', 'ProxyServer', '/f']).catch(() => {});
    }
    if (prev.ProxyOverride) {
      await run('reg', ['add', REG_PATH, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', prev.ProxyOverride, '/f']);
    } else {
      await run('reg', ['delete', REG_PATH, '/v', 'ProxyOverride', '/f']).catch(() => {});
    }
    await notifySystem();
    this.applied = false;
    this.backup = null;
    this._clearBackupFile();
  }
}

module.exports = { SystemProxy };
