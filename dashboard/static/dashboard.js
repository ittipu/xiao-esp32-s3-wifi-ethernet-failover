/* IoT Bhai failover dashboard — live client.
 *
 * Socket.IO delivers a snapshot (last 60 min) on connect, then reading / event /
 * speed / broker messages. Everything redraws in place: no page refresh.
 *
 * The timeline is a link-state track plus one chart per measurement. They share
 * one time axis, so a WiFi -> Ethernet switch lines up vertically through every
 * chart, and one hover crosshair reads all of them at once.
 */
"use strict";

/* ================================ config ================================ */
const RANGE_LABEL = { 60000: "1 minute", 300000: "5 minutes", 900000: "15 minutes", 3600000: "1 hour" };
const TICK_STEP = { 60000: 10000, 300000: 60000, 900000: 180000, 3600000: 600000 };
const KEEP_MS = 61 * 60 * 1000;   // readings kept in memory (largest range + margin)
const TILE_MS = 5 * 60 * 1000;    // sensor tiles: range + sparkline window
const STALE_MS = 6000;            // node publishes every 2 s; 6 s silent = offline
const PUB_MS = 2000;
const PAD_L = 56;                 // must match .chart-title / .legends padding-left
const PAD_R = 16;
// Same query as the "fit to screen" block in style.css: tables scroll inside
// their own boxes there, so they get more rows and no Show more buttons.
const FIT = window.matchMedia("(min-width: 1501px) and (min-height: 820px)");

const css = getComputedStyle(document.documentElement);
const tok = (name) => css.getPropertyValue(name).trim();
const COL = {
  wifi: tok("--wifi"), eth: tok("--eth"), off: tok("--off"),
  temp: tok("--temp"), hum: tok("--hum"), lux: tok("--lux"),
  ink: tok("--ink"), ink2: tok("--ink-2"), muted: tok("--muted"),
  line: tok("--line"), surface: tok("--surface"),
};
const FONT = "12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const METRICS = [
  { key: "temp", canvas: "chartTemp", label: "Temperature", unit: "°C",  digits: 1, color: COL.temp, tile: "Temp" },
  { key: "hum",  canvas: "chartHum",  label: "Humidity",    unit: "%",   digits: 1, color: COL.hum,  tile: "Hum" },
  { key: "lux",  canvas: "chartLux",  label: "Light",       unit: "lx",  digits: 0, color: COL.lux,  tile: "Lux" },
  { key: "rssi", canvas: "chartRssi", label: "WiFi signal", unit: "dBm", digits: 0, color: COL.wifi },
];

