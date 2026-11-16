'use strict';

const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { testOutbound } = require('./singboxTester');

const PROBE_URL = 'https://cp.cloudflare.com/generate_204';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

function apiGet(port, apiPath, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: apiPath, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, json: null }));
  });
}

/**
 * The old test only did a SOCKS CONNECT to the local sing-box, which sing-box answers at once
 * for Shadowsocks/VLESS without touching the server, so every config "pinged" 5-8 ms. This
 * measures a real HTTPS request through each server instead: one sing-box per chunk of
 * configs, and its Clash API delay endpoint (GET /proxies/<tag>/delay) per server. A chunk
 * that won't start (one bad config) falls back to one temporary sing-box per config.
 */
async function testMany(exePath, cfgs, { chunkSize = 150, concurrency = 24, timeoutMs = 7000, onResult, isCancelled = () => false } = {}) {
  // AmneziaWG entries cannot go into a sing-box config: each gets its own short engine run, 4 at a time
  const awgCfgs = cfgs.filter((c) => c.awg);
  cfgs = cfgs.filter((c) => !c.awg);
  const { testAwg } = require('./awg');
  const { verifyTunnel } = require('./connectivityCheck');
  const awgQueue = [...awgCfgs];
  await Promise.all(Array.from({ length: Math.min(4, awgQueue.length) }, async () => {
    while (awgQueue.length && !isCancelled()) { const c = awgQueue.shift(); onResult(c, await testAwg(c.awg.conf, verifyTunnel)); }
  }));
  for (let start = 0; start < cfgs.length && !isCancelled(); start += chunkSize) {
    const chunk = cfgs.slice(start, start + chunkSize);
    const ok = await testChunk(exePath, chunk, { concurrency, timeoutMs, onResult, isCancelled });
    if (!ok) {
      for (const cfg of chunk) {
        if (isCancelled()) return;
        onResult(cfg, await testOutbound(exePath, cfg, { timeoutMs: timeoutMs + 4000 }));
      }
    }
  }
}

async function testChunk(exePath, chunk, { concurrency, timeoutMs, onResult, isCancelled }) {
  const port = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gozarvpn-batch-'));
  const tags = chunk.map((_, i) => `p${i}`);
  const config = {
    log: { level: 'error' },
    // same resolver choice as the real connection (see singboxManager.buildConfig)
    dns: { servers: [{ type: 'udp', tag: 'bootstrap', server: '1.1.1.1' }] },
    outbounds: [{ type: 'direct', tag: 'direct' }],
    endpoints: [],
    route: { default_domain_resolver: 'bootstrap', final: 'direct' },
    experimental: { clash_api: { external_controller: `127.0.0.1:${port}` } }
  };
  chunk.forEach((cfg, i) => {
    if (cfg.endpoint) config.endpoints.push({ ...cfg.endpoint, tag: tags[i] });
    else if (cfg.outbound) config.outbounds.push({ ...cfg.outbound, tag: tags[i] });
  });
  if (!config.endpoints.length) delete config.endpoints;
  const configPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));

  const proc = spawn(exePath, ['run', '--disable-color', '-c', configPath], { cwd: tmpDir, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
  let exited = false;
  proc.on('exit', () => { exited = true; });
  try {
    // ready once the API answers; a config error makes the process exit instead
    const deadline = Date.now() + 8000;
    let ready = false;
    while (!ready && !exited && Date.now() < deadline) {
      ready = (await apiGet(port, '/version', 1000)).status === 200;
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) return false;

    const queue = chunk.map((cfg, i) => [cfg, tags[i]]);
    const delay = async (tag) => {
      const r = await apiGet(port, `/proxies/${tag}/delay?url=${encodeURIComponent(PROBE_URL)}&timeout=${timeoutMs}`, timeoutMs + 2000);
      return r.status === 200 && r.json && r.json.delay > 0 ? r.json.delay : null;
    };
    const worker = async () => {
      while (queue.length && !isCancelled() && !exited) {
        const [cfg, tag] = queue.shift();
        const first = await delay(tag);
        // a second try for live servers: the first request also pays for DNS and the handshake
        const ms = first == null ? null : Math.min(first, (await delay(tag)) || first);
        onResult(cfg, ms == null ? { ok: false, error: 'درخواست واقعی از این سرور رد نشد (تایم‌اوت یا خطا)' } : { ok: true, latencyMs: ms });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    return true;
  } finally {
    try { proc.kill(); } catch { /* already gone */ }
    setTimeout(() => fs.rm(tmpDir, { recursive: true, force: true }, () => {}), 1500);
  }
}

/** True when TCP connects to addresses that can't exist still "succeed": another VPN/TUN is answering for them. */
function tunInterceptsTcp() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '198.51.100.7', port: 443 });
    s.setTimeout(1500);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

module.exports = { testMany, tunInterceptsTcp, PROBE_URL };
