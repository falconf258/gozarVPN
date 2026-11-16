'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { httpsGetJson, httpsGetText, downloadToFile, sha256File, tryDirectThenTunnel } = require('./githubDownload');
const { CORE_REPO_OWNER, CORE_REPO_NAME, CORE_WINDOWS_ASSET } = require('./constants');

const API_URL = `https://api.github.com/repos/${CORE_REPO_OWNER}/${CORE_REPO_NAME}/releases/latest`;

class CoreUpdater {
  /**
   * @param {string} coreDir directory that holds aether.exe (and its version marker)
   */
  constructor(coreDir) {
    this.coreDir = coreDir;
    this.exePath = path.join(coreDir, 'aether.exe');
    this.versionFile = path.join(coreDir, 'core-version.json');
  }

  getInstalledVersion() {
    try {
      const data = JSON.parse(fs.readFileSync(this.versionFile, 'utf8'));
      return data.tag || null;
    } catch {
      return null;
    }
  }

  hasCore() {
    return fs.existsSync(this.exePath);
  }

  async checkForUpdate(socksAddr) {
    const release = await tryDirectThenTunnel((addr) => httpsGetJson(API_URL, addr), socksAddr);
    const asset = (release.assets || []).find((a) => a.name === CORE_WINDOWS_ASSET);
    const checksumAsset = (release.assets || []).find((a) => a.name === `${CORE_WINDOWS_ASSET}.sha256`);
    if (!asset) {
      throw new Error(`release ${release.tag_name} has no ${CORE_WINDOWS_ASSET} asset`);
    }
    const installed = this.getInstalledVersion();
    return {
      updateAvailable: installed !== release.tag_name,
      latestTag: release.tag_name,
      installedTag: installed,
      changelog: release.body || '',
      assetUrl: asset.browser_download_url,
      checksumUrl: checksumAsset ? checksumAsset.browser_download_url : null,
      publishedAt: release.published_at
    };
  }

  /**
   * Downloads, verifies, and installs the latest core build.
   * @param {function} onProgress progress callback
   * @param {string} [socksAddr] if the core is currently running, its own
   *   SOCKS address — reused so the download itself can get through even
   *   when GitHub is filtered directly (see githubDownload.js).
   * @param {function} [beforeSwap] awaited right before the exe is
   *   overwritten — the caller's chance to stop the running core (which
   *   must happen only *after* the download, since the download may still
   *   be using that same process's tunnel, but *before* the file swap,
   *   since Windows won't let a running exe be replaced).
   */
  async update(onProgress, socksAddr, beforeSwap) {
    const info = await this.checkForUpdate(socksAddr);
    if (!info.updateAvailable) return { updated: false, info };

    fs.mkdirSync(this.coreDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-core-'));
    const zipPath = path.join(tmpDir, CORE_WINDOWS_ASSET);

    onProgress && onProgress({ phase: 'downloading', pct: 0 });
    await tryDirectThenTunnel(
      (addr) => downloadToFile(info.assetUrl, zipPath, (pct) => onProgress && onProgress({ phase: 'downloading', pct }), addr),
      socksAddr
    );

    if (info.checksumUrl) {
      onProgress && onProgress({ phase: 'verifying', pct: 1 });
      const checksumText = await tryDirectThenTunnel((addr) => httpsGetText(info.checksumUrl, addr), socksAddr);
      const expected = checksumText.trim().split(/\s+/)[0];
      const actual = await sha256File(zipPath);
      if (!expected || expected.toLowerCase() !== actual.toLowerCase()) {
        throw new Error(`checksum mismatch for ${CORE_WINDOWS_ASSET}: expected ${expected}, got ${actual}`);
      }
    }

    onProgress && onProgress({ phase: 'extracting', pct: 1 });
    try {
      await this.installFromZip(zipPath, info.latestTag, async () => {
        if (beforeSwap) {
          onProgress && onProgress({ phase: 'stopping', pct: 1 });
          await beforeSwap();
        }
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    onProgress && onProgress({ phase: 'done', pct: 1 });

    return { updated: true, info };
  }

  /**
   * Installs a release archive: aether.exe plus the helpers it ships beside it
   * (pt/ holds psiphon-tunnel-core.exe and lyrebird.exe, which aether finds there),
   * the run script and the licenses. Also used for a zip picked by hand.
   */
  async installFromZip(zipPath, tag, beforeSwap) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aether-unzip-'));
    try {
      new AdmZip(zipPath).extractAllTo(dir, true);
      // some archives wrap everything in one top folder
      let root = dir;
      if (!fs.existsSync(path.join(root, 'aether.exe'))) {
        const sub = fs.readdirSync(dir).map((n) => path.join(dir, n)).find((p) => fs.existsSync(path.join(p, 'aether.exe')));
        if (!sub) throw new Error('فایل aether.exe داخل این فایل zip پیدا نشد.');
        root = sub;
      }
      if (beforeSwap) await beforeSwap();
      fs.mkdirSync(this.coreDir, { recursive: true });
      this.installExe(path.join(root, 'aether.exe'));
      for (const name of ['pt', 'LICENSES']) {
        const from = path.join(root, name);
        if (fs.existsSync(from)) fs.cpSync(from, path.join(this.coreDir, name), { recursive: true, force: true });
      }
      const batPath = path.join(root, 'run-aether.bat');
      if (fs.existsSync(batPath)) fs.copyFileSync(batPath, path.join(this.coreDir, 'run-aether.bat'));
      fs.writeFileSync(this.versionFile, JSON.stringify({ tag: tag || 'manual', installedAt: new Date().toISOString() }, null, 2));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Atomic-ish swap: write beside the target, then rename over it (throws if the core is still running). */
  installExe(exePath) {
    const stagedPath = `${this.exePath}.new`;
    fs.copyFileSync(exePath, stagedPath);
    try {
      fs.renameSync(stagedPath, this.exePath);
    } catch (err) {
      fs.rmSync(stagedPath, { force: true });
      throw new Error(`جایگزینی aether.exe ممکن نشد؛ احتمالاً هسته هنوز در حال اجراست. اتصال را قطع کنید و دوباره امتحان کنید. (${err.code || err.message})`);
    }
  }
}

module.exports = { CoreUpdater };