/* ================================ icons ================================ */
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  chip: svg('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.5v3M15 2.5v3M9 18.5v3M15 18.5v3M2.5 9h3M2.5 15h3M18.5 9h3M18.5 15h3"/>'),
  grid: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
  activity: svg('<path d="M3 12h4l2.5-6 5 12 2.5-6H21"/>'),
  swap: svg('<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>'),
  table: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10"/>'),
  thermo: svg('<path d="M14 14.6V5a2 2 0 0 0-4 0v9.6a4 4 0 1 0 4 0z"/><path d="M12 9v6.5"/>'),
  drop: svg('<path d="M12 3.5s6 6.4 6 10.5a6 6 0 0 1-12 0c0-4.1 6-10.5 6-10.5z"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>'),
  send: svg('<path d="M21 3 10 14"/><path d="M21 3l-7 18-4-7-7-4z"/>'),
  gauge: svg('<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13l3.5-4"/><circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  wifi: svg('<path d="M2.5 8.8a14 14 0 0 1 19 0"/><path d="M5.5 12.2a9.5 9.5 0 0 1 13 0"/><path d="M8.8 15.6a5 5 0 0 1 6.4 0"/><circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none"/>'),
  eth: svg('<path d="M4 5h16v11h-4v3H8v-3H4z"/><path d="M8 9.5v2.5M11 9.5v2.5M13 9.5v2.5M16 9.5v2.5"/>'),
  mqtt: svg('<circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6M5.3 5.3a9.5 9.5 0 0 0 0 13.4M18.7 5.3a9.5 9.5 0 0 1 0 13.4"/>'),
  off: svg('<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r="1.1" fill="currentColor" stroke="none"/>'),
  idle: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  expand: svg('<path d="M14.5 3.5h6v6M9.5 20.5h-6v-6M20.5 3.5l-7 7M3.5 20.5l7-7"/>'),
  shrink: svg('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>'),
  back: svg('<path d="M10 6 4 12l6 6"/><path d="M4 12h16"/>'),
  power: svg('<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
};
document.querySelectorAll("[data-icon]").forEach((el) => { el.innerHTML = ICON[el.dataset.icon] || ""; });

/* ================================ state ================================ */
const $ = (id) => document.getElementById(id);

let readings = [];   // {t, link, temp, hum, lux, count, wifi, eth, rssi, up, ip, fw}  t = server ms
let events = [];     // {t, type, from, to}  oldest -> newest
let skew = 0;        // browser clock minus server clock, ms
let failovers = 0;
let lastSpeed = null;
let hover = null;    // {t, r}
let showAllEvents = false;
let showMoreReadings = false;
let windowMs = loadRange();

function loadRange() {
  try {
    const v = Number(localStorage.getItem("iotbhai.range"));
    if (RANGE_LABEL[v]) return v;
  } catch (_) { /* storage unavailable */ }
  return 300000;
}
function saveRange(v) {
  try { localStorage.setItem("iotbhai.range", String(v)); } catch (_) { /* ignore */ }
}

/* ================================ helpers ================================ */
const serverNow = () => Date.now() - skew;
const latest = () => readings[readings.length - 1];
const isStale = () => !readings.length || serverNow() - latest().t > STALE_MS;
const linkKind = (l) => (l === "WiFi" ? "wifi" : l === "ETH" ? "eth" : "off");
const linkName = (l) => (l === "WiFi" ? "WiFi" : l === "ETH" ? "Ethernet" : "Offline");
const isSwitch = (e) => e.type === "failover" || e.type === "failback";

function fmt(v, digits) {
  if (v == null || Number.isNaN(v)) return "—";
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function clock(t, withSeconds = true) {
  const opts = { hour: "2-digit", minute: "2-digit" };
  if (withSeconds) opts.second = "2-digit";
  return new Date(t + skew).toLocaleTimeString([], opts);
}

function dateTime(t) {
  return new Date(t + skew).toLocaleString([], {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

function signalWord(rssi) {
  if (rssi == null) return "";
  if (rssi >= -60) return "strong";
  if (rssi >= -70) return "good";
  if (rssi >= -80) return "weak";
  return "very weak";
}

function norm(r) {
  const n = (v) => (v == null ? null : Number(v));
  return {
    t: r.ts * 1000, link: r.link,
    temp: n(r.temp), hum: n(r.hum), lux: n(r.lux),
    count: r.count ?? 0, wifi: r.wifi ?? 0, eth: r.eth ?? 0,
    rssi: n(r.rssi), up: n(r.up), ip: r.ip ?? null, fw: r.fw ?? null,
    pref: r.pref || "WiFi",          // the node's main link (older firmware: WiFi)
  };
}

function normEvent(e) {
  return { t: e.ts * 1000, type: e.type, from: e.from_link ?? e.from, to: e.to_link ?? e.to };
}

function trim() {
  const cut = serverNow() - KEEP_MS;
  let i = 0;
  while (i < readings.length - 10 && readings[i].t < cut) i++;
  if (i) readings = readings.slice(i);
  if (events.length > 100) events = events.slice(-100);
}

function setBig(id, text) {
  const el = $(id);
  el.textContent = text;
  el.classList.toggle("none", text === "—");
}

/* ================================ canvas ================================ */
function prep(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = FONT;
  return { ctx, w, h };
}

const xScale = (t0, w) => (t) => PAD_L + ((t - t0) / windowMs) * (w - PAD_L - PAD_R);

function ticks(t0, t1) {
  const step = TICK_STEP[windowMs];
  const out = [];
  for (let t = Math.ceil((t0 + skew) / step) * step - skew; t <= t1; t += step) out.push(t);
  return out;
}

let hatchSrc = null;
function hatch(ctx) {
  if (!hatchSrc) {
    hatchSrc = document.createElement("canvas");
    hatchSrc.width = hatchSrc.height = 8;
    const c = hatchSrc.getContext("2d");
    c.fillStyle = COL.off;
    c.fillRect(0, 0, 8, 8);
    c.strokeStyle = "rgba(0, 0, 0, 0.38)";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(-2, 10); c.lineTo(10, -2);
    c.moveTo(-2, 2);  c.lineTo(2, -2);
    c.moveTo(6, 10);  c.lineTo(10, 6);
    c.stroke();
  }
  return ctx.createPattern(hatchSrc, "repeat");
}

function vline(ctx, x, y0, y1, color, dash = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, y0);
  ctx.lineTo(Math.round(x) + 0.5, y1);
  ctx.stroke();
  ctx.restore();
}

function dot(ctx, x, y, color) {
  ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fillStyle = COL.surface; ctx.fill();       // 2px surface ring
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
}

/* Link state over time: each reading's link lasts until the next reading;
 * a gap longer than STALE_MS becomes an "offline" stretch. */
function linkSegments(t0, t1) {
  const segs = [];
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const end = i + 1 < readings.length ? readings[i + 1].t : t1;
    if (end < t0) continue;
    const kind = linkKind(r.link);
    if (end - r.t <= STALE_MS) {
      segs.push({ a: r.t, b: end, kind });
    } else {
      segs.push({ a: r.t, b: r.t + PUB_MS, kind });
      segs.push({ a: r.t + PUB_MS, b: end, kind: "off" });
    }
  }
  return segs;
}

/* ================================ track ================================ */
function drawTrack(t0, t1) {
  const { ctx, w, h } = prep($("track"));
  const X = xScale(t0, w);
  const top = 20, bh = h - top - 2, right = w - PAD_R;

  ctx.fillStyle = "rgba(255, 255, 255, 0.04)";
  ctx.beginPath(); ctx.roundRect(PAD_L, top, right - PAD_L, bh, 6); ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.roundRect(PAD_L, top, right - PAD_L, bh, 6); ctx.clip();
  for (const s of linkSegments(t0, t1)) {
    const a = Math.max(X(s.a), PAD_L), b = Math.min(X(s.b), right);
    if (b <= a) continue;
    ctx.fillStyle = s.kind === "off" ? hatch(ctx) : COL[s.kind];
    ctx.fillRect(a, top, b - a + 0.5, bh);
  }
  ctx.restore();

  ctx.fillStyle = COL.muted;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  ctx.fillText("Link", PAD_L - 10, top + bh / 2);

  // switch markers + labels (a label that would collide with the previous one is skipped)
  ctx.textBaseline = "alphabetic";
  let lastLabelEnd = -Infinity;
  for (const e of events) {
    if (!isSwitch(e) || e.t < t0 || e.t > t1) continue;
    const x = X(e.t);
    vline(ctx, x, top - 4, h, COL.ink, [3, 3]);
    const label = `→ ${linkName(e.to)}`;
    const tw = ctx.measureText(label).width;
    const lx = Math.min(Math.max(x - tw / 2, PAD_L), right - tw);
    if (lx < lastLabelEnd + 8) continue;
    ctx.fillStyle = COL.ink; ctx.textAlign = "left";
    ctx.fillText(label, lx, 13);
    lastLabelEnd = lx + tw;
  }

  if (hover && hover.t >= t0 && hover.t <= t1) vline(ctx, X(hover.t), top, h, COL.ink2);
}

/* ================================ charts ================================ */
function niceScale(lo, hi) {
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = min; v <= max + step / 2; v += step) out.push(v);
  return { min, max, ticks: out, dec: Math.max(0, -Math.floor(Math.log10(step) + 1e-9)) };
}

function drawChart(m, t0, t1, showX) {
  const { ctx, w, h } = prep($(m.canvas));
  const X = xScale(t0, w);
  const top = 8, bottom = showX ? 26 : 8, right = w - PAD_R;
  const ph = h - top - bottom;

  for (const t of ticks(t0, t1)) vline(ctx, X(t), top, top + ph, COL.line);
  if (showX) {
    ctx.fillStyle = COL.muted; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (const t of ticks(t0, t1)) {
      const x = X(t);
      if (x > PAD_L + 24 && x < right - 24) ctx.fillText(clock(t, windowMs <= 60000), x, h - 6);
    }
  }

  const pts = readings.filter((r) => r.t >= t0 - STALE_MS && r[m.key] != null);
  if (!pts.length) {
    const r = latest();
    let msg = "waiting for data…";
    if (r) msg = m.key === "rssi" && r.wifi === 0 ? "WiFi is down" : `${m.label} not reporting`;
    ctx.fillStyle = COL.muted; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(msg, (PAD_L + right) / 2, top + ph / 2);
    return;
  }

  const vals = pts.map((r) => r[m.key]);
  const sc = niceScale(Math.min(...vals), Math.max(...vals));
  const Y = (v) => top + ph - ((v - sc.min) / (sc.max - sc.min)) * ph;

  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const v of sc.ticks) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = COL.muted;
    ctx.fillText(fmt(v, sc.dec), PAD_L - 10, y);
  }

  for (const e of events) {
    if (isSwitch(e) && e.t >= t0 && e.t <= t1) vline(ctx, X(e.t), top, top + ph, COL.ink, [3, 3]);
  }

  // the line breaks only where data is actually missing
  ctx.save();
  ctx.beginPath(); ctx.rect(PAD_L, 0, right - PAD_L, h); ctx.clip();
  ctx.strokeStyle = m.color; ctx.lineWidth = 2;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  let prev = null;
  for (const r of pts) {
    const x = X(r.t), y = Y(r[m.key]);
    if (prev && r.t - prev.t <= STALE_MS) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    prev = r;
  }
  ctx.stroke();
  ctx.restore();

  const lp = pts[pts.length - 1];
  if (!isStale() && lp === latest()) dot(ctx, X(lp.t), Y(lp[m.key]), m.color);

  if (hover && hover.t >= t0 && hover.t <= t1) {
    vline(ctx, X(hover.t), top, top + ph, COL.ink2);
    if (hover.r && hover.r[m.key] != null) dot(ctx, X(hover.r.t), Y(hover.r[m.key]), m.color);
  }
}

