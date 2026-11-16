'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { httpsGetJson, downloadToFile, tryDirectThenTunnel } = require('./githubDownload');

function findExeRecursive(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findExeRecursive(full);
      if (found) return found;
    } else if (/\.exe$/i.test(entry.name)) {
      return full;
    }
  }
  return null;
}

/**
 * Generic "latest GitHub release → one Windows exe" updater, used by the
 * engines added after sing-box (mihomo, …). Same direct-then-tunnel
 * download fallback as the other updaters, so a filtered GitHub never
 * needs a second VPN once any GozarVpn tunnel is up.
 *
 * @param {object} o
 * @param {string} o.dir          install dir (userData/<engine>-bin)
 * @param {string} o.owner        GitHub owner
 * @param {string} o.repo         GitHub repo
 * @param {RegExp} o.assetPattern release asset to pick (.zip or .exe)
 * @param {string} o.exeName      name the exe is stored under
 */
class BinaryUpdater {
  constructor({ dir, owner, repo, assetPattern, exeName }) {
    this.dir = dir;
    this.apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    this.assetPattern = assetPattern;
    this.exeName = exeName;
    this.exePath = path.join(dir, exeName);
    this.versionFile = path.join(dir, `${path.parse(exeName).name}-version.json`);
  }

  hasBinary() {
    return fs.existsSync(this.exePath);
  }

  getInstalledVersion() {
    try {
      return JSON.parse(fs.readFileSync(this.versionFile, 'utf8')).tag || null;
    } catch {
      return null;
    }
  }

  async checkForUpdate(socksAddr) {
    const release = await tryDirectThenTunnel((addr) => httpsGetJson(this.apiUrl, addr), socksAddr);
    const asset = (release.assets || []).find((a) => this.assetPattern.test(a.name));
    if (!asset) throw new Error(`release ${release.tag_name} has no matching Windows asset`);
    const installed = this.getInstalledVersion();
    return {
      updateAvailable: !this.hasBinary() || installed !== release.tag_name,
      latestTag: release.tag_name,
      installedTag: installed,
      changelog: release.body || '',
      assetUrl: asset.browser_download_url,
      assetName: asset.name
    };
  }

  async update(onProgress, socksAddr, beforeSwap) {
    const info = await this.checkForUpdate(socksAddr);
    if (!info.updateAvailable) return { updated: false, info };

    fs.mkdirSync(this.dir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gozarvpn-bin-'));
    const dlPath = path.join(tmpDir, info.assetName);

    onProgress && onProgress({ phase: 'downloading', pct: 0 });
    await tryDirectThenTunnel(
      (addr) => downloadToFile(info.assetUrl, dlPath, (pct) => onProgress && onProgress({ phase: 'downloading', pct }), addr),
      socksAddr
    );

    let foundExe = dlPath;
    if (/\.zip$/i.test(info.assetName)) {
      onProgress && onProgress({ phase: 'extracting', pct: 1 });
      new AdmZip(dlPath).extractAllTo(tmpDir, true);
      foundExe = findExeRecursive(tmpDir);
      if (!foundExe) throw new Error(`no .exe found inside ${info.assetName}`);
    }
    if (beforeSwap) await beforeSwap();
    fs.copyFileSync(foundExe, this.exePath);

    fs.writeFileSync(this.versionFile, JSON.stringify({ tag: info.latestTag, installedAt: new Date().toISOString() }, null, 2));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    onProgress && onProgress({ phase: 'done', pct: 1 });
    return { updated: true, info };
  }

  /** Replace the installed exe with one the user picked by hand. */
  installFrom(filePath) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.copyFileSync(filePath, this.exePath);
    fs.writeFileSync(this.versionFile, JSON.stringify({ tag: 'manual', installedAt: new Date().toISOString() }, null, 2));
  }
}

module.exports = { BinaryUpdater };
