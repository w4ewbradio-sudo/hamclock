// HamClock v3 data-tile row: a registry of fixed-size canvas mini-chart tiles
// { id, title, draw(ctx, w, h, td) }. Pure helpers (chartPoints/logY/
// bandCounts/compass) carry the unit tests; the draws are canvas-only and are
// individually guarded by drawTile() so one broken tile never blanks the row.
// Per-tile attributions are drawn into the tile footer (design requirement).
// td: { spacewx, weather, station, now, sunImg, moonTex, psk } -- see hamclock.js.
import { activeBeacons } from "./beacons.js";
import { moonPhase, moonPosition, moonLookAngles } from "./astro-moon.js";
import { drawMoon, sunEquatorial, brightLimbAngle } from "./hc-moon.js";

export const TILE_W = 240, TILE_H = 140;
// Tile palette follows the page theme: read the CSS custom properties from :root
// so html[data-theme] swaps recolor the canvases too. refreshTileTheme() is called
// by hamclock.js on startup and whenever the theme changes; the literals are the
// phosphor defaults and the no-DOM fallback (node:test imports this module).
const C = { bg: "#0a0e18", grid: "#1c2740", green: "#7dd87d", amber: "#e8a33d", red: "#ff5f5f", dim: "#6b7a99",
  good: "#7dd87d", ops: false, ui: "ui-monospace, monospace" };
export function refreshTileTheme() {
  if (typeof document === "undefined") return;
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => (css.getPropertyValue(name) || "").trim() || fallback;
  C.bg = v("--hc-surface", C.bg);
  C.grid = v("--hc-line", C.grid);
  C.green = v("--hc-fg", C.green);
  C.amber = v("--hc-accent", C.amber);
  C.red = v("--hc-red", C.red);
  C.dim = v("--hc-muted", C.dim);
  // The ops theme draws LCARS tile chrome: rounded frame, orange rule, a
  // condensed title. Canvas can only use Antonio once the CSS @font-face has
  // actually loaded, so callers repaint on document.fonts.ready.
  C.ops = document.documentElement.dataset.theme === "ops";
  C.ui = C.ops ? '"Antonio","Arial Narrow",Arial,sans-serif' : "ui-monospace, monospace";
  // "Good" band conditions stay green on the ops console (its primary value
  // color is LCARS gold, which would make Good and Fair read alike).
  C.good = C.ops ? "#7de6a0" : C.green;
}

// ---- ops console: weighted single-row card strip ----
// Relative widths of the cards on the ops console (1 = a standard card). The
// clock and the radio card carry more content, so they take more of the row.
export const OPS_TILE_WEIGHTS = {
  clock: 1.55, sun: 1, ssn: 0.9, flux: 0.9, kp: 0.9, xray: 0.9, bands: 1.35, wx: 1.1,
  beacons: 1, moon: 1, spots: 1, sstv: 1.2, rig: 1.95,
};
// Lay `items` ({id, weight}) into rows across `avail` px with `gap` between
// cards. One row whenever a weight-1 card would still be at least `minUnit`
// wide; otherwise the strip wraps into as few rows as needed, split by
// cumulative weight. Every row's widths + gaps sum to `avail` exactly.
export function opsRowLayout(items, avail, gap, minUnit) {
  const list = (items || []).filter((t) => t && t.id);
  if (!list.length) return [];
  const total = list.reduce((s, t) => s + (t.weight > 0 ? t.weight : 1), 0);
  const need = total * minUnit + (list.length - 1) * gap;
  const nRows = Math.max(1, Math.min(list.length, Math.ceil(need / Math.max(1, avail))));
  const rows = [];
  if (nRows === 1) rows.push(list.slice());
  else {
    const target = total / nRows;
    let cur = [], acc = 0;
    for (const t of list) {
      cur.push(t); acc += t.weight > 0 ? t.weight : 1;
      if (acc >= target - 1e-9 && rows.length < nRows - 1) { rows.push(cur); cur = []; acc = 0; }
    }
    if (cur.length) rows.push(cur);
  }
  return rows.map((row) => {
    const wsum = row.reduce((s, t) => s + (t.weight > 0 ? t.weight : 1), 0);
    const unit = (avail - (row.length - 1) * gap) / wsum;
    let used = 0;
    return row.map((t, i) => {
      const w = i === row.length - 1
        ? avail - (row.length - 1) * gap - used
        : Math.floor((t.weight > 0 ? t.weight : 1) * unit);
      used += w;
      return { id: t.id, w };
    });
  });
}

// One-word verdict for the map's CONDITIONS readout: the hamqsl band table
// when we have it (Good=2 / Fair=1 / Poor=0 averaged over day+night), else
// the planetary Kp, else a dash.
export function conditionsWord(bands, kp) {
  const vals = [];
  for (const b of Object.values(bands || {})) {
    for (const c of [b?.day, b?.night]) {
      if (/good/i.test(c)) vals.push(2); else if (/fair/i.test(c)) vals.push(1); else if (/poor/i.test(c)) vals.push(0);
    }
  }
  if (vals.length) {
    const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
    return avg >= 1.4 ? "GOOD" : avg >= 0.7 ? "FAIR" : "POOR";
  }
  if (Number.isFinite(kp)) return kp < 4 ? "GOOD" : kp < 5 ? "FAIR" : "POOR";
  return DASH;
}

