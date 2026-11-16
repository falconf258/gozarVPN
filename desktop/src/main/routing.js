'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');

/**
 * "Iran direct" routing: Iranian domains (geosite-ir) and IP ranges (geoip-ir) from
 * Chocolate4U/Iran-sing-box-rules (GPL-3.0) leave directly; everything else goes through the
 * engine. A snapshot ships in resources/rules; an in-app update writes newer copies to
 * <userData>/rules, which then win.
 */
const MIRROR = 'https://cdn.jsdelivr.net/gh/Chocolate4U/Iran-sing-box-rules@rule-set/';

function bundledDir() {
  const packaged = path.join(process.resourcesPath || '', 'resources', 'rules');
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'resources', 'rules');
}

/** Folder whose geosite-ir.srs / geoip-ir.srs are in use (an update in userData wins). */
function rulesDir(userDir) {
  return fs.existsSync(path.join(userDir, 'updated.json')) ? userDir : bundledDir();
}

/**
 * Iranian IPv4 ranges as CIDR text (for engines that route by IP, like OpenVPN). An updated
 * geoip-ir.srs is turned into text with sing-box once; otherwise the bundled list is used.
 */
function irCidrsV4(userDir, singboxExe) {
  let file = path.join(bundledDir(), 'geoip-ir.txt');
  if (rulesDir(userDir) === userDir && singboxExe && fs.existsSync(singboxExe)) {
    const srs = path.join(userDir, 'geoip-ir.srs');
    const txt = path.join(userDir, 'geoip-ir.txt');
    try {
      if (!fs.existsSync(txt) || fs.statSync(txt).mtimeMs < fs.statSync(srs).mtimeMs) {
        const json = path.join(userDir, 'geoip-ir.json');
        require('child_process').execFileSync(singboxExe, ['rule-set', 'decompile', srs, '-o', json], { windowsHide: true, timeout: 20000 });
        const cidrs = JSON.parse(fs.readFileSync(json, 'utf8')).rules.flatMap((r) => r.ip_cidr || []);
        fs.writeFileSync(txt, cidrs.join('\n') + '\n');
        fs.unlinkSync(json);
      }
      file = txt;
    } catch { /* keep the bundled list */ }
  }
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.includes(':'));
  } catch { return []; }
}

