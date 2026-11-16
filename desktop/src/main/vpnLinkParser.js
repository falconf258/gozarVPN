'use strict';

/**
 * Converts the community-standard "share link" formats for VLESS, VMess,
 * Trojan, and Shadowsocks into a sing-box outbound object. These formats
 * are not an official spec, but they're what every server panel (3x-ui,
 * Marzban, Outline, etc.) and client (v2rayN, NekoBox, Shadowrocket...)
 * actually produce, so matching them (not the sing-box docs' own JSON
 * examples) is what makes "paste your link" work in practice.
 */

function safeDecodeURIComponent(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function base64Decode(str) {
  // Share links often use unpadded / URL-safe base64.
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function parseTransport(params) {
  const net = params.get('type') || params.get('net') || 'tcp';
  const transport = {};
  switch (net) {
    case 'ws':
      transport.type = 'ws';
      transport.path = safeDecodeURIComponent(params.get('path') || '/');
      { const host = params.get('host'); if (host) transport.headers = { Host: host }; }
      break;
    case 'grpc':
      transport.type = 'grpc';
      transport.service_name = params.get('serviceName') || params.get('path') || '';
      break;
    case 'httpupgrade':
      transport.type = 'httpupgrade';
      transport.path = safeDecodeURIComponent(params.get('path') || '/');
      { const host = params.get('host'); if (host) transport.host = host; }
      break;
    case 'h2':
    case 'http':
      transport.type = 'http';
      { const host = params.get('host'); if (host) transport.host = [host]; }
      transport.path = safeDecodeURIComponent(params.get('path') || '/');
      break;
    default:
      return null; // tcp / raw — sing-box wants transport omitted entirely
  }
  return transport;
}

// sing-box's uTLS names. Xray forks add others (e.g. "unsafe" = plain Go TLS
// with the cipher list in `cs`) that make sing-box reject the whole config.
const UTLS_FINGERPRINTS = new Set(['chrome', 'firefox', 'edge', 'safari', '360', 'qq', 'ios', 'android', 'random', 'randomized']);
// Go's tls.CipherSuites(); any other name (e.g. *_CBC_SHA256) is refused by sing-box 1.14.
const GO_CIPHER_SUITES = new Set([
  'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
  'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA', 'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA',
  'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA', 'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256', 'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256'
]);

function utlsFor(fp) {
  const name = (fp || '').toLowerCase();
  return UTLS_FINGERPRINTS.has(name) ? { enabled: true, fingerprint: name } : undefined;
}

function cipherSuitesFor(cs) {
  const list = (cs || '').split(/[:,]/).map((s) => s.trim()).filter((s) => GO_CIPHER_SUITES.has(s));
  return list.length ? list : undefined;
}

function parseTls(params, defaultSni) {
  const security = params.get('security') || 'none';
  if (security === 'none' || !security) return null;

  const tls = {
    enabled: true,
    server_name: params.get('sni') || defaultSni || undefined,
    insecure: ['1', 'true'].includes(params.get('allowInsecure')) || ['1', 'true'].includes(params.get('insecure'))
  };

  const utls = utlsFor(params.get('fp'));
  if (utls) tls.utls = utls;
  else if (cipherSuitesFor(params.get('cs'))) tls.cipher_suites = cipherSuitesFor(params.get('cs'));
  // Xray's fm=/fragment= split the ClientHello to get past DPI; sing-box's equivalent
  if ((params.get('fm') || '').includes('fragment') || params.get('fragment')) {
    tls.fragment = true;
    tls.record_fragment = true;
  }

  if (security === 'reality') {
    // REALITY needs uTLS; links without a usable fp fall back to chrome
    if (!tls.utls) { tls.utls = utlsFor('chrome'); delete tls.cipher_suites; }
    tls.reality = {
      enabled: true,
      public_key: params.get('pbk') || '',
      short_id: params.get('sid') || ''
    };
  }

  const alpn = params.get('alpn');
  if (alpn) tls.alpn = alpn.split(',').map((s) => safeDecodeURIComponent(s));

  return tls;
}

function parseVless(uri) {
  const url = new URL(uri);
  const uuid = decodeURIComponent(url.username);
  const server = url.hostname;
  const port = Number(url.port) || 443;
  const params = url.searchParams;

  const outbound = {
    type: 'vless',
    tag: 'proxy',
    server,
    server_port: port,
    uuid
  };
  const flow = params.get('flow');
  if (flow) outbound.flow = flow;
  const packetEncoding = params.get('packetEncoding');
  if (packetEncoding === 'xudp' || packetEncoding === 'packetaddr') outbound.packet_encoding = packetEncoding;

  const tls = parseTls(params, server);
  if (tls) outbound.tls = tls;
  const transport = parseTransport(params);
  if (transport) outbound.transport = transport;

  return { outbound, remark: safeDecodeURIComponent(url.hash.slice(1)) || `${server}:${port}`, protocol: 'vless' };
}

function parseTrojan(uri) {
  const url = new URL(uri);
  const password = decodeURIComponent(url.username);
  const server = url.hostname;
  const port = Number(url.port) || 443;
  const params = url.searchParams;

  const outbound = {
    type: 'trojan',
    tag: 'proxy',
    server,
    server_port: port,
    password
  };
  // Trojan is TLS-by-default in every real-world deployment; only skip it
  // if the link explicitly opts out.
  const security = params.get('security');
  const tls = security === 'none' ? null : (parseTls(params, server) || { enabled: true, server_name: params.get('sni') || server });
  if (tls) outbound.tls = tls;
  const transport = parseTransport(params);
  if (transport) outbound.transport = transport;

  return { outbound, remark: safeDecodeURIComponent(url.hash.slice(1)) || `${server}:${port}`, protocol: 'trojan' };
}

function parseVmess(uri) {
  const b64 = uri.slice('vmess://'.length);
  const json = JSON.parse(base64Decode(b64));

  const server = json.add;
  const port = Number(json.port) || 443;
  const outbound = {
    type: 'vmess',
    tag: 'proxy',
    server,
    server_port: port,
    uuid: json.id,
    security: json.scy || 'auto',
    alter_id: Number(json.aid || 0)
  };

  const net = json.net || 'tcp';
  if (net === 'ws') {
    outbound.transport = { type: 'ws', path: json.path || '/', headers: json.host ? { Host: json.host } : undefined };
  } else if (net === 'grpc') {
    outbound.transport = { type: 'grpc', service_name: json.path || '' };
  } else if (net === 'h2') {
    outbound.transport = { type: 'http', host: json.host ? [json.host] : undefined, path: json.path || '/' };
  }

  if (json.tls === 'tls') {
    outbound.tls = { enabled: true, server_name: json.sni || json.host || server, insecure: false };
    if (json.alpn) outbound.tls.alpn = String(json.alpn).split(',');
  }

  return { outbound, remark: json.ps || `${server}:${port}`, protocol: 'vmess' };
}

function parseShadowsocks(uri) {
  const rest = uri.slice('ss://'.length);
  const hashIdx = rest.indexOf('#');
  const remark = hashIdx >= 0 ? safeDecodeURIComponent(rest.slice(hashIdx + 1)) : '';
  const withoutRemark = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;

  let method, password, server, port;
  const atIdx = withoutRemark.indexOf('@');

  if (atIdx >= 0) {
    // SIP002: ss://base64(method:password)@host:port  (userinfo may also be plain, unencoded)
    const userinfo = withoutRemark.slice(0, atIdx);
    const hostPart = withoutRemark.slice(atIdx + 1).split(/[?/]/)[0];
    let decodedUserinfo = userinfo;
    if (!userinfo.includes(':')) {
      try { decodedUserinfo = base64Decode(userinfo); } catch { /* fall through, keep as-is */ }
    }
    [method, password] = decodedUserinfo.split(':');
    const hostMatch = hostPart.match(/^(.+):(\d+)$/);
    if (!hostMatch) throw new Error('invalid shadowsocks host:port');
    server = hostMatch[1];
    port = Number(hostMatch[2]);
  } else {
    // Legacy: ss://base64(method:password@host:port)
    const decoded = base64Decode(withoutRemark.split(/[?/]/)[0]);
    const m = decoded.match(/^(.+?):(.+)@(.+):(\d+)$/);
    if (!m) throw new Error('invalid legacy shadowsocks uri');
    [, method, password, server, port] = m;
    port = Number(port);
  }

  const outbound = {
    type: 'shadowsocks',
    tag: 'proxy',
    server,
    server_port: port,
    method,
    password
  };

  return { outbound, remark: remark || `${server}:${port}`, protocol: 'shadowsocks' };
}

/**
 * Parses "BPB panel"-style subscriptions (very common with Cloudflare
 * Workers-fronted VLESS setups in Iran): the URL doesn't return a plain
 * list of vless://... links at all — it returns a JSON array where each
 * entry is a *complete, standalone Xray-core config* (its own inbounds,
 * outbounds, dns, routing). Clients like v2rayN understand this format
 * natively; ours didn't, so importing one of these subscriptions silently
 * found zero parseable links. This extracts the actual proxy outbound
 * from each entry and maps Xray-core's JSON field names onto the
 * sing-box outbound schema we already build for URI-parsed links.
 */
function isXrayConfigArray(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.some((e) => e && Array.isArray(e.outbounds))) return null;
  return parsed;
}

function mapXrayStreamSettings(streamSettings, outbound) {
  if (!streamSettings) return;
  const net = streamSettings.network;

  if (net === 'ws' && streamSettings.wsSettings) {
    const ws = streamSettings.wsSettings;
    outbound.transport = { type: 'ws', path: ws.path || '/' };
    const host = ws.host || (ws.headers && ws.headers.Host);
    if (host) outbound.transport.headers = { Host: host };
  } else if (net === 'grpc' && streamSettings.grpcSettings) {
    outbound.transport = { type: 'grpc', service_name: streamSettings.grpcSettings.serviceName || '' };
  } else if ((net === 'h2' || net === 'http') && streamSettings.httpSettings) {
    const http = streamSettings.httpSettings;
    outbound.transport = { type: 'http', path: (Array.isArray(http.path) ? http.path[0] : http.path) || '/', host: http.host };
  } else if (net === 'httpupgrade' && streamSettings.httpupgradeSettings) {
    const hu = streamSettings.httpupgradeSettings;
    outbound.transport = { type: 'httpupgrade', path: hu.path || '/' };
    if (hu.host) outbound.transport.host = hu.host;
  } else if (net && !['tcp', 'raw', 'ws', 'grpc', 'h2', 'http', 'httpupgrade'].includes(net)) {
    throw new Error(`انتقال ${net} در sing-box پشتیبانی نمی‌شود`);
  }

  if (streamSettings.security === 'tls' && streamSettings.tlsSettings) {
    const tls = streamSettings.tlsSettings;
    outbound.tls = {
      enabled: true,
      server_name: tls.serverName || undefined,
      insecure: !!tls.allowInsecure
    };
    const utls = utlsFor(tls.fingerprint);
    if (utls) outbound.tls.utls = utls;
    else if (cipherSuitesFor(tls.cipherSuites)) outbound.tls.cipher_suites = cipherSuitesFor(tls.cipherSuites);
    if (Array.isArray(tls.alpn) && tls.alpn.length) outbound.tls.alpn = tls.alpn;
  } else if (streamSettings.security === 'reality' && streamSettings.realitySettings) {
    const reality = streamSettings.realitySettings;
    outbound.tls = {
      enabled: true,
      server_name: reality.serverName || undefined,
      // REALITY needs uTLS; unknown names fall back to chrome
      utls: utlsFor(reality.fingerprint) || utlsFor('chrome'),
      reality: { enabled: true, public_key: reality.publicKey || '', short_id: reality.shortId || '' }
    };
  }
}

function parseXrayOutboundEntry(entry) {
  const proxyOutbound = (entry.outbounds || []).find((o) => ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(o.protocol));
  if (!proxyOutbound) return null;
  const settings = proxyOutbound.settings || {};

  if (proxyOutbound.protocol === 'vless' || proxyOutbound.protocol === 'vmess') {
    const vnext = (settings.vnext || [])[0];
    if (!vnext) return null;
    const user = (vnext.users || [])[0] || {};
    const outbound = {
      type: proxyOutbound.protocol,
      tag: 'proxy',
      server: vnext.address,
      server_port: vnext.port
    };
    if (proxyOutbound.protocol === 'vless') {
      outbound.uuid = user.id;
      if (user.flow) outbound.flow = user.flow;
    } else {
      outbound.uuid = user.id;
      outbound.security = user.security || 'auto';
      outbound.alter_id = Number(user.alterId || 0);
    }
    mapXrayStreamSettings(proxyOutbound.streamSettings, outbound);
    return { outbound, remark: entry.remarks || `${vnext.address}:${vnext.port}`, protocol: proxyOutbound.protocol };
  }

  if (proxyOutbound.protocol === 'trojan') {
    const server = (settings.servers || [])[0];
    if (!server) return null;
    const outbound = {
      type: 'trojan',
      tag: 'proxy',
      server: server.address,
      server_port: server.port,
      password: server.password
    };
    mapXrayStreamSettings(proxyOutbound.streamSettings, outbound);
    if (!outbound.tls) outbound.tls = { enabled: true, server_name: server.address };
    return { outbound, remark: entry.remarks || `${server.address}:${server.port}`, protocol: 'trojan' };
  }

  if (proxyOutbound.protocol === 'shadowsocks') {
    const server = (settings.servers || [])[0];
    if (!server) return null;
    const outbound = {
      type: 'shadowsocks',
      tag: 'proxy',
      server: server.address,
      server_port: server.port,
      method: server.method,
      password: server.password
    };
    return { outbound, remark: entry.remarks || `${server.address}:${server.port}`, protocol: 'shadowsocks' };
  }

  return null;
}

function parseXrayConfigSubscription(jsonArray) {
  const results = [];
  const errors = [];
  for (const entry of jsonArray) {
    try {
      const parsed = parseXrayOutboundEntry(entry);
      if (parsed) results.push(parsed);
      else errors.push({ link: entry.remarks || '(بدون نام)', error: 'هیچ outbound قابل‌پشتیبانی در این کانفیگ پیدا نشد' });
    } catch (err) {
      errors.push({ link: entry.remarks || '(بدون نام)', error: err.message });
    }
  }
  return { results, errors };
}

/**
 * Parses a wg-quick style WireGuard .conf file into a sing-box WireGuard
 * *endpoint* (not an outbound — sing-box moved WireGuard out of the
 * outbounds array into a separate top-level concept; see singboxManager.js).
 * AmneziaWG configs use this exact same [Interface]/[Peer] format plus
 * extra obfuscation fields (Jc/Jmin/Jmax/S1-S4/H1-H4/...) — those are
 * recognized so we can warn the person they'll be silently dropped,
 * rather than parsing (see the top-level note on why AmneziaWG itself
 * isn't supported).
 */
function parseIniSections(text) {
  const sections = {};
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[(\w+)\]$/i);
    if (sectionMatch) {
      current = sectionMatch[1].toLowerCase();
      if (!sections[current]) sections[current] = [];
      sections[current].push({});
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    sections[current][sections[current].length - 1][key] = value;
  }
  return sections;
}

