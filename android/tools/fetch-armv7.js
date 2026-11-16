'use strict';
// Downloads the official armv7 Android builds of Aether, Tor (Expert Bundle) and mihomo into a
// fresh directory and checks each against the SHA-256 its publisher lists. Nothing is executed.
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });

function get(url, asJson) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'gozarvpn-build', Accept: asJson ? 'application/vnd.github+json' : '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(get(res.headers.location, asJson)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${res.statusCode} ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); resolve(asJson ? JSON.parse(b) : b); });
    }).on('error', reject);
  });
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function save(name, buf, expected) {
  const got = sha(buf);
  if (got !== expected.toLowerCase()) throw new Error(`${name}: SHA-256 mismatch (expected ${expected}, got ${got})`);
  fs.writeFileSync(path.join(out, name), buf);
  console.log(`ok ${name} ${(buf.length / 1048576).toFixed(1)} MB sha256 ${got}`);
}

(async () => {
  // Aether: release ships <asset>.sha256 next to each archive
  const aeBase = 'https://github.com/CluvexStudio/Aether/releases/download/v2.4.0/aether-android-armv7.tar.gz';
  const aeSum = (await get(`${aeBase}.sha256`)).toString().trim().split(/\s+/)[0];
  await save('aether-android-armv7.tar.gz', await get(aeBase), aeSum);

  // mihomo: the GitHub API lists a sha256 digest per asset
  const rel = await get('https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/v1.19.33', true);
  const asset = rel.assets.find((a) => a.name === 'mihomo-android-armv7-v1.19.33.gz');
  if (!asset || !/^sha256:/.test(asset.digest || '')) throw new Error('mihomo armv7 asset/digest not found');
  await save(asset.name, await get(asset.browser_download_url), asset.digest.slice(7));

  // Tor: the Tor Project publishes sha256sums-signed-build.txt for each version
  const torDir = 'https://archive.torproject.org/tor-package-archive/torbrowser/15.0.25/';
  const torName = 'tor-expert-bundle-android-armv7-15.0.25.tar.gz';
  const sums = (await get(`${torDir}sha256sums-signed-build.txt`)).toString();
  const line = sums.split('\n').find((l) => l.trim().endsWith(torName));
  if (!line) throw new Error('tor armv7 checksum line not found');
  await save(torName, await get(torDir + torName), line.trim().split(/\s+/)[0]);
})().catch((e) => { console.log('FAILED', e.message); process.exit(1); });