function drawSpark(m, t1) {
  const { ctx, w, h } = prep($("spark" + m.tile));
  const pts = readings.filter((r) => r.t >= t1 - TILE_MS && r[m.key] != null);
  if (pts.length < 2) return;
  const vals = pts.map((r) => r[m.key]);
  const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1;
  const X = (t) => 2 + ((t - (t1 - TILE_MS)) / TILE_MS) * (w - 10);
  const Y = (v) => h - 4 - ((v - lo) / span) * (h - 10);
  ctx.strokeStyle = m.color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  let prev = null;
  for (const r of pts) {
    const x = X(r.t), y = Y(r[m.key]);
    if (prev && r.t - prev.t <= STALE_MS) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    prev = r;
  }
  ctx.stroke();
  const lp = pts[pts.length - 1];
  if (!isStale() && lp === latest()) {
    ctx.beginPath(); ctx.arc(X(lp.t), Y(lp[m.key]), 3, 0, Math.PI * 2);
    ctx.fillStyle = m.color; ctx.fill();
  }
}

/* ================================ panels ================================ */
function linkRunStart() {
  let i = readings.length - 1;
  if (i < 0) return null;
  const link = readings[i].link;
  while (i > 0 && readings[i - 1].link === link && readings[i].t - readings[i - 1].t <= STALE_MS) i--;
  return readings[i].t;
}