const AMNEZIA_FIELDS = ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1', 'I2', 'I3', 'I4', 'I5'];

function parseWireGuardConf(confText, remarkHint) {
  const sections = parseIniSections(confText);
  const iface = (sections.interface || [])[0];
  const peer = (sections.peer || [])[0];
  if (!iface) throw new Error('بخش [Interface] در فایل یافت نشد');
  if (!peer) throw new Error('بخش [Peer] در فایل یافت نشد');
  if (!iface.PrivateKey) throw new Error('PrivateKey در بخش [Interface] یافت نشد');
  if (!peer.PublicKey) throw new Error('PublicKey در بخش [Peer] یافت نشد');
  if (!peer.Endpoint) throw new Error('Endpoint در بخش [Peer] یافت نشد');

  // AmneziaWG fields (Jc, S1-S4, H1-H4, I1-I5): the whole text runs in the AmneziaWG engine (awg.js)
  if (require('./awg').isAmnezia(confText)) {
    return { awg: { conf: String(confText).trim() }, remark: remarkHint || `AmneziaWG · ${peer.Endpoint.trim()}`, protocol: 'amneziawg', warning: null };
  }
  const endpointMatch = peer.Endpoint.trim().match(/^(.+):(\d+)$/);
  if (!endpointMatch) throw new Error(`فرمت Endpoint نامعتبر است: ${peer.Endpoint}`);
  const [, host, portStr] = endpointMatch;

  const address = (iface.Address || '10.0.0.2/32').split(',').map((s) => s.trim()).filter(Boolean);
  const allowedIps = (peer.AllowedIPs || '0.0.0.0/0,::/0').split(',').map((s) => s.trim()).filter(Boolean);

  const endpoint = {
    type: 'wireguard',
    tag: 'wg-ep',
    system: false,
    mtu: iface.MTU ? Number(iface.MTU) : 1408,
    address,
    private_key: iface.PrivateKey,
    peers: [{
      address: host,
      port: Number(portStr),
      public_key: peer.PublicKey,
      allowed_ips: allowedIps
    }]
  };
  if (peer.PresharedKey) endpoint.peers[0].pre_shared_key = peer.PresharedKey;
  if (peer.PersistentKeepalive) endpoint.peers[0].persistent_keepalive_interval = Number(peer.PersistentKeepalive);

  const hasAmneziaFields = AMNEZIA_FIELDS.some((f) => iface[f] !== undefined);

  return {
    endpoint,
    remark: remarkHint || `${host}:${portStr}`,
    protocol: 'wireguard',
    warning: hasAmneziaFields
      ? 'این فایل پارامترهای مبهم‌سازی AmneziaWG (مثل Jc/Jmin/H1...) دارد که پشتیبانی نمی‌شوند و نادیده گرفته شدند — این کانفیگ به‌صورت WireGuard معمولی وصل می‌شود، نه AmneziaWG.'
      : null
  };
}


