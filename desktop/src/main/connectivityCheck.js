'use strict';

const https = require('https');
const http = require('http');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * The core printing "socks5 server listening on ..." only means the local
 * listener bound — it says nothing about whether the tunnel behind it carries
 * a byte. Turning the system proxy on for a dead tunnel blacks out the whole
 * internet, so this checks first, before anything touches the system proxy.
 *
 * A SOCKS CONNECT alone is not enough: sing-box (Shadowsocks, VLESS…) answers it
 * at once without contacting the server. So real requests go through the proxy.
 * Several URLs (HTTP and HTTPS, different providers) race each round and any
 * answer counts, because a single filtered or slow URL made working tunnels fail.
 */
const PROBE_URLS = [
  'https://cp.cloudflare.com/generate_204',
  'https://www.gstatic.com/generate_204',
  'http://connectivitycheck.gstatic.com/generate_204',
  'https://1.1.1.1/cdn-cgi/trace'
];

function probeOnce(socksAddr, url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const mod = url.startsWith('https') ? https : http;
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`${url}: تایم‌اوت ${timeoutMs / 1000} ثانیه`)); }, timeoutMs);
    const req = mod.get(url, { agent: new SocksProxyAgent(`socks5h://${socksAddr}`, { timeout: timeoutMs }), headers: { 'User-Agent': 'gozarvpn-check' } }, (res) => {
      res.resume();
      clearTimeout(timer);
      if (res.statusCode >= 200 && res.statusCode < 400) resolve({ ms: Date.now() - t0, url });
      else reject(new Error(`${url}: پاسخ ${res.statusCode}`));
    });
    req.on('error', (err) => { clearTimeout(timer); reject(new Error(`${url}: ${err.code || err.message}`)); });
  });
}

/**
 * @param {object} [opts] attempts: rounds to try (a gap of gapMs between them); log(level, text) gets
 *   each failed round's reasons; urls: override the probe list (the ping test uses just the first).
 */
async function verifyTunnel(socksAddr, { timeoutMs = 10000, attempts = 1, gapMs = 3000, log = null, urls = PROBE_URLS } = {}) {
  const [host, portStr] = socksAddr.split(':');
  if (!host || !Number(portStr)) return { ok: false, error: `invalid proxy address: ${socksAddr}` };
  let lastError = '';
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await Promise.any(urls.map((u) => probeOnce(socksAddr, u, timeoutMs)));
      if (log && i > 1) log('info', `[gui] بررسی تونل در تلاش ${i} موفق شد (${r.url}، ${r.ms} ms)`);
      return { ok: true, latencyMs: r.ms };
    } catch (agg) {
      const reasons = (agg.errors || [agg]).map((e) => e.message);
      lastError = reasons[0] || 'تونل جواب نداد';
      if (log) log('warn', `[gui] بررسی تونل، تلاش ${i} از ${attempts} ناموفق: ${reasons.join(' | ')}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  return { ok: false, error: lastError };
}

module.exports = { verifyTunnel, PROBE_URLS };
