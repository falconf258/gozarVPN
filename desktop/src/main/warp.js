'use strict';

const https = require('https');
const crypto = require('crypto');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * Free Cloudflare WARP: registers a throw-away device with Cloudflare's
 * consumer API (the same call the official app and `wgcf` make), then
 * returns a WireGuard endpoint sing-box can run directly. No account or
 * licence key is involved, so this is the free WARP tier.
 */
const API = 'https://api.cloudflareclient.com/v0a2158/reg';
// Fixed Cloudflare edge address; the hostname engage.cloudflareclient.com
// is often poisoned on filtered networks, the IP is not.
const DEFAULT_ENDPOINT = { host: '162.159.192.1', port: 2408 };

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  return { privateKey: priv.toString('base64'), publicKey: pub.toString('base64') };
}

function request(method, url, body, headers, socksAddr) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method,
      timeout: 15000,
      agent: socksAddr ? new SocksProxyAgent(`socks5h://${socksAddr}`, { timeout: 15000 }) : undefined,
      headers: {
        'User-Agent': 'okhttp/3.12.1',
        'CF-Client-Version': 'a-6.3-1922',
        'Content-Type': 'application/json; charset=UTF-8',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Cloudflare API ${res.statusCode}: ${data.slice(0, 200)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', (err) => reject(new Error(`اتصال به سرور Cloudflare برقرار نشد (${err.code || err.message}). یک اتصال فعال (مثلاً Aether) داشته باشید و دوباره امتحان کنید.`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** @returns {Promise<{endpoint: object, remark: string, protocol: string, warning: null}>} */
async function registerWarp(socksAddr) {
  const keys = generateKeyPair();
  const reg = await request('POST', API, {
    key: keys.publicKey,
    install_id: '',
    fcm_token: '',
    tos: new Date().toISOString(),
    type: 'Android',
    model: 'PC',
    locale: 'en_US'
  }, {}, socksAddr);

  const cfg = reg.config || {};
  const peer = (cfg.peers || [])[0];
  if (!peer || !peer.public_key) throw new Error('پاسخ Cloudflare ناقص بود (peer پیدا نشد).');
  const addrs = (cfg.interface && cfg.interface.addresses) || {};
  const address = [addrs.v4 && `${addrs.v4}/32`, addrs.v6 && `${addrs.v6}/128`].filter(Boolean);
  if (!address.length) address.push('172.16.0.2/32');
  // client_id is 3 base64 bytes — the "reserved" field WARP checks.
  const reserved = cfg.client_id ? [...Buffer.from(cfg.client_id, 'base64')].slice(0, 3) : null;

  // Best effort: make sure the registration is switched on.
  try { await request('PATCH', `${API}/${reg.id}/account`, { warp_enabled: true }, { Authorization: `Bearer ${reg.token}` }, socksAddr); } catch { /* optional */ }

  const wgPeer = {
    address: DEFAULT_ENDPOINT.host,
    port: DEFAULT_ENDPOINT.port,
    public_key: peer.public_key,
    allowed_ips: ['0.0.0.0/0', '::/0']
  };
  if (reserved && reserved.length === 3) wgPeer.reserved = reserved;

  return {
    endpoint: {
      type: 'wireguard', tag: 'wg-ep', system: false, mtu: 1280,
      address, private_key: keys.privateKey, peers: [wgPeer]
    },
    remark: 'Cloudflare WARP (رایگان)',
    protocol: 'wireguard',
    warning: null
  };
}

module.exports = { registerWarp, generateKeyPair };