// Band-edge dial for the radio card: which band a frequency (Hz) sits in and
// how far across it (0..1). null off-band.
export function bandScale(hz) {
  const khz = Number(hz) / 1000;
  if (!Number.isFinite(khz)) return null;
  for (const [lo, hi, b] of BAND_EDGES) if (khz >= lo && khz <= hi) return { band: b, loKhz: lo, hiKhz: hi, frac: (khz - lo) / (hi - lo) };
  return null;
}
export function fmtMhz(khz) { return Number.isFinite(Number(khz)) && khz != null ? (Number(khz) / 1000).toFixed(3) : DASH; }
const MONO = "ui-monospace, monospace";
const DASH = "—";

// ---- pure helpers (unit-tested) ----

// Map a numeric series into a w x h box with 2px padding. min/max override autoscale.
export function chartPoints(values, w, h, { min = null, max = null } = {}) {
  const v = (values || []).filter(Number.isFinite);
  if (!v.length) return [];
  let lo = min == null ? Math.min(...v) : min;
  let hi = max == null ? Math.max(...v) : max;
  if (hi === lo) { hi += 1; lo -= 1; }               // flat series: avoid divide-by-zero
  const n = v.length;
  return v.map((val, i) => ({
    x: n === 1 ? w / 2 : (i / (n - 1)) * (w - 4) + 2,
    y: h - 2 - ((val - lo) / (hi - lo)) * (h - 4),
  }));
}

// Log-scale y for X-ray flux: decades minExp..maxExp onto h px (maxExp at y=0).
export function logY(value, minExp, maxExp, h) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const e = Math.min(maxExp, Math.max(minExp, Math.log10(value)));
  return h - ((e - minExp) / (maxExp - minExp)) * h;
}

// Band edges in kHz -- mirrors src/dx.js BANDS (server module; kept in sync by hand
// because /ui only serves the allowlisted client files).
const BAND_EDGES = [
  [1800, 2000, "160m"], [3500, 4000, "80m"], [5250, 5450, "60m"], [7000, 7300, "40m"],
  [10100, 10150, "30m"], [14000, 14350, "20m"], [18068, 18168, "17m"], [21000, 21450, "15m"],
  [24890, 24990, "12m"], [28000, 29700, "10m"], [50000, 54000, "6m"], [144000, 148000, "2m"],
];
export function bandOfKhz(khz) { for (const [lo, hi, b] of BAND_EDGES) if (khz >= lo && khz <= hi) return b; return ""; }

// Tally PSK reception reports per band; returns only bands with hits, 160m..2m order.
export function bandCounts(reports) {
  const tally = {};
  for (const r of reports || []) {
    const b = bandOfKhz(Number(r?.freqHz) / 1000);
    if (b) tally[b] = (tally[b] || 0) + 1;
  }
  return BAND_EDGES.map(([, , b]) => ({ band: b, n: tally[b] || 0 })).filter((x) => x.n > 0);
}

const DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export function compass(deg) {
  if (!Number.isFinite(deg)) return "";
  return DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// ---- canvas chart primitives (browser only) ----

export function sparkline(ctx, x, y, w, h, values, color) {
  const pts = chartPoints(values, w, h);
  if (pts.length < 2) return;
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke(); ctx.restore();
}

export function barchart(ctx, x, y, w, h, values, colorFor, { max = null } = {}) {
  const v = (values || []).filter(Number.isFinite);
  if (!v.length) return;
  const hi = max == null ? Math.max(...v, 1) : Math.max(max, ...v);
  const step = (w - 4) / v.length;
  const bw = Math.max(1, step - 1);
  ctx.save(); ctx.translate(x, y);
  v.forEach((val, i) => {
    const bh = Math.max(1, (val / hi) * (h - 2));
    ctx.fillStyle = colorFor(val);
    ctx.fillRect(2 + i * step, h - bh, bw, bh);
  });
  ctx.restore();
}

export function logline(ctx, x, y, w, h, values, minExp, maxExp, color) {
  const v = values || [];
  if (!v.length) return;
  ctx.save(); ctx.translate(x, y);
  ctx.strokeStyle = "rgba(107,122,153,0.25)"; ctx.lineWidth = 0.5;
  for (let e = minExp; e <= maxExp; e++) {          // decade gridlines
    const gy = logY(Math.pow(10, e), minExp, maxExp, h);
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
  }
  ctx.strokeStyle = color; ctx.lineWidth = 1.2; ctx.beginPath();
  let started = false;
  v.forEach((val, i) => {
    const yy = logY(val, minExp, maxExp, h);
    if (yy == null) return;
    const xx = v.length === 1 ? w / 2 : (i / (v.length - 1)) * w;
    started ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy);
    started = true;
  });
  ctx.stroke(); ctx.restore();
}