function setChip(id, state, text) {
  const el = $(id);
  el.classList.toggle("up", state === "up");
  el.classList.toggle("down", state === "down");
  el.querySelector(".chip-state").textContent = text;
}

function updateConnCard() {
  const r = latest();
  const stale = isStale();
  const kind = !r ? "idle" : stale ? "off" : linkKind(r.link);
  $("connCard").dataset.kind = kind;
  $("connIcon").innerHTML = ICON[kind === "wifi" ? "wifi" : kind === "eth" ? "eth" : kind === "off" ? "off" : "idle"];

  if (!r) {
    $("connName").textContent = "Waiting";
    $("connSub").textContent = "waiting for the node to publish…";
  } else if (stale) {
    $("connName").textContent = "Offline";
    $("connSub").textContent = `no data for ${duration(serverNow() - r.t)}`;
  } else {
    $("connName").textContent = linkName(r.link);
    const since = linkRunStart();
    const role = r.link === r.pref ? "main link" : "backup link";
    const what = `${r.link === "ETH" ? "wired" : "wireless"}, ${role}`;
    $("connSub").textContent = since != null ? `${what} · for ${duration(serverNow() - since)}` : what;
  }

  if (!r || stale) {
    setChip("chipWifi", null, "no data");
    setChip("chipEth", null, "no data");
    setChip("chipMqtt", r ? "down" : null, r ? "silent" : "no data");
  } else {
    setChip("chipWifi", r.wifi ? "up" : "down", r.wifi ? "up" : "down");
    setChip("chipEth", r.eth ? "up" : "down", r.eth ? "up" : "down");
    setChip("chipMqtt", "up", "publishing");
  }
}