/**
 * wireguard://PRIVATEKEY@host:port?publickey=..&address=..&reserved=1,2,3
 *   &presharedkey=..&keepalive=5&mtu=1280#name   (the share-link style used
 * by v2rayNG/Hiddify/NekoBox/WARP panels). Hiddify-only noise params
 * (wnoise*, wpayloadsize) and Amnezia parameters can't run on stock
 * sing-box and are dropped with a warning.
 */
function parseWireGuardLink(uri) {
  const decodedUri = uri.replace(/&amp;/gi, '&').replace(/&#34;|&quot;/gi, '').trim();
  let u;
  try { u = new URL(decodedUri); } catch { throw new Error('لینک wireguard:// نامعتبر است'); }
  const q = u.searchParams;
  const get = (...names) => { for (const n of names) { const v = q.get(n); if (v) return v; } return ''; };
  const privateKey = safeDecodeURIComponent(u.username).replace(/ /g, '+');
  const publicKey = get('publickey', 'public_key', 'peer_public_key').replace(/ /g, '+');
  if (!privateKey) throw new Error('کلید خصوصی در لینک wireguard:// یافت نشد');
  if (!publicKey) throw new Error('publickey در لینک wireguard:// یافت نشد');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port || 51820);

  const address = (get('address', 'ip') || '172.16.0.2/32').split(',').map((a) => a.trim()).filter(Boolean)
    .map((a) => (a.includes('/') ? a : `${a}${a.includes(':') ? '/128' : '/32'}`));
  const peer = { address: host, port, public_key: publicKey, allowed_ips: ['0.0.0.0/0', '::/0'] };
  const psk = get('presharedkey', 'pre_shared_key', 'psk');
  if (psk) peer.pre_shared_key = psk.replace(/ /g, '+');
  const keepalive = Number(get('keepalive', 'persistent_keepalive'));
  if (keepalive) peer.persistent_keepalive_interval = keepalive;
  const reserved = get('reserved').split(',').map((n) => Number(n.trim())).filter((n) => Number.isInteger(n));
  if (reserved.length === 3) peer.reserved = reserved;

  const endpoint = {
    type: 'wireguard', tag: 'wg-ep', system: false,
    mtu: Number(get('mtu')) || 1280,
    address, private_key: privateKey, peers: [peer]
  };
  const dropped = [...q.keys()].filter((k) => /^(wnoise|wpayloadsize|jc|jmin|jmax|s1|s2|h1|h2|h3|h4)/i.test(k));
  return {
    endpoint,
    remark: safeDecodeURIComponent((u.hash || '').slice(1)) || `${host}:${port}`,
    protocol: 'wireguard',
    warning: dropped.length
      ? 'پارامترهای نویز/مبهم‌سازی این لینک (مثل wnoise یا AmneziaWG) روی sing-box استاندارد کار نمی‌کنند و نادیده گرفته شدند؛ کانفیگ به‌صورت WireGuard معمولی وصل می‌شود. اگر در شبکه‌ی شما فیلتر می‌شود، ممکن است وصل نشود.'
      : null
  };
}