// ---- tile chrome ----

// Layout positions use s = k(h) so content spreads to fill a tall band. Text
// AUTO-SIZES: fitFont() picks the largest MONO size at which `text` fits `maxW`,
// capped at idealPx - and idealPx scales with the tile so a big tile gets big,
// HamClock-style numbers instead of tiny fixed text floating in empty space.
const k = (h) => h / TILE_H;
function fitFont(ctx, text, maxW, idealPx, bold = false, face = MONO) {
  const wt = bold ? "bold " : "";
  let size = Math.max(7, Math.round(idealPx));
  ctx.font = `${wt}${size}px ${face}`;
  const tw = ctx.measureText(String(text)).width;
  if (tw > maxW && tw > 0) size = Math.max(7, Math.floor(size * (maxW / tw)));
  ctx.font = `${wt}${size}px ${face}`;
  return size;
}

// Rounded-rect path with a per-corner radius array where the browser has
// roundRect (every kiosk/web target does); a plain rect otherwise.
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

// Tile bg/border + an eyebrow title with (optionally) a big value stacked below.
// Returns the y where the tile's own content can start (below the header).
// opts.sub: a caption under the title (ops); opts.pill: {text, fill} status
// cap at the top-right of the header row (ops), e.g. the radio card's RX/TX.
function frame(ctx, w, h, title, value, attr, valueColor = C.green, opts = {}) {
  const s = k(h), pad = 9 * s;
  const label = String(title).toUpperCase();
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
  let top;
  if (C.ops) {
    // LCARS panel: rounded orange frame with the title in a tab that hangs
    // from the top border (its top edge IS the border), the way a console
    // frame labels itself. Values are gold, captions lilac.
    const lw = Math.max(1.5, 2 * s);
    const r = Math.min(14 * s, w / 2, h / 2);
    ctx.strokeStyle = C.amber; ctx.lineWidth = lw;
    rr(ctx, lw / 2, lw / 2, w - lw, h - lw, r); ctx.stroke();
    const tabX = r + lw;
    // the label must fit INSIDE the tab, and the tab inside the frame corners
    const tSize = fitFont(ctx, label, Math.min(w * 0.7, w - 2 * tabX - 18 * s), 12.5 * s, true, C.ui);
    const tw = ctx.measureText(label).width;
    const tabH = Math.round(tSize + 9 * s), tabW = Math.min(w - 2 * tabX, tw + 18 * s), tabR = Math.min(9 * s, tabH / 2);
    ctx.fillStyle = C.bg;
    rr(ctx, tabX, 0, tabW, tabH + lw / 2, [0, 0, tabR, tabR]); ctx.fill();       // cut the border under the tab
    ctx.strokeStyle = C.amber; ctx.lineWidth = lw;
    rr(ctx, tabX, lw / 2, tabW, tabH, [0, 0, tabR, tabR]); ctx.stroke();
    ctx.fillStyle = C.amber; ctx.textAlign = "left";
    ctx.fillText(label, tabX + 9 * s, lw / 2 + tabH / 2 + tSize * 0.36);
    if (opts.pill && opts.pill.text) {
      const pt = String(opts.pill.text).toUpperCase();
      const pSize = fitFont(ctx, pt, w * 0.3, 10.5 * s, true, C.ui);
      const pw = ctx.measureText(pt).width + 14 * s, ph = Math.max(10 * s, tabH - 10 * s);
      const px = w - r - lw - pw, py = lw / 2 + 5 * s;
      ctx.fillStyle = opts.pill.fill || C.amber;
      rr(ctx, px, py, pw, ph, ph / 2); ctx.fill();
      ctx.fillStyle = "#000"; ctx.textAlign = "center";
      ctx.fillText(pt, px + pw / 2, py + ph / 2 + pSize * 0.36);
      ctx.textAlign = "left";
    }
    top = tabH + lw + 5 * s;
    if (opts.sub) {
      const sub = String(opts.sub).toUpperCase();
      const subSize = fitFont(ctx, sub, w - 2 * pad, 11 * s, false, C.ui);
      ctx.fillStyle = C.dim; ctx.fillText(sub, pad, top + subSize);
      top += subSize + 4 * s;
    }
  } else {
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.textAlign = "left";
    const tSize = fitFont(ctx, label, w - 2 * pad, 13 * s, false, C.ui);
    ctx.fillStyle = C.dim;
    ctx.fillText(label, pad, pad + tSize);
    top = pad + tSize + 5 * s;
  }
  if (value != null) {
    const vSize = fitFont(ctx, String(value), w - 2 * pad, Math.min(36 * s, 0.42 * w), true);
    ctx.fillStyle = valueColor; ctx.textAlign = "right";
    ctx.fillText(String(value), w - pad, top + vSize);
    ctx.textAlign = "left";
    top += vSize + 6 * s;
  }
  if (attr) { fitFont(ctx, attr, w - 2 * pad, 8.5 * s, false, C.ops ? C.ui : MONO); ctx.fillStyle = C.dim; ctx.fillText(attr, pad, h - 5 * s); }
  return top;
}
function chartBox(w, h, top) {
  const s = k(h), y = top != null ? top : 26 * s;
  return { x: 9 * s, y, w: w - 18 * s, h: Math.max(10, h - y - 14 * s) };
}