function version(userDir) {
  const f = path.join(rulesDir(userDir), fs.existsSync(path.join(userDir, 'updated.json')) ? 'updated.json' : 'rules.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).date || '?'; } catch { return '?'; }
}

const lines = (t) => String(t || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
const IP_LIKE = /^[0-9a-f:.]+(\/\d+)?$/i;
const isIp = (e) => IP_LIKE.test(e) && /\d/.test(e) && /[.:]/.test(e) && !/[g-z]/i.test(e);
const cidr = (e) => (e.includes('/') ? e : e.includes(':') ? `${e}/128` : `${e}/32`);

/** One sing-box rule for the user's entries (domain suffixes and IPs), or null. */
function listRule(entries, outbound) {
  const clean = entries.map((e) => e.toLowerCase().replace(/^\.+/, '')).filter(Boolean);
  const ips = clean.filter(isIp);
  const domains = clean.filter((e) => !isIp(e));
  if (!ips.length && !domains.length) return null;
  const r = {};
  if (domains.length) r.domain_suffix = domains;
  if (ips.length) r.ip_cidr = ips.map(cidr);
  r.outbound = outbound;
  return r;
}

/**
 * Adds the routing choice to a sing-box config that has `proxy` and `direct` outbounds.
 * routing = { mode: 'all'|'iran'|'custom', direct: text, proxy: text }; afterIndex = how many
 * of the existing route rules must stay in front (sniff, process bypass, hijack-dns).
 */
function apply(cfg, routing, userDir, afterIndex) {
  const mode = (routing && routing.mode) || 'all';
  const direct = lines(routing && routing.direct);
  const proxyList = lines(routing && routing.proxy);
  const iran = mode === 'iran';
  const custom = mode === 'custom';
  const proxyRule = listRule(proxyList, 'proxy');
  const directRule = listRule(direct, 'direct');
  if (!iran && !custom && !proxyRule && !directRule) return cfg;

  const added = [];
  if (proxyRule) added.push(proxyRule);
  if (directRule) added.push(directRule);
  if (iran) {
    const dir = rulesDir(userDir);
    cfg.route.rule_set = ['geosite-ir', 'geoip-ir'].map((tag) => ({ type: 'local', tag, format: 'binary', path: path.join(dir, `${tag}.srs`) }));
    added.push({ domain_suffix: ['ir'], outbound: 'direct' });
    added.push({ rule_set: ['geosite-ir', 'geoip-ir'], outbound: 'direct' });
  }
  cfg.route.rules.splice(afterIndex, 0, ...added);
  if (custom) cfg.route.final = 'direct';

  // names that leave directly also resolve directly, through the system resolver
  cfg.dns = cfg.dns || { servers: [] };
  cfg.dns.servers.push({ type: 'local', tag: 'dns-local' });
  const dnsRules = [];
  const directDomains = [...(iran ? ['ir'] : []), ...direct.filter((e) => !isIp(e)).map((e) => e.toLowerCase().replace(/^\.+/, ''))];
  if (proxyRule && proxyRule.domain_suffix) dnsRules.push({ domain_suffix: proxyRule.domain_suffix, server: cfg.dns.final });
  if (directDomains.length) dnsRules.push({ domain_suffix: directDomains, server: 'dns-local' });
  if (iran) dnsRules.push({ rule_set: ['geosite-ir'], server: 'dns-local' });
  cfg.dns.rules = [...dnsRules, ...(cfg.dns.rules || [])];
  if (custom) cfg.dns.final = 'dns-local';
  return cfg;
}

/** Why would host go direct? null = through the VPN. Uses the text list next to the .srs files. */
let suffixCache = null;
function explain(host, routing, userDir) {
  const h = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0].replace(/\.$/, '');
  if (!h) return null;
  const mode = (routing && routing.mode) || 'all';
  const hit = (list) => lines(list).find((e) => { const s = e.toLowerCase().replace(/^\.+/, ''); return s && (h === s || h.endsWith(`.${s}`)); });
  if (mode === 'all') return null;
  if (hit(routing.proxy)) return null;
  if (mode === 'custom') return 'خارج از لیست «همیشه از VPN»';
  const d = hit(routing.direct);
  if (d) return `در لیست «همیشه مستقیم» شما (${d})`;
  if (h === 'ir' || h.endsWith('.ir')) return 'دامنه‌ی ‎.ir';
  if (!suffixCache) {
    const f = [path.join(rulesDir(userDir), 'geosite-ir.txt'), path.join(bundledDir(), 'geosite-ir.txt')].find((p) => fs.existsSync(p));
    suffixCache = new Set(f ? fs.readFileSync(f, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean) : []);
  }
  for (let cur = h; cur; cur = cur.includes('.') ? cur.slice(cur.indexOf('.') + 1) : '') {
    if (suffixCache.has(cur)) return `در فهرست سایت‌های ایرانی (${cur})`;
    if (!cur.includes('.')) break;
  }
  return null;
}

function download(url, socksAddr) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'gozarvpn' }, agent: socksAddr ? new SocksProxyAgent(`socks5h://${socksAddr}`) : undefined, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(download(res.headers.location, socksAddr)); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Fetches fresh rule-sets (through the tunnel's SOCKS port when given). A file is accepted only
 * if it is a sing-box rule-set ("SRS" header) and not much smaller than the current one.
 */
async function update(userDir, socksAddr) {
  fs.mkdirSync(userDir, { recursive: true });
  const cur = rulesDir(userDir);
  const got = {};
  for (const name of ['geosite-ir.srs', 'geoip-ir.srs']) {
    const buf = await download(MIRROR + name, socksAddr);
    let old = 0;
    try { old = fs.statSync(path.join(cur, name)).size; } catch { /* none yet */ }
    if (buf.length < 16 || buf.slice(0, 3).toString() !== 'SRS') throw new Error(`فایل ${name} معتبر نیست`);
    if (buf.length < old / 2) throw new Error(`فایل ${name} از نسخه‌ی فعلی خیلی کوچک‌تر است`);
    got[name] = buf;
  }
  // the domain-tester text list only comes with app releases; keep the bundled one beside the update
  const txt = path.join(bundledDir(), 'geosite-ir.txt');
  if (fs.existsSync(txt) && !fs.existsSync(path.join(userDir, 'geosite-ir.txt'))) fs.copyFileSync(txt, path.join(userDir, 'geosite-ir.txt'));
  for (const [name, buf] of Object.entries(got)) { fs.writeFileSync(path.join(userDir, `${name}.tmp`), buf); fs.renameSync(path.join(userDir, `${name}.tmp`), path.join(userDir, name)); }
  const date = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(userDir, 'updated.json'), JSON.stringify({ date }));
  suffixCache = null;
  return date;
}

module.exports = { apply, explain, update, version, rulesDir, irCidrsV4 };