function updateNodeCard() {
  const r = latest();
  const stale = isStale();
  const badge = $("nodeBadge");
  badge.className = "badge " + (!r ? "" : stale ? "offline" : "online");
  badge.textContent = !r ? "Waiting" : stale ? "Offline" : "Online";

  if (!r) {
    $("nodeUptime").textContent = "";
  } else if (stale) {
    $("nodeUptime").textContent = `last seen ${duration(serverNow() - r.t)} ago`;
  } else {
    $("nodeUptime").textContent = r.up != null ? `Uptime ${duration(r.up * 1000 + (serverNow() - r.t))}` : "";
  }

  $("nodeFw").textContent = r && r.fw ? `v${r.fw}` : "—";
  $("nodeIp").innerHTML = r && r.ip ? `${r.ip} <small>via ${linkName(r.link)} · main: ${linkName(r.pref)}</small>` : "—";
  if (!r) $("nodeRssi").textContent = "—";
  else if (r.rssi != null) $("nodeRssi").innerHTML = `${fmt(r.rssi, 0)} dBm <small>${signalWord(r.rssi)}</small>`;
  else $("nodeRssi").textContent = r.wifi === 0 ? "WiFi down" : "—";
  $("nodeBoot").textContent = r && r.up != null ? dateTime(r.t - r.up * 1000) : "—";
}

function updateTiles(t1) {
  const r = latest();
  for (const m of METRICS) {
    if (!m.tile) continue;
    setBig("v" + m.tile, r ? fmt(r[m.key], m.digits) : "—");
    const vals = readings.filter((x) => x.t >= t1 - TILE_MS && x[m.key] != null).map((x) => x[m.key]);
    $("r" + m.tile).textContent = vals.length
      ? `5-min range ${fmt(Math.min(...vals), m.digits)} – ${fmt(Math.max(...vals), m.digits)} ${m.unit}`
      : "5-min range —";
    drawSpark(m, t1);
  }

  $("kCount").textContent = r ? Number(r.count).toLocaleString() : "0";
  $("kFailovers").textContent = failovers.toLocaleString();
  const lastFo = [...events].reverse().find((e) => e.type === "failover");
  $("kFailoverSub").textContent = lastFo ? `last at ${clock(lastFo.t)}` : "link switches logged";
  setBig("kSpeed", lastSpeed == null ? "—" : fmt(lastSpeed, 1));

  if (r) {
    setBig("kLast", `${duration(serverNow() - r.t)} ago`);
    $("kLastSub").textContent = `at ${clock(r.t)}`;
  } else {
    setBig("kLast", "—");
    $("kLastSub").textContent = "no data yet";
  }
}