// ---- the tiles ----

// hamqsl band-condition word -> color.
function condColor(c) {
  return /good/i.test(c) ? C.good : /fair/i.test(c) ? C.amber : /poor/i.test(c) ? C.red : C.dim;
}

const TILES = [
  // Date/time card: the ops console moves the clock off the header and into
  // the card strip (the mockup's DATE / TIME panel). Also fine on phosphor,
  // where it is simply hidden by default. td.local / td.qth come from
  // hamclock.js (station-zone local time; city on the kiosk, grid on the web).
  { id: "clock", title: "DATE / TIME", draw(ctx, w, h, td) {
    const s = k(h), pad = 10 * s, now = td.now || new Date();
    const mjd = "MJD " + (now.getTime() / 86400000 + 40587).toFixed(4);
    const top = frame(ctx, w, h, "Date / Time (UTC)", null, "");
    const date = now.toUTCString().slice(0, 16).toUpperCase();          // TUE, 08 SEP 2026
    const utc = now.toISOString().slice(11, 19);
    const local = td.local || "--:--:--", qth = String(td.qth || "").toUpperCase();
    const inner = w - 2 * pad, avail = Math.max(20, h - 8 * s - top);
    // date line: the date at the left, MJD (small, lilac) at the right
    ctx.textAlign = "left";
    const dSize = fitFont(ctx, date, inner * 0.6, Math.min(13 * s, avail * 0.14), false, C.ui);
    let y = top + dSize; ctx.fillStyle = C.green; ctx.fillText(date, pad, y);
    if (fitFont(ctx, mjd, inner * 0.36, Math.min(9.5 * s, dSize * 0.8), false, C.ui) >= 7) {
      ctx.textAlign = "right"; ctx.fillStyle = C.dim; ctx.fillText(mjd, w - pad, y); ctx.textAlign = "left";
    }
    const uSize = fitFont(ctx, utc, inner, Math.min(40 * s, avail * 0.42), true);
    y += uSize + 3 * s; ctx.fillStyle = C.green; ctx.fillText(utc, pad, y);
    const lSize = fitFont(ctx, "LOCAL:  " + local, inner, Math.min(14 * s, avail * 0.16), true);
    y += lSize + 6 * s;
    ctx.font = `${lSize}px ${C.ui}`; ctx.fillStyle = C.amber; ctx.fillText("LOCAL:", pad, y);
    const lx = pad + ctx.measureText("LOCAL:").width + 6 * s;
    ctx.font = `bold ${lSize}px ${MONO}`; ctx.fillStyle = C.green; ctx.fillText(local, lx, y);
    if (qth) {
      const qSize = fitFont(ctx, qth, inner, Math.min(15 * s, avail * 0.16), true, C.ui);
      y += qSize + 5 * s; ctx.fillStyle = C.green; ctx.fillText(qth, pad, y);
    }
  } },
  { id: "ssn", title: "SSN", draw(ctx, w, h, td) {
    const d = td.spacewx?.ssn || [];
    const top = frame(ctx, w, h, "SSN", d.length ? String(d[d.length - 1].ssn) : DASH, td.ssnAttr || "SILSO / Royal Obs. Belgium");
    const b = chartBox(w, h, top);
    sparkline(ctx, b.x, b.y, b.w, b.h, d.map((p) => p.ssn), C.amber);
  } },
  { id: "flux", title: "SFI", draw(ctx, w, h, td) {
    const d = td.spacewx?.flux || [];
    const top = frame(ctx, w, h, "SFI 10.7cm", d.length ? String(Math.round(d[d.length - 1].flux)) : DASH, "NOAA SWPC");
    const b = chartBox(w, h, top);
    sparkline(ctx, b.x, b.y, b.w, b.h, d.map((p) => p.flux), C.amber);
  } },
  { id: "kp", title: "KP", draw(ctx, w, h, td) {
    const d = td.spacewx?.kp || [];
    const last = d.length ? d[d.length - 1].kp : null;
    const top = frame(ctx, w, h, "PLANETARY KP", last != null ? last.toFixed(1) : DASH, "NOAA SWPC",
      last != null && last >= 5 ? C.red : C.green);
    const b = chartBox(w, h, top);
    barchart(ctx, b.x, b.y, b.w, b.h, d.map((p) => p.kp), (v) => (v >= 5 ? C.red : C.green), { max: 9 });
  } },
  { id: "xray", title: "X-RAY", draw(ctx, w, h, td) {
    const x = td.spacewx?.xray || { series: [], class: null };
    const top = frame(ctx, w, h, "GOES X-RAY", x.class || DASH, "NOAA SWPC");
    const b = chartBox(w, h, top);
    logline(ctx, b.x, b.y, b.w, b.h, (x.series || []).map((p) => p.long), -9, -2, C.amber);
  } },
  { id: "bands", title: "BANDS", draw(ctx, w, h, td) {
    const s = k(h), pad = 9 * s;
    const top = frame(ctx, w, h, C.ops ? "Band Conditions" : "BAND COND", null, "hamqsl");
    // Standalone build: hamqsl's XML has no CORS, so the tile shows their
    // embeddable band-conditions image instead of the parsed text table.
    if (td.bandsImg && td.bandsImg.width) {
      const img = td.bandsImg, bx = pad, by = top, bw = w - 2 * pad, bh = h - by - 14 * s;
      const scale = Math.min(bw / img.width, bh / img.height);
      const iw = img.width * scale, ih = img.height * scale;
      ctx.drawImage(img, bx + (bw - iw) / 2, by + (bh - ih) / 2, iw, ih);
      return;
    }
    const names = Object.keys(td.bands || {}).slice(0, 5);
    // 3 columns: name (left, <=28% w) | DAY (right-aligned at 66% w) | NGT (right,
    // at the edge). Caps keep them from ever colliding even at big fonts.
    const colDay = w * 0.66, colNgt = w - pad;
    const ngt = C.ops ? "NIGHT" : "NGT";
    const hSize = fitFont(ctx, ngt, w * 0.2, 11 * s, false, C.ui);
    ctx.fillStyle = C.ops ? C.green : C.dim; ctx.textAlign = "right";
    ctx.fillText("DAY", colDay, top + hSize); ctx.fillText(ngt, colNgt, top + hSize);
    if (C.ops) { ctx.textAlign = "left"; ctx.fillText("BAND", pad, top + hSize); }
    ctx.textAlign = "left";
    const y0 = top + hSize + 3 * s, step = (h - 12 * s - y0) / Math.max(1, names.length);
    const cell = Math.min(step * 0.8, 18 * s);
    names.forEach((name, i) => {
      const y = y0 + step * (i + 0.72), bd = (td.bands || {})[name] || {};
      const dv = (bd.day || "-").slice(0, 4), nv = (bd.night || "-").slice(0, 4);
      ctx.textAlign = "left"; ctx.fillStyle = C.ops ? C.amber : C.dim;
      fitFont(ctx, name, w * 0.28, cell, true, C.ops ? C.ui : MONO); ctx.fillText(name, pad, y);
      ctx.textAlign = "right";
      fitFont(ctx, dv, w * 0.18, cell, true); ctx.fillStyle = condColor(bd.day); ctx.fillText(dv, colDay, y);
      fitFont(ctx, nv, w * 0.18, cell, true); ctx.fillStyle = condColor(bd.night); ctx.fillText(nv, colNgt, y);
    });
    ctx.textAlign = "left";
  } },
  { id: "sun", title: "SUN", draw(ctx, w, h, td) {
    const s = k(h);
    const top = C.ops
      ? frame(ctx, w, h, "Solar Activity", null, td.sunAttr || "NASA/SDO", C.green, { sub: td.sunLabel || "SUN — HMI" })
      : frame(ctx, w, h, td.sunLabel || "SUN HMI", null, td.sunAttr || "NASA/SDO");
    const b = chartBox(w, h, top);
    const r = Math.min(b.w, b.h) / 2;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    if (td.sunImg) {
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.clip();
      ctx.drawImage(td.sunImg, cx - r, cy - r, 2 * r, 2 * r);
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.strokeStyle = C.dim; ctx.lineWidth = 1; ctx.stroke();
      fitFont(ctx, "no image yet", 2 * r, 11 * s); ctx.fillStyle = C.dim;
      ctx.textAlign = "center"; ctx.fillText("no image yet", cx, cy); ctx.textAlign = "left";
    }
  } },
  { id: "wx", title: "WX", draw(ctx, w, h, td) {
    const s = k(h), pad = 9 * s, wx = td.weather;
    const top = frame(ctx, w, h, C.ops ? "Weather (WX)" : "WX DE", wx ? `${Math.round(wx.tempF)}°F` : DASH, "open-meteo.com", C.ops ? C.green : C.amber);
    if (!wx) return;
    const lines = [wx.text || "-"];
    if (wx.humidity != null) lines.push(`${wx.humidity}% RH`);
    if (wx.windMph != null) lines.push(`${compass(wx.windDir)} ${Math.round(wx.windMph)} mph`);
    const step = (h - 12 * s - top) / lines.length, size = Math.min(step * 0.66, 16 * s);
    ctx.textAlign = "left";
    lines.forEach((ln, i) => {
      fitFont(ctx, ln, w - 2 * pad, size); ctx.fillStyle = i === 0 ? C.green : C.dim;
      ctx.fillText(ln, pad, top + step * (i + 0.68));
    });
  } },
  { id: "beacons", title: "BEACONS", draw(ctx, w, h, td) {
    const s = k(h), pad = 9 * s;
    const top = frame(ctx, w, h, "NCDXF NOW", null, "NCDXF/IARU");
    const act = activeBeacons(td.now || new Date());
    const step = (h - 12 * s - top) / Math.max(1, act.length), size = Math.min(step * 0.7, 16 * s);
    act.forEach((bc, i) => {
      const y = top + step * (i + 0.7);
      fitFont(ctx, bc.label, w * 0.4, size); ctx.fillStyle = C.dim; ctx.textAlign = "left"; ctx.fillText(bc.label, pad, y);
      fitFont(ctx, bc.call, w * 0.52, size, true); ctx.fillStyle = C.green; ctx.textAlign = "right"; ctx.fillText(bc.call, w - pad, y);
    });
    ctx.textAlign = "left";
  } },
  { id: "moon", title: "MOON", draw(ctx, w, h, td) {
    const s = k(h), now = td.now || new Date();
    const ph = moonPhase(now), pct = Math.round(ph.fraction * 100);
    const top = frame(ctx, w, h, `MOON ${pct}%`, null, "");
    const st = td.station || {};
    const la = moonLookAngles(Number(st.lat) || 0, Number(st.lon) || 0, now);
    const footH = 22 * s, areaBot = h - footH;
    const r = Math.max(6, Math.min(w - 14 * s, areaBot - top) / 2 - 1);
    const cx = w / 2, cy = (top + areaBot) / 2;
    const angleDeg = brightLimbAngle(sunEquatorial(now), moonPosition(now));
    drawMoon(ctx, cx, cy, r, { fraction: ph.fraction, angleDeg }, td.moonTex);
    const azel = C.ops ? `AZ ${la.az.toFixed(0)}°  EL ${la.el.toFixed(0)}°` : `az ${la.az.toFixed(0)}  el ${la.el.toFixed(0)}`;
    fitFont(ctx, C.ops ? "AZ 000°  EL -00°" : "az 000  el 00", w - 12 * s, 13 * s, true, C.ops ? C.ui : MONO); ctx.fillStyle = C.green; ctx.textAlign = "center";
    ctx.fillText(azel, cx, h - 6 * s); ctx.textAlign = "left";
  } },
  { id: "spots", title: "SPOTS", draw(ctx, w, h, td) {
    const s = k(h), pad = 9 * s, counts = bandCounts(td.psk);
    const total = counts.reduce((a, c) => a + c.n, 0);
    const top = frame(ctx, w, h, "LIVE SPOTS", total || DASH, "PSKReporter.info");
    const topN = counts.slice().sort((a, b) => b.n - a.n).slice(0, 5);
    if (!topN.length) return;
    const max = Math.max(...topN.map((c) => c.n));
    const step = (h - 12 * s - top) / topN.length, size = Math.min(step * 0.62, 15 * s);
    const barX = pad + w * 0.28, barMax = w * 0.44;
    topN.forEach((c2, i) => {
      const y = top + step * (i + 0.5);
      fitFont(ctx, c2.band, w * 0.24, size); ctx.fillStyle = C.dim; ctx.textAlign = "left"; ctx.fillText(c2.band, pad, y + size * 0.35);
      ctx.fillStyle = C.amber; ctx.fillRect(barX, y - size * 0.42, Math.max(2, (c2.n / max) * barMax), size * 0.72);
      fitFont(ctx, String(c2.n), w * 0.18, size, true); ctx.fillStyle = C.green; ctx.textAlign = "right"; ctx.fillText(String(c2.n), w - pad, y + size * 0.35);
    });
    ctx.textAlign = "left";
  } },
  { id: "sstv", title: "SSTV", draw(ctx, w, h, td) {
    const s = k(h), img = td.sstvImg;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    if (img && img.width) {
      ctx.save();
      ctx.beginPath(); ctx.rect(1, 1, w - 2, h - 2); ctx.clip();
      const scale = Math.max(w / img.width, h / img.height);   // cover the whole tile, crop overflow
      const iw = img.width * scale, ih = img.height * scale;
      ctx.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
      ctx.restore();
      const th = 22 * s;                                        // title over a scrim so it stays legible
      const g = ctx.createLinearGradient(0, 0, 0, th);
      g.addColorStop(0, "rgba(5,7,13,0.8)"); g.addColorStop(1, "rgba(5,7,13,0)");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, th);
      ctx.font = `bold ${Math.round(11 * s)}px ${MONO}`; ctx.fillStyle = C.green; ctx.textAlign = "left";
      ctx.fillText("SSTV RX", 8 * s, 15 * s);
    } else {
      frame(ctx, w, h, "SSTV RX", null, "w4ewb · github");
      fitFont(ctx, "waiting for RX", w * 0.8, 11 * s); ctx.fillStyle = C.dim;
      ctx.textAlign = "center"; ctx.fillText("waiting for RX", w / 2, h / 2); ctx.textAlign = "left";
    }
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  } },
  { id: "rig", title: "RIG", draw(ctx, w, h, td) {
    if (C.ops) return drawRigOps(ctx, w, h, td);
    const r = td.rig || {}, s = k(h), pad = 8 * s, tx = r.ptt === true;
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    // eyebrow title + TX/RX chip
    ctx.textAlign = "left";
    const tSize = fitFont(ctx, "RIG", w * 0.5, 12 * s);
    ctx.fillStyle = C.dim; ctx.fillText("RIG", pad, pad + tSize);
    if (r.online) {
      ctx.textAlign = "right"; fitFont(ctx, "RX", w * 0.3, 11 * s, true);
      ctx.fillStyle = tx ? C.red : C.green; ctx.fillText(tx ? "TX" : "RX", w - pad, pad + tSize);
      ctx.textAlign = "left";
    }
    let y = pad + tSize + 4 * s;
    if (r.online && r.hz) {
      const mhz = (r.hz / 1e6).toFixed(3);
      const fSize = fitFont(ctx, mhz, w - 2 * pad, 25 * s, true);
      ctx.fillStyle = tx ? C.red : C.green; ctx.fillText(mhz, pad, y + fSize);
      y += fSize + 3 * s;
      const mb = `${r.mode || ""}${r.band ? " · " + r.band : ""}`.trim() || "—";
      const mSize = fitFont(ctx, mb, w - 2 * pad, 10.5 * s);
      ctx.fillStyle = C.dim; ctx.fillText(mb, pad, y + mSize);
      y += mSize + 5 * s;
      // S-meter: STRENGTH is dB rel S9 (S0=-54 .. S9=0 .. +60). Bar + label.
      const db = r.meters ? r.meters.s : null;
      const barH = 5 * s, barW = w - 2 * pad - 22 * s;
      ctx.fillStyle = C.grid; ctx.fillRect(pad, y, barW, barH);
      if (db != null) {
        const frac = Math.max(0, Math.min(1, (db + 54) / 114));
        ctx.fillStyle = db > 0 ? C.red : C.green; ctx.fillRect(pad, y, barW * frac, barH);
        const units = Math.max(0, Math.min(9, Math.round((db + 54) / 6)));
        fitFont(ctx, "S", 20 * s, 9 * s); ctx.fillStyle = C.dim; ctx.textAlign = "right";
        ctx.fillText(db > 0 ? `S9+${Math.round(db)}` : `S${units}`, w - pad, y + barH);
        ctx.textAlign = "left";
      }
      y += barH + 4 * s;
    } else {
      const dSize = fitFont(ctx, "rig offline", w - 2 * pad, 13 * s);
      ctx.fillStyle = C.dim; ctx.fillText("rig offline", pad, y + dSize + 4 * s);
      y += dSize + 10 * s;
    }
    // waterfall fills the rest
    const wf = td.rigWf, wfTop = Math.round(y);
    if (wf && wf.width && wfTop < h - 6 * s) {
      ctx.save(); ctx.beginPath(); ctx.rect(1, wfTop, w - 2, h - wfTop - 1); ctx.clip();
      ctx.drawImage(wf, 1, wfTop, w - 2, h - wfTop - 1);
      ctx.restore();
    } else if (r.online && wfTop < h - 6 * s) {
      fitFont(ctx, "spectrum…", w * 0.8, 10 * s); ctx.fillStyle = C.dim;
      ctx.textAlign = "center"; ctx.fillText("spectrum…", w / 2, (wfTop + h) / 2); ctx.textAlign = "left";
    }
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  } },
];

