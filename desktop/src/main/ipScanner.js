'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const AdmZip = require('adm-zip');
const { httpsGetJson, downloadToFile, tryDirectThenTunnel } = require('./githubDownload');
const { sampleIps } = require('./ipRangeSampler');
const { SCANNER_REPO_OWNER, SCANNER_REPO_NAME, SCANNER_WINDOWS_ASSET, SCANNER_EXE_NAME } = require('./constants');

const API_URL = `https://api.github.com/repos/${SCANNER_REPO_OWNER}/${SCANNER_REPO_NAME}/releases/latest`;

/**
 * Parses CloudflareSpeedTest's result CSV. Header-driven (matches columns
 * by name substring rather than fixed position) so it survives the tool
 * changing column order/count across versions, and works whether it was
 * run with or without -dd (download test disabled).
 * Also accepts a plain newline-separated IP or IP:port list (e.g.
 * SenPaiScanner's ips.txt) as a fallback import format.
 */
function parseCandidatesFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const looksLikeCsv = lines[0].includes(',') && /ip|地址/i.test(lines[0]);
  if (looksLikeCsv) {
    const header = lines[0].split(',').map((h) => h.trim());
    const findCol = (patterns) => header.findIndex((h) => patterns.some((p) => p.test(h)));
    const ipCol = findCol([/ip/i, /地址/]);
    const latencyCol = findCol([/latency/i, /延迟/]);
    const lossCol = findCol([/loss/i, /丢包/]);
    const speedCol = findCol([/speed/i, /速度/]);
    const regionCol = findCol([/region|colo/i, /地区/]);

    return lines.slice(1).map((line) => {
      const cells = line.split(',').map((c) => c.trim());
      const ip = ipCol >= 0 ? cells[ipCol] : cells[0];
      return {
        ip,
        latencyMs: latencyCol >= 0 ? parseFloat(cells[latencyCol]) : null,
        lossRate: lossCol >= 0 ? parseFloat(cells[lossCol]) : null,
        speedMbps: speedCol >= 0 ? parseFloat(cells[speedCol]) : null,
        region: regionCol >= 0 ? cells[regionCol] : null
      };
    }).filter((c) => c.ip && /\d/.test(c.ip));
  }

  // Plain list fallback: "1.2.3.4", "1.2.3.4:2408", or a CSV-ish line where
  // the IP is just the first field (SenPaiScanner's ips.txt format).
  return lines
    .filter((l) => !l.startsWith('#'))
    .map((line) => {
      const first = line.split(',')[0].trim();
      const [ip, port] = first.split(':');
      return { ip, port: port || null, latencyMs: null, lossRate: null, speedMbps: null, region: null };
    })
    .filter((c) => c.ip && /\d+\.\d+\.\d+\.\d+|:/.test(c.ip));
}

class IpScanner {
  constructor(scannerDir) {
    this.scannerDir = scannerDir;
    this.exePath = path.join(scannerDir, SCANNER_EXE_NAME);
    this.versionFile = path.join(scannerDir, 'scanner-version.json');
    this.proc = null;
  }

  hasScanner() {
    // Both files matter: an install from before this fix may have only
    // the exe (see update() below) and would fail immediately with
    // "open ip.txt: ... cannot find the file specified."
    return fs.existsSync(this.exePath) && fs.existsSync(path.join(this.scannerDir, 'ip.txt'));
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
    const asset = (release.assets || []).find((a) => a.name === SCANNER_WINDOWS_ASSET);
    if (!asset) throw new Error(`release ${release.tag_name} has no ${SCANNER_WINDOWS_ASSET} asset`);
    const installed = this.getInstalledVersion();
    // "Update available" has to mean "a (re-)download is needed" — not just
    // "the version tag differs". A version-marker file can say we're on
    // the latest tag while the actual install is incomplete (e.g. an old
    // buggy download that never copied ip.txt), and hasScanner() is what
    // actually checks the files are there. Without this, the "check for
    // update" button would report "up to date" for a broken install and
    // never trigger the repair download.
    return {
      updateAvailable: !this.hasScanner() || installed !== release.tag_name,
      latestTag: release.tag_name,
      installedTag: installed,
      changelog: release.body || '',
      assetUrl: asset.browser_download_url
    };
  }

