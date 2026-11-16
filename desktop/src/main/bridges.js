'use strict';

/**
 * The user's own Tor bridge lines (from bridges.torproject.org, the Telegram bot, email…).
 * Accepts obfs4, webtunnel, snowflake, meek_lite and plain ("vanilla") lines, with or without
 * the "Bridge " prefix, IPv4 or bracketed IPv6; each line gets a verdict the user can read.
 * Same rules as the Android app (data/Bridges.kt).
 */
const TRANSPORTS = new Set(['obfs4', 'webtunnel', 'snowflake', 'meek_lite']);
const FP = /^[0-9A-Fa-f]{40}$/;
const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/;
const V6 = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/;

function check(raw) {
  const line = raw.replace(/^bridge\s+/i, '').trim().replace(/\s+/g, ' ');
  const parts = line.split(' ');
  const kind = TRANSPORTS.has(parts[0]) ? parts[0] : 'vanilla';
  const addr = kind === 'vanilla' ? parts[0] : parts[1];
  const verdict = (ok, reason) => ({ line, ok, kind, reason });
  if (!addr) return verdict(false, 'آدرس پل نیست');
  const m4 = addr.match(V4);
  const m6 = addr.match(V6);
  const addrOk = (m4 && m4.slice(1, 5).every((n) => Number(n) <= 255) && Number(m4[5]) >= 1 && Number(m4[5]) <= 65535)
    || (m6 && Number(m6[2]) >= 1 && Number(m6[2]) <= 65535);
  if (!addrOk) return verdict(false, `آدرس «${addr}» درست نیست (باید IP:پورت یا [IPv6]:پورت باشد)`);
  const rest = parts.slice(kind === 'vanilla' ? 1 : 2);
  const fp = rest.find((p) => FP.test(p));
  const opts = Object.fromEntries(rest.filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]));
  if (kind === 'obfs4') {
    if (!fp) return verdict(false, 'اثرانگشت ۴۰ رقمی پل نیست');
    if (!opts.cert) return verdict(false, 'بخش cert= نیست');
    if (!['0', '1', '2'].includes(opts['iat-mode'])) return verdict(false, 'iat-mode باید 0، 1 یا 2 باشد');
    return verdict(true, `obfs4 · ${addr.startsWith('[') ? 'IPv6' : 'IPv4'}`);
  }
  if (kind === 'webtunnel') {
    // the address is only a placeholder (often 2001:db8::); the url host is what is dialled
    if (!opts.url || !opts.url.startsWith('https://')) return verdict(false, 'بخش url=https://… نیست');
    let host = '?';
    try { host = new URL(opts.url).hostname; } catch { /* keep ? */ }
    return verdict(true, `webtunnel · ${host}`);
  }
  if (kind === 'vanilla') return fp ? verdict(true, 'پل ساده') : verdict(false, 'اثرانگشت ۴۰ رقمی پل نیست');
  return verdict(true, kind);
}

function checkAll(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('//')).map(check);
}

module.exports = { check, checkAll };