/* ================================ tables ================================ */
const linkTag = (l) => `<span class="link-tag"><i class="sw" style="background:${COL[linkKind(l)]}"></i>${linkName(l)}</span>`;
const EVENT_INFO = {
  failover: { icon: "swap", label: "Failover" },
  failback: { icon: "back", label: "Back to main link" },
  online:   { icon: "check", label: "Online" },
  restart:  { icon: "power", label: "Node restarted" },
};

function renderEvents() {
  const tb = $("eventRows");
  const n = events.length;
  const rows = events.slice().reverse().slice(0, FIT.matches || showAllEvents ? 100 : 6);
  $("moreEvents").hidden = n <= 6;
  $("moreEvents").textContent = showAllEvents ? "Show fewer" : `Show all (${n})`;
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="4" class="empty">No link switches yet.</td></tr>'; return; }
  tb.innerHTML = rows.map((e, i) => {
    const info = EVENT_INFO[e.type] || { icon: "activity", label: e.type };
    const link = isSwitch(e) ? `${linkTag(e.from)}<span class="arrow">→</span>${linkTag(e.to)}` : linkTag(e.to);
    return `<tr>
      <td class="num">${n - i}</td>
      <td><span class="ev"><span>${ICON[info.icon]}</span>${info.label}</span></td>
      <td>${link}</td>
      <td class="num">${clock(e.t)}</td>
    </tr>`;
  }).join("");
}

function renderReadings() {
  const tb = $("readingRows");
  const rows = readings.slice(FIT.matches ? -60 : showMoreReadings ? -30 : -8).reverse();
  $("moreReadings").textContent = showMoreReadings ? "Show fewer" : "Show more";
  if (!rows.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">No readings yet.</td></tr>'; return; }
  tb.innerHTML = rows.map((r) => `<tr>
      <td>${clock(r.t)}</td>
      <td>${linkTag(r.link)}</td>
      <td class="num">${fmt(r.temp, 1)}</td>
      <td class="num">${fmt(r.hum, 1)}</td>
      <td class="num">${fmt(r.lux, 0)}</td>
      <td class="num col-sig">${fmt(r.rssi, 0)}</td>
      <td class="num">${Number(r.count).toLocaleString()}</td>
    </tr>`).join("");
}

$("moreEvents").addEventListener("click", () => { showAllEvents = !showAllEvents; renderEvents(); });
$("moreReadings").addEventListener("click", () => { showMoreReadings = !showMoreReadings; renderReadings(); });
FIT.addEventListener("change", () => { renderEvents(); renderReadings(); draw(); });

/* ================================ render loop ================================ */
let raf = 0;
function draw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const t1 = serverNow(), t0 = t1 - windowMs;
    drawTrack(t0, t1);
    METRICS.forEach((m, i) => drawChart(m, t0, t1, i === METRICS.length - 1));
    updateConnCard();
    updateNodeCard();
    updateTiles(t1);
  });
}

/* ================================ controls ================================ */
function setRange(v) {
  windowMs = v;
  saveRange(v);
  document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("active", Number(b.dataset.range) === v));
  $("rangeText").textContent = `Last ${RANGE_LABEL[v]} · the sensor lines keep going across every switch`;
  hover = null; $("tooltip").hidden = true;
  draw();
}
document.querySelectorAll(".seg button").forEach((b) =>
  b.addEventListener("click", () => setRange(Number(b.dataset.range))));

$("fsBtn").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("timeline").requestFullscreen?.();
});
document.addEventListener("fullscreenchange", () => {
  const on = !!document.fullscreenElement;
  $("fsBtn").innerHTML = ICON[on ? "shrink" : "expand"];
  $("fsBtn").setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
  setTimeout(draw, 50);
});

// sidebar: highlight the section in view
const navLinks = [...document.querySelectorAll(".nav a")];
const spy = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    navLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id));
  }
}, { rootMargin: "-30% 0px -60% 0px" });
["overview", "timeline", "events", "readings"].forEach((id) => spy.observe($(id)));