  async update(onProgress, socksAddr) {
    const info = await this.checkForUpdate(socksAddr);
    if (!info.updateAvailable && this.hasScanner()) return { updated: false, info };

    fs.mkdirSync(this.scannerDir, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gozarvpn-scanner-'));
    const zipPath = path.join(tmpDir, SCANNER_WINDOWS_ASSET);

    onProgress && onProgress({ phase: 'downloading', pct: 0 });
    await tryDirectThenTunnel(
      (addr) => downloadToFile(info.assetUrl, zipPath, (pct) => onProgress && onProgress({ phase: 'downloading', pct }), addr),
      socksAddr
    );

    onProgress && onProgress({ phase: 'extracting', pct: 1 });
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(tmpDir, true);

    // The zip's top-level exe name varies slightly across versions
    // (cfst.exe vs CloudflareST.exe). CFST also needs its bundled ip.txt
    // (the Cloudflare CIDR list it scans) sitting next to the exe, or it
    // fails immediately with "open ip.txt: ... cannot find the file" — so
    // copy everything the zip extracted, not just the .exe.
    const entries = fs.readdirSync(tmpDir);
    const found = entries.find((f) => /\.exe$/i.test(f));
    if (!found) throw new Error(`no .exe found inside ${SCANNER_WINDOWS_ASSET}`);
    for (const entry of entries) {
      const src = path.join(tmpDir, entry);
      if (fs.statSync(src).isFile()) {
        const destName = entry === found ? SCANNER_EXE_NAME : entry;
        fs.copyFileSync(src, path.join(this.scannerDir, destName));
      }
    }

    fs.writeFileSync(this.versionFile, JSON.stringify({ tag: info.latestTag, installedAt: new Date().toISOString() }, null, 2));
    fs.rmSync(tmpDir, { recursive: true, force: true });
    onProgress && onProgress({ phase: 'done', pct: 1 });
    return { updated: true, info };
  }

  /**
   * Runs a non-interactive scan and resolves with the parsed CSV once the
   * process exits. `onLine` gets raw stdout lines for a live progress feel
   * (CFST prints a text progress bar with "\r").
   *
   * @param {number} [maxIpsToScan] if set, instead of handing CFST the
   *   full ip.txt (several thousand /24 subnets — why a scan can take a
   *   long time and list far more candidates than needed), a random
   *   sample of this many IPs (one per distinct /24) is generated and
   *   passed directly via `-ip`. `count` (the existing "how many results
   *   to keep" field) already acts as an early-stop equivalent — CFST
   *   itself has no "stop once N healthy IPs found" flag mid-scan, so
   *   capping the input pool is the practical way to make a scan finish
   *   quickly and reliably.
   */
  runScan({ maxLatencyMs = 800, count = 20, skipDownloadTest = true, maxIpsToScan = null } = {}, onLine) {
    if (this.proc) throw new Error('a scan is already running');
    if (!this.hasScanner()) throw new Error('scanner is not installed');

    return new Promise((resolve, reject) => {
      const resultPath = path.join(this.scannerDir, 'result.csv');
      try { fs.unlinkSync(resultPath); } catch { /* fine if it doesn't exist yet */ }

      const args = ['-tl', String(maxLatencyMs), '-p', String(count), '-o', resultPath];
      if (skipDownloadTest) args.push('-dd');

      if (maxIpsToScan && maxIpsToScan > 0) {
        const ipTxtPath = path.join(this.scannerDir, 'ip.txt');
        try {
          const content = fs.readFileSync(ipTxtPath, 'utf8');
          const sampled = sampleIps(content, maxIpsToScan);
          if (sampled.length) {
            args.push('-ip', sampled.join(','));
          }
        } catch {
          // ip.txt missing/unreadable for some reason — fall through to
          // CFST's own default (-f ip.txt), better than failing outright.
        }
      }

      const proc = spawn(this.exePath, args, {
        cwd: this.scannerDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.proc = proc;

      proc.stdout.on('data', (d) => onLine && onLine(d.toString('utf8')));
      proc.stderr.on('data', (d) => onLine && onLine(d.toString('utf8')));

      proc.on('error', (err) => { this.proc = null; reject(err); });
      proc.on('exit', () => {
        this.proc = null;
        if (!fs.existsSync(resultPath)) {
          // Not necessarily an error — CFST writes nothing if zero IPs
          // satisfied the latency filter.
          return resolve([]);
        }
        try {
          resolve(parseCandidatesFile(resultPath));
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  cancelScan() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
      return true;
    }
    return false;
  }
}

module.exports = { IpScanner, parseCandidatesFile };
