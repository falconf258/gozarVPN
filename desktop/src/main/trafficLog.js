'use strict';

// Local data-usage history: hourly buckets kept in userData/traffic.json and never sent anywhere.
// Each bucket holds, per engine, [netDown, netUp, tunDown, tunUp] in bytes:
//   net = the PC's physical network adapters while connected (what the ISP counts)
//   tun = the tunnel adapter (TUN mode and OpenVPN only), i.e. what apps sent through the VPN.

const fs = require('fs');
const path = require('path');

const KEEP_DAYS = 400;

/** Local-time start of the unit that contains ts. Weeks start on Saturday (as in Iran). */
function unitStart(ts, unit) {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  if (unit === 'hour') return d.getTime();
  d.setHours(0);
  if (unit === 'day') return d.getTime();
  if (unit === 'week') { d.setDate(d.getDate() - ((d.getDay() + 1) % 7)); return d.getTime(); }
  if (unit === 'month') { d.setDate(1); return d.getTime(); }
  throw new Error(`unknown unit ${unit}`);
}

/** Start of the unit after the one that starts at start (calendar-aware, so DST-safe). */
function nextUnit(start, unit) {
  const d = new Date(start);
  if (unit === 'hour') d.setHours(d.getHours() + 1);
  else if (unit === 'day') d.setDate(d.getDate() + 1);
  else if (unit === 'week') d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

/** The standard views: [from, to) and the unit used for the bars. */
function viewRange(view, now = Date.now(), from = null, to = null) {
  if (view === 'hour') { const end = nextUnit(unitStart(now, 'hour'), 'hour'); return { from: end - 24 * 3600e3, to: end, unit: 'hour' }; }
  if (view === 'day') { const end = nextUnit(unitStart(now, 'day'), 'day'); const s = new Date(end); s.setDate(s.getDate() - 30); return { from: s.getTime(), to: end, unit: 'day' }; }
  if (view === 'week') { const end = nextUnit(unitStart(now, 'week'), 'week'); const s = new Date(end); s.setDate(s.getDate() - 7 * 12); return { from: s.getTime(), to: end, unit: 'week' }; }
  if (view === 'month') { const end = nextUnit(unitStart(now, 'month'), 'month'); const s = new Date(end); s.setMonth(s.getMonth() - 12); return { from: s.getTime(), to: end, unit: 'month' }; }
  // custom: whole days from..to inclusive; hours for up to two days, else days
  const f = unitStart(from, 'day');
  const t = nextUnit(unitStart(Math.max(from, to), 'day'), 'day');
  return { from: f, to: t, unit: t - f <= 2 * 86400e3 + 3600e3 ? 'hour' : t - f > 92 * 86400e3 ? 'month' : 'day' };
}

const zero = () => [0, 0, 0, 0];
const addTo = (a, b) => { for (let i = 0; i < 4; i++) a[i] += b[i]; return a; };

class TrafficLog {
  constructor(file) {
    this.file = file;
    this.buckets = {};
    this.dirty = false;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && j.v === 1 && j.b) this.buckets = j.b;
    } catch { /* first run, or a damaged file: start empty */ }
  }

  /** Adds byte counts for [engine] to the hour that contains now. */
  add(engine, { netDown = 0, netUp = 0, tunDown = 0, tunUp = 0 }, now = Date.now()) {
    if (!(netDown || netUp || tunDown || tunUp)) return;
    const key = `${unitStart(now, 'hour')}|${engine || 'other'}`;
    addTo(this.buckets[key] || (this.buckets[key] = zero()), [netDown, netUp, tunDown, tunUp].map((n) => Math.max(0, Math.round(n))));
    this.dirty = true;
  }

  /** Writes the file if something changed (temp file + rename, so a crash never leaves half a file). */
  flush(now = Date.now()) {
    if (!this.dirty) return;
    const oldest = now - KEEP_DAYS * 86400e3;
    for (const k of Object.keys(this.buckets)) if (Number(k.split('|')[0]) < oldest) delete this.buckets[k];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, b: this.buckets }));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  reset() { this.buckets = {}; this.dirty = true; this.flush(); }

  /**
   * Rows for [from, to) grouped by unit (empty units included, for a continuous chart),
   * the totals, and the totals per engine. Values are [netDown, netUp, tunDown, tunUp].
   */
  query(from, to, unit) {
    const rows = [];
    const index = new Map();
    for (let s = unitStart(from, unit); s < to; s = nextUnit(s, unit)) { index.set(s, rows.length); rows.push({ start: s, v: zero() }); }
    const total = zero();
    const engines = {};
    // [net, tunnel] summed only over hours where the tunnel was measured too (for a fair overhead)
    const paired = [0, 0];
    for (const [k, v] of Object.entries(this.buckets)) {
      const [ts, engine] = k.split('|');
      const t = Number(ts);
      if (t < from || t >= to) continue;
      const i = index.get(unitStart(t, unit));
      if (i !== undefined) addTo(rows[i].v, v);
      addTo(total, v);
      addTo(engines[engine] || (engines[engine] = zero()), v);
      if (v[2] + v[3] > 0) { paired[0] += v[0] + v[1]; paired[1] += v[2] + v[3]; }
    }
    return { from, to, unit, rows, total, engines, paired };
  }

  /** CSV of the hourly records in [from, to): local time, engine and the four counters in bytes. */
  csv(from, to) {
    const pad = (n) => String(n).padStart(2, '0');
    const lines = ['hour_start_local,engine,net_download_bytes,net_upload_bytes,tunnel_download_bytes,tunnel_upload_bytes'];
    for (const k of Object.keys(this.buckets).sort()) {
      const [ts, engine] = k.split('|');
      const t = Number(ts);
      if (t < from || t >= to) continue;
      const d = new Date(t);
      lines.push([`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`, engine, ...this.buckets[k]].join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }
}

module.exports = { TrafficLog, unitStart, nextUnit, viewRange };