/* ================================ hover ================================ */
const plots = $("plots");
const tip = $("tooltip");

plots.addEventListener("pointermove", (e) => {
  const rect = $("chartTemp").getBoundingClientRect();
  const x = e.clientX - rect.left, w = rect.width;
  if (x < PAD_L || x > w - PAD_R) { clearHover(); return; }
  const t1 = serverNow(), t0 = t1 - windowMs;
  const msPerPx = windowMs / (w - PAD_L - PAD_R);
  const t = t0 + (x - PAD_L) * msPerPx;
  let best = null, bestD = Infinity;
  for (const r of readings) {
    const d = Math.abs(r.t - t);
    if (d < bestD) { best = r; bestD = d; }
  }
  const r = bestD <= Math.max(4000, msPerPx * 12) ? best : null;
  hover = { t: r ? r.t : t, r };
  showTip(e, r, hover.t);
  draw();
});
plots.addEventListener("pointerleave", clearHover);

function clearHover() {
  hover = null;
  tip.hidden = true;
  draw();
}

function showTip(e, r, t) {
  const row = (color, label, value) =>
    `<div class="t-row"><i class="sw" style="background:${color}"></i>${label}<b>${value}</b></div>`;
  tip.innerHTML = `<div class="t-time">${clock(t)}</div>` + (r
    ? row(COL[linkKind(r.link)], "Link", linkName(r.link)) +
      METRICS.map((m) => row(m.color, m.label, `${fmt(r[m.key], m.digits)} ${m.unit}`)).join("") +
      row(COL.muted, "Publish #", Number(r.count).toLocaleString())
    : '<div class="t-row">no reading here</div>');
  tip.hidden = false;

  const pr = plots.getBoundingClientRect();
  let left = e.clientX - pr.left + 16;
  let top = e.clientY - pr.top + 16;
  if (left + tip.offsetWidth > pr.width) left = e.clientX - pr.left - tip.offsetWidth - 16;
  if (top + tip.offsetHeight > pr.height) top = pr.height - tip.offsetHeight;
  tip.style.left = `${Math.max(0, left)}px`;
  tip.style.top = `${Math.max(0, top)}px`;
}

/* ================================ socket ================================ */
function setPill(id, text, ok) {
  const p = $(id);
  p.textContent = text;
  p.className = "pill " + (ok ? "ok" : "bad");
}

const socket = io();

socket.on("connect", () => {
  setPill("pillBackend", "dashboard: live", true);
  $("liveDot").classList.add("on");
});

socket.on("disconnect", () => {
  setPill("pillBackend", "dashboard: reconnecting…", false);
  $("liveDot").classList.remove("on");
});

socket.on("snapshot", (d) => {
  if (d.server_ts) skew = Date.now() - d.server_ts * 1000;
  readings = (d.readings || []).map(norm);
  events = (d.events || []).map(normEvent).reverse();
  failovers = (d.stats && d.stats.failovers) || 0;
  lastSpeed = d.stats ? d.stats.last_speed_mbps : null;
  setPill("pillBroker", "broker: " + (d.broker_connected ? "connected" : "offline"), !!d.broker_connected);
  trim();
  renderEvents();
  renderReadings();
  draw();
});

socket.on("reading", (d) => {
  skew = Date.now() - d.ts * 1000;
  readings.push(norm(d));
  trim();
  renderReadings();
  draw();
});

socket.on("event", (e) => {
  events.push(normEvent(e));
  if (e.type === "failover") failovers++;
  trim();
  renderEvents();
  draw();
});

socket.on("speed", (d) => {
  if (d.mbps != null) lastSpeed = Number(d.mbps);
  draw();
});

socket.on("broker", (d) => setPill("pillBroker", "broker: " + (d.connected ? "connected" : "offline"), d.connected));

setRange(windowMs);
setInterval(draw, 1000);            // keep the timeline scrolling and the clocks ticking
window.addEventListener("resize", draw);