/**
 * @param {string} uri one share link (vless://, vmess://, trojan://, ss://)
 * @returns {{outbound: object, remark: string, protocol: string}}
 */
function parseShareLink(uri) {
  // links pasted from web pages/Telegram often carry a BOM or HTML-escaped '&'
  const trimmed = uri.replace(/^\uFEFF/, '').replace(/&amp;/gi, '&').trim();
  // "Sni-Spoofing" links point at a local helper app (127.0.0.1) that we don't ship
  if (/^\w+:\/\/[^@\s]*@(127\.0\.0\.1|localhost|\[::1\]):/i.test(trimmed)) {
    throw new Error('این کانفیگ به یک برنامه‌ی کمکی محلی (127.0.0.1) نیاز دارد و پشتیبانی نمی‌شود');
  }
  if (trimmed.startsWith('vless://')) return parseVless(trimmed);
  if (trimmed.startsWith('trojan://')) return parseTrojan(trimmed);
  if (trimmed.startsWith('vmess://')) return parseVmess(trimmed);
  if (trimmed.startsWith('ss://')) return parseShadowsocks(trimmed);
  if (/^(wireguard|wg):\/\//i.test(trimmed)) return parseWireGuardLink(trimmed.replace(/^wg:/i, 'wireguard:'));
  throw new Error('لینک پشتیبانی‌نشده — باید با vless://, vmess://, trojan://, ss:// یا wireguard:// شروع شود');
}

/**
 * Parses a whole subscription blob. Three formats are recognized, tried in
 * this order:
 * 1. A "BPB panel"-style JSON array of full Xray-core configs (see above).
 * 2. Plain text: one share link per line.
 * 3. A single base64 block that decodes to newline-separated links.
 */
function parseSubscription(text) {
  const trimmedRaw = text.replace(/^\uFEFF/, '').trim();
  const xrayArray = isXrayConfigArray(trimmedRaw);
  if (xrayArray) return parseXrayConfigSubscription(xrayArray);

  if (/^\[Interface\]/im.test(trimmedRaw)) {
    try {
      return { results: [parseWireGuardConf(trimmedRaw)], errors: [] };
    } catch (err) {
      return { results: [], errors: [{ link: '(WireGuard .conf)', error: err.message }] };
    }
  }

  let body = trimmedRaw;
  if (!/^(vless|vmess|trojan|ss|wireguard|wg):\/\//m.test(body)) {
    try { body = base64Decode(body); } catch { /* keep as-is, will fail per-line below */ }
  }
  // '#' lines are subscription metadata (#profile-title: ...), not configs
  const links = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const results = [];
  const errors = [];
  for (const link of links) {
    try { results.push(parseShareLink(link)); } catch (err) { errors.push({ link, error: err.message }); }
  }
  return { results, errors };
}

module.exports = { parseShareLink, parseSubscription, parseWireGuardConf };
