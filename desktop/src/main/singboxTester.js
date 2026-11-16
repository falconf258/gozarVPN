'use strict';

const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildConfig } = require('./singboxManager');
const { verifyTunnel } = require('./connectivityCheck');

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Spins up a short-lived, isolated sing-box process for exactly one
 * outbound, waits for it to come up, measures a real SOCKS5 CONNECT
 * round-trip through it (same check used before enabling the system
 * proxy for the main connection), then tears everything down. Uses
 * freshly-picked free ports so this is safe to run even while the main
 * connection (Aether or a different sing-box config) is active.
 *
 * @returns {{ok: boolean, latencyMs?: number, error?: string}}
 */
async function testOutbound(exePath, proxyEntry, { timeoutMs = 12000, testHost = '1.1.1.1', testPort = 443 } = {}) {
  if (!fs.existsSync(exePath)) {
    return { ok: false, error: 'sing-box.exe نصب نشده' };
  }

  const socksPort = await findFreePort();
  const httpPort = await findFreePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gozarvpn-test-'));
  const configPath = path.join(tmpDir, 'config.json');
  const config = buildConfig(proxyEntry, { socksAddr: `127.0.0.1:${socksPort}`, httpAddr: `127.0.0.1:${httpPort}` });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  const proc = spawn(exePath, ['run', '--disable-color', '-c', configPath], {
    cwd: tmpDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const cleanup = () => {
    try { proc.kill(); } catch { /* already gone */ }
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } }, 1500);
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  };

  try {
    const readyWithinTimeout = await new Promise((resolve) => {
      let settled = false;
      const onData = (d) => {
        if (settled) return;
        if (/tcp server started at/.test(d.toString())) {
          settled = true;
          resolve(true);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', () => { if (!settled) { settled = true; resolve(false); } });
      setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, Math.min(6000, timeoutMs));
    });

    if (!readyWithinTimeout) {
      return { ok: false, error: 'sing-box در زمان مقرر بالا نیامد (احتمالاً کانفیگ نامعتبر است)' };
    }

    const start = Date.now();
    const result = await verifyTunnel(`127.0.0.1:${socksPort}`, {
      timeoutMs: Math.max(2000, timeoutMs - (Date.now() - start)),
      testHost,
      testPort
    });
    const latencyMs = Date.now() - start;

    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, latencyMs };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    cleanup();
  }
}

module.exports = { testOutbound };
