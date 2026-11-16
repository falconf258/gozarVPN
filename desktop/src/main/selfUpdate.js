'use strict';

// Updates of GozarVpn itself from the GitHub Releases of the project. Uses the public API (no
// token), so it works once the repository (or its releases) is public; a private repo answers 404.
// Requests go direct first, then through the running tunnel's SOCKS port (GitHub is often
// filtered in Iran). The downloaded file must match SHA256SUMS.txt from the same release.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { httpsGetJson, httpsGetText, downloadToFile, sha256File } = require('./githubDownload');

const REPO = { owner: 'falconf258', repo: 'gozarVPN' };
const RELEASES_PAGE = `https://github.com/${REPO.owner}/${REPO.repo}/releases`;

/** -1 / 0 / 1 for dotted versions ("1.19.0" vs "1.20.0"). */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * The newest release newer than [current] that has the Windows file we need. Release tags do not
 * matter: the version is read from the file name (GozarVpn-Setup-1.20.0.exe / GozarVpn-Portable-1.20.0.exe).
 */
function pickWindows(releases, current, { portable = false, prerelease = false } = {}) {
  const re = portable ? /^GozarVpn-Portable-(\d+\.\d+\.\d+)\.exe$/ : /^GozarVpn-Setup-(\d+\.\d+\.\d+)\.exe$/;
  let best = null;
  for (const r of releases || []) {
    if (r.draft || (r.prerelease && !prerelease)) continue;
    for (const a of r.assets || []) {
      const m = a.name.match(re);
      if (!m || cmpVersion(m[1], current) <= 0) continue;
      if (!best || cmpVersion(m[1], best.version) > 0) {
        best = {
          version: m[1], tag: r.tag_name, name: r.name || r.tag_name, notes: r.body || '', prerelease: !!r.prerelease,
          publishedAt: r.published_at, url: a.browser_download_url, file: a.name, size: a.size,
          sumsUrl: ((r.assets || []).find((x) => x.name === 'SHA256SUMS.txt') || {}).browser_download_url || null,
          page: r.html_url,
        };
      }
    }
  }
  return best;
}

/** The hash for [file] from a SHA256SUMS.txt text ("<hex>  <name>" lines). */
function hashFromSums(text, file) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === file) return m[1].toLowerCase();
  }
  return null;
}

function friendlyError(err) {
  const msg = String(err && err.message || err);
  if (/\b404\b/.test(msg)) return 'نسخه‌ای روی GitHub پیدا نشد: مخزن هنوز خصوصی است یا منتشر نشده.';
  if (/\b403\b/.test(msg)) return 'GitHub موقتاً اجازه نداد (محدودیت تعداد درخواست)؛ کمی بعد دوباره امتحان کنید.';
  return msg;
}

class SelfUpdater {
  /**
   * @param {object} o
   *  send(channel, payload), currentVersion, socks() -> "127.0.0.1:port"|null,
   *  workDir (for the download), prefs() -> {updateBeta}, apiBase (tests)
   */
  constructor(o) {
    this.o = o;
    this.portableDir = process.env.PORTABLE_EXECUTABLE_DIR || null;
    this.found = null;
    this.downloaded = null;
    this.busy = false;
  }

  _status(payload) { this.o.send('app-update:status', payload); }

  async _viaAnyPath(fn) {
    try { return await fn(undefined); } catch (direct) {
      const socks = this.o.socks();
      if (!socks) throw direct;
      return fn(socks);
    }
  }

  async check({ quiet = false } = {}) {
    if (this.busy) return this.found;
    this.busy = true;
    if (!quiet) this._status({ phase: 'checking' });
    try {
      const api = `${this.o.apiBase || 'https://api.github.com'}/repos/${REPO.owner}/${REPO.repo}/releases?per_page=15`;
      const releases = await this._viaAnyPath((s) => httpsGetJson(api, s));
      this.found = pickWindows(releases, this.o.currentVersion, { portable: !!this.portableDir, prerelease: !!this.o.prefs().updateBeta });
      if (this.found) this._status({ phase: 'available', info: this.found, quiet, portable: !!this.portableDir });
      else if (!quiet) this._status({ phase: 'up-to-date', info: { version: this.o.currentVersion } });
      return this.found;
    } catch (err) {
      if (!quiet) this._status({ phase: 'error', error: friendlyError(err), page: RELEASES_PAGE });
      return null;
    } finally {
      this.busy = false;
    }
  }

  async download() {
    const f = this.found;
    if (!f) throw new Error('اول «بررسی به‌روزرسانی» را بزنید.');
    if (!f.sumsUrl) throw new Error('این نسخه فایل SHA256SUMS.txt ندارد؛ برای امنیت دانلود نمی‌شود. از صفحه‌ی انتشارها دستی بگیرید.');
    const dir = this.portableDir || this.o.workDir;
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, f.file);
    const part = `${dest}.part`;
    this._status({ phase: 'downloading', percent: 0 });
    try {
      const sums = await this._viaAnyPath((s) => httpsGetText(f.sumsUrl, s));
      const want = hashFromSums(sums, f.file);
      if (!want) throw new Error(`هش ${f.file} در SHA256SUMS.txt نیست`);
      await this._viaAnyPath((s) => downloadToFile(f.url, part, (p) => this._status({ phase: 'downloading', percent: p * 100 }), s));
      const got = (await sha256File(part)).toLowerCase();
      if (got !== want) { fs.rmSync(part, { force: true }); throw new Error('هش فایل دانلودشده درست نیست؛ فایل حذف شد.'); }
      fs.rmSync(dest, { force: true });
      fs.renameSync(part, dest);
      this.downloaded = { ...f, path: dest };
      this._status({ phase: 'downloaded', info: this.downloaded, portable: !!this.portableDir });
      return this.downloaded;
    } catch (err) {
      fs.rmSync(part, { force: true });
      this._status({ phase: 'error', error: friendlyError(err), page: RELEASES_PAGE });
      throw err;
    }
  }

  /**
   * Installer: runs it silently and restarts the app (--force-run). Portable: shows the new file
   * (a portable copy cannot replace itself while running). Returns false when nothing to do.
   */
  install({ restart = true } = {}) {
    const d = this.downloaded;
    if (!d || !fs.existsSync(d.path)) return false;
    if (this.portableDir) { require('electron').shell.showItemInFolder(d.path); return true; }
    const args = ['--updated', '/S', ...(restart ? ['--force-run'] : [])];
    spawn(d.path, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    this.downloaded = null;
    return true;
  }
}

module.exports = { SelfUpdater, pickWindows, hashFromSums, cmpVersion, REPO, RELEASES_PAGE };
