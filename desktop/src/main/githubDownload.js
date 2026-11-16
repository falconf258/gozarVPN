'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { SocksProxyAgent } = require('socks-proxy-agent');

const REQUEST_TIMEOUT_MS = 15000;

/**
 * Builds an https.Agent that routes through the app's own local SOCKS5
 * proxy (i.e. through the Aether tunnel that's already connected) instead
 * of a direct connection. GitHub is commonly filtered/throttled on
 * networks where Aether itself gets through fine, so once the tunnel is
 * up, downloading updates *through it* — instead of asking the user to
 * run a second, separate VPN just to reach GitHub — fixes exactly that.
 * Pass null/undefined for a normal direct connection.
 */
function agentFor(socksAddr) {
  if (!socksAddr) return undefined;
  return new SocksProxyAgent(`socks5h://${socksAddr}`, { timeout: REQUEST_TIMEOUT_MS });
}

// Node's newer Happy-Eyeballs (dual-stack) connection logic wraps every
// failed IPv4/IPv6 attempt into an AggregateError whose own .message is
// empty, so it renders in the UI as just the bare string "AggregateError"
// with zero useful information. This unwraps it into one readable line —
// this is exactly what heavily filtered networks (e.g. GitHub being
// throttled/blocked) look like from Node's perspective.
function describeNetworkError(err, viaTunnel) {
  const viaSuffix = viaTunnel
    ? ' (این درخواست از طریق تونل GozarVpn هم امتحان شد و باز هم جواب نداد.)'
    : ' اگر همین الان به GozarVpn متصل هستید، دوباره امتحان کنید — درخواست بعدی خودکار از همان تونل رد می‌شود.';
  if (err && Array.isArray(err.errors) && err.errors.length) {
    const codes = [...new Set(err.errors.map((e) => e.code || e.message))].join(', ');
    return `اتصال به GitHub برقرار نشد (${codes}).${viaSuffix}`;
  }
  if (err && (err.code === 'ETIMEDOUT' || err.message === 'request timed out')) {
    return `اتصال به GitHub با تایم‌اوت مواجه شد.${viaSuffix}`;
  }
  return `خطا در ارتباط با GitHub: ${err && err.message ? err.message : err}${viaSuffix}`;
}

function httpsGetJson(url, socksAddr) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'gozarvpn-updater', Accept: 'application/vnd.github+json' },
      timeout: REQUEST_TIMEOUT_MS,
      agent: agentFor(socksAddr)
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGetJson(res.headers.location, socksAddr));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`GitHub API returned ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (err) => reject(new Error(describeNetworkError(err, !!socksAddr))));
  });
}

function httpsGetText(url, socksAddr) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'gozarvpn-updater' },
      timeout: REQUEST_TIMEOUT_MS,
      agent: agentFor(socksAddr)
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGetText(res.headers.location, socksAddr));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`download returned ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (err) => reject(new Error(describeNetworkError(err, !!socksAddr))));
  });
}

// A download that receives nothing for this long is abandoned (instead of hanging forever).
const STALL_MS = 30000;

function downloadToFile(url, destPath, onProgress, socksAddr) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const request = (u) => {
      const req = https.get(u, {
        headers: { 'User-Agent': 'gozarvpn-updater' },
        timeout: REQUEST_TIMEOUT_MS,
        agent: agentFor(socksAddr)
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          res.resume();
          fail(new Error(`download returned ${res.statusCode} for ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        let ended = false;
        const file = fs.createWriteStream(destPath);
        let stall = null;
        const bump = () => {
          clearTimeout(stall);
          stall = setTimeout(() => { res.destroy(); file.destroy(); fail(new Error('دانلود متوقف ماند (۳۰ ثانیه داده‌ای نرسید). دوباره امتحان کنید.')); }, STALL_MS);
        };
        // Through some proxies the connection lingers after the last byte, so 'end' never
        // came and the update sat at 100% forever; with a known size, the last byte finishes it.
        const finish = () => {
          if (ended) return;
          ended = true;
          clearTimeout(stall);
          file.end(() => {
            res.destroy();
            if (total && received < total) return fail(new Error(`دانلود ناقص ماند (${received} از ${total} بایت).`));
            if (!settled) { settled = true; resolve(destPath); }
          });
        };
        bump();
        res.on('data', (chunk) => {
          if (ended) return;
          received += chunk.length;
          file.write(chunk);
          bump();
          if (onProgress && total) onProgress(Math.min(1, received / total));
          if (total && received >= total) finish();
        });
        res.on('end', finish);
        res.on('error', (err) => { clearTimeout(stall); fail(err); });
        file.on('error', (err) => { clearTimeout(stall); res.destroy(); fail(err); });
      });
      req.on('timeout', () => req.destroy(new Error('request timed out')));
      req.on('error', (err) => fail(new Error(describeNetworkError(err, !!socksAddr))));
    };
    request(url);
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Tries a direct connection first (fastest path, and the only option
 * before any tunnel exists), and — only if that fails and a SOCKS address
 * was given — retries once through it. This is what lets scanner/core
 * updates succeed on a filtered network without the user needing a
 * second, separate VPN: once GozarVpn's own tunnel is up, its traffic
 * (which already gets through) is reused for these downloads too.
 */
async function tryDirectThenTunnel(fn, socksAddr) {
  try {
    return await fn(undefined);
  } catch (directErr) {
    if (!socksAddr) throw directErr;
    try {
      return await fn(socksAddr);
    } catch (tunnelErr) {
      throw tunnelErr;
    }
  }
}

module.exports = { httpsGetJson, httpsGetText, downloadToFile, sha256File, describeNetworkError, tryDirectThenTunnel };