// The ops console's RADIO card (the mockup's panel): frequency with VFO and
// mode, band + S-meter, a band-edge dial with the tuned spot marked, and the
// live receive waterfall filling what is left. RX/TX rides in the header cap.
function drawRigOps(ctx, w, h, td) {
  const r = td.rig || {}, s = k(h), pad = 10 * s, tx = r.ptt === true, lw = Math.max(1.5, 2 * s);
  const pill = r.online ? { text: tx ? "TX" : "RX", fill: tx ? C.red : C.amber } : { text: "offline", fill: C.dim };
  const top = frame(ctx, w, h, "Radio", null, "", C.green, { pill });
  const inner = w - 2 * pad;
  if (!r.online || !r.hz) {
    fitFont(ctx, "rig offline", inner, 14 * s, false, C.ui); ctx.fillStyle = C.dim;
    ctx.textAlign = "center"; ctx.fillText("rig offline", w / 2, (top + h) / 2); ctx.textAlign = "left";
    return;
  }
  // row 1: frequency (big, left) + VFO / mode stacked at the right
  const mhz = (r.hz / 1e6).toFixed(3);
  const fSize = fitFont(ctx, mhz, inner * 0.6, 32 * s, true);
  ctx.fillStyle = tx ? C.red : C.green; ctx.textAlign = "left"; ctx.fillText(mhz, pad, top + fSize);
  const vfo = r.vfo ? String(r.vfo).toUpperCase().replace(/^VFO(?=[A-Z])/, "VFO ") : "";
  const mode = String(r.mode || "").toUpperCase();
  ctx.textAlign = "right";
  if (vfo) { const vSize = fitFont(ctx, vfo, inner * 0.32, 11 * s, false, C.ui); ctx.fillStyle = C.dim; ctx.fillText(vfo, w - pad, top + vSize); }
  if (mode) { const mSize = fitFont(ctx, mode, inner * 0.32, 15 * s, true, C.ui); ctx.fillStyle = C.green; ctx.fillText(mode, w - pad, top + fSize); }
  let y = top + fSize + 7 * s;
  // row 2: band + S-meter (STRENGTH is dB relative to S9)
  const band = r.band || DASH;
  ctx.textAlign = "left";
  const bSize = fitFont(ctx, band, inner * 0.2, 13 * s, true, C.ui); ctx.fillStyle = C.amber; ctx.fillText(band, pad, y + bSize);
  const db = r.meters ? r.meters.s : null;
  const barX = pad + inner * 0.22, barW = inner * 0.56, barH = 5 * s, barY = y + bSize - barH;
  ctx.fillStyle = C.grid; rr(ctx, barX, barY, barW, barH, barH / 2); ctx.fill();
  if (db != null) {
    const frac = Math.max(0, Math.min(1, (db + 54) / 114));
    ctx.fillStyle = db > 0 ? C.red : C.amber; rr(ctx, barX, barY, Math.max(barH, barW * frac), barH, barH / 2); ctx.fill();
    const units = Math.max(0, Math.min(9, Math.round((db + 54) / 6)));
    fitFont(ctx, "S9+60", inner * 0.18, 10 * s, false, C.ui); ctx.fillStyle = C.dim; ctx.textAlign = "right";
    ctx.fillText(db > 0 ? `S9+${Math.round(db)}` : `S${units}`, w - pad, y + bSize); ctx.textAlign = "left";
  }
  y += bSize + 6 * s;
  // row 3: band-edge dial with the tuned frequency marked
  const sc = bandScale(r.hz);
  if (sc) {
    const lblSize = fitFont(ctx, "00.000", inner * 0.2, 9 * s, false, C.ui);
    const lineY = y + lblSize + 5 * s;
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad, lineY); ctx.lineTo(w - pad, lineY); ctx.stroke();
    for (let i = 0; i <= 4; i++) { const tx2 = pad + inner * (i / 4); ctx.beginPath(); ctx.moveTo(tx2, lineY); ctx.lineTo(tx2, lineY + 3 * s); ctx.stroke(); }
    const mx = pad + inner * sc.frac;
    ctx.fillStyle = C.green;
    ctx.beginPath(); ctx.moveTo(mx, lineY - 1); ctx.lineTo(mx - 3.5 * s, lineY - 6 * s); ctx.lineTo(mx + 3.5 * s, lineY - 6 * s); ctx.closePath(); ctx.fill();
    ctx.fillStyle = C.dim; ctx.textAlign = "left"; ctx.fillText(fmtMhz(sc.loKhz), pad, y + lblSize);
    ctx.textAlign = "right"; ctx.fillText(fmtMhz(sc.hiKhz), w - pad, y + lblSize);
    ctx.textAlign = "left";
    y = lineY + 5 * s;
  }
  // waterfall fills the rest, inset inside the frame
  const wf = td.rigWf, wfTop = Math.round(y + 2 * s), wfBot = Math.round(h - lw - 4 * s);
  if (wfTop < wfBot - 8 * s) {
    if (wf && wf.width) {
      ctx.save(); rr(ctx, pad - 2 * s, wfTop, inner + 4 * s, wfBot - wfTop, 5 * s); ctx.clip();
      ctx.drawImage(wf, pad - 2 * s, wfTop, inner + 4 * s, wfBot - wfTop);
      ctx.restore();
    } else {
      fitFont(ctx, "spectrum…", inner, 10 * s, false, C.ui); ctx.fillStyle = C.dim;
      ctx.textAlign = "center"; ctx.fillText("spectrum…", w / 2, (wfTop + wfBot) / 2 + 4 * s); ctx.textAlign = "left";
    }
  }
}

export function listTiles() { return TILES.map((t) => t.id); }

// Draw one tile into its canvas. DPR-scaled; individually guarded so a broken
// tile draws a frame + error to console instead of blanking the kiosk row.
export function drawTile(id, canvas, td, w = TILE_W, h = TILE_H) {
  const t = TILES.find((x) => x.id === id);
  if (!t || !canvas) return;
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  try { t.draw(ctx, w, h, td || {}); }
  catch (err) {
    console.error(`tile ${id} draw failed:`, err);
    try { frame(ctx, w, h, t.title, DASH, ""); } catch { /* give up quietly */ }
  }
}
