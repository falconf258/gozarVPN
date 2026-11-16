'use strict';

/**
 * CFST's default ip.txt is a list of CIDR ranges, not individual IPs — by
 * default it tests one random host per /24 subnet within each range,
 * which across the whole list is several thousand subnets (hence "why is
 * it scanning so many IPs and taking forever"). This lets the person cap
 * that: pick N /24 subnets at random across the whole range list, one
 * random host IP each, and hand that fixed list to CFST via its `-ip`
 * flag instead of `-f ip.txt` — so exactly N IPs get tested, not
 * thousands.
 */

function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIp(int) {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}

/**
 * Parses "ip.txt" content and returns every distinct /24 subnet (as its
 * base integer, i.e. the address with the last octet zeroed) covered by
 * the CIDR list. CIDRs with prefix >= 24 count as exactly one subnet;
 * shorter prefixes are expanded into all of their constituent /24s.
 */
function enumerateSubnets(ipTxtContent) {
  const subnets = new Set();
  const lines = ipTxtContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (!m) continue; // ignore anything that isn't a plain IPv4 CIDR (e.g. IPv6 lines, comments)
    const base = ipToInt(m[1]);
    const prefix = Number(m[2]);

    if (prefix >= 24) {
      subnets.add(base & 0xffffff00);
      continue;
    }

    const subnetCount = 2 ** (24 - prefix);
    const networkBase = base & (0xffffffff << (32 - prefix));
    for (let i = 0; i < subnetCount; i++) {
      subnets.add((networkBase + (i << 8)) >>> 0);
    }
  }

  return Array.from(subnets);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @param {string} ipTxtContent raw content of ip.txt
 * @param {number} count how many IPs to return
 * @returns {string[]} up to `count` IPv4 addresses, one per randomly
 *   chosen /24 subnet, each guaranteed to fall inside the original CIDR list.
 */
function sampleIps(ipTxtContent, count) {
  const subnetBases = enumerateSubnets(ipTxtContent);
  const chosen = shuffle(subnetBases).slice(0, Math.min(count, subnetBases.length));
  return chosen.map((base) => intToIp(base + 1 + Math.floor(Math.random() * 253))); // .1–.253, avoid .0/.254/.255 edge cases
}

module.exports = { sampleIps, enumerateSubnets, ipToInt, intToIp };
