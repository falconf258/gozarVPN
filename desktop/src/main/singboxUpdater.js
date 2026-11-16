'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { httpsGetJson, downloadToFile, tryDirectThenTunnel } = require('./githubDownload');
const { SINGBOX_REPO_OWNER, SINGBOX_REPO_NAME, SINGBOX_WINDOWS_ASSET_PATTERN, SINGBOX_EXE_NAME } = require('./constants');

const API_URL = `https://api.github.com/repos/${SINGBOX_REPO_OWNER}/${SINGBOX_REPO_NAME}/releases/latest`;

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

class SingboxUpdater {
  constructor(dir) {
    this.dir = dir;
    this.exePath = path.join(dir, SINGBOX_EXE_NAME);
    this.versionFile = path.join(dir, 'singbox-version.json');
  }

  hasSingbox() {
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
    const release = await tryDirectThenTunnel((addr) => httpsGetJson(API_URL, addr), socksAddr);
    const asset = (release.assets || []).find((a) => SINGBOX_WINDOWS_ASSET_PATTERN.test(a.name));
    if (!asset) throw new Error(`release ${release.tag_name} has no matching windows-amd64 asset`);
    const installed = this.getInstalledVersion();
    return {
      updateAvailable: !this.hasSingbox() || installed !== release.tag_name,
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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gozarvpn-singbox-'));
    const zipPath = path.join(tmpDir, info.assetName);

    onProgress && onProgress({ phase: 'downloading', pct: 0 });
    await tryDirectThenTunnel(
      (addr) => downloadToFile(info.assetUrl, zipPath, (pct) => onProgress && onProgress({ phase: 'downloading', pct }), addr),
      socksAddr
    );

    onProgress && onProgress({ phase: 'extracting', pct: 1 });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tmpDir, true);

    // Unlike aether/cfst, sing-box's zip extracts into a version-named
    // subfolder (e.g. sing-box-1.13.13-windows-amd64/), which can also
    // contain a runtime DLL (libcronet.dll, used by some optional
    // outbounds) alongside the exe — copy the whole folder's contents,
    // not just the exe, so a needed DLL is never silently left behind
    // (this is exactly the same class of bug as the scanner's missing
    // ip.txt).
    const foundExe = findExeRecursive(tmpDir);
    if (!foundExe) throw new Error(`no .exe found inside ${info.assetName}`);
    // Windows won't overwrite a running exe: let the caller stop it first.
    if (beforeSwap) await beforeSwap();
    const exeDir = path.dirname(foundExe);
    for (const entry of fs.readdirSync(exeDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        const destName = /\.exe$/i.test(entry.name) ? SINGBOX_EXE_NAME : entry.name;
        fs.copyFileSync(path.join(exeDir, entry.name), path.join(this.dir, destName));
      }
    }

    fs.writeFileSync(this.versionFile, JSON.stringify({ tag: info.latestTag, installedAt: new Date().toISOString() }, null, 2));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    onProgress && onProgress({ phase: 'done', pct: 1 });
    return { updated: true, info };
  }
}

module.exports = { SingboxUpdater };
