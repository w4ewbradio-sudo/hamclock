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
const C = { bg: "#0a0e18", grid: "#1c2740", green: "#7dd87d", amber: "#e8a33d", red: "#ff5f5f", dim: "#6b7a99" };
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
function fitFont(ctx, text, maxW, idealPx, bold = false) {
  const wt = bold ? "bold " : "";
  let size = Math.max(7, Math.round(idealPx));
  ctx.font = `${wt}${size}px ${MONO}`;
  const tw = ctx.measureText(String(text)).width;
  if (tw > maxW && tw > 0) size = Math.max(7, Math.floor(size * (maxW / tw)));
  ctx.font = `${wt}${size}px ${MONO}`;
  return size;
}

// Tile bg/border + an eyebrow title with (optionally) a big value stacked below.
// Returns the y where the tile's own content can start (below the header).
function frame(ctx, w, h, title, value, attr, valueColor = C.green) {
  const s = k(h), pad = 9 * s;
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = C.grid; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.textAlign = "left";
  const tSize = fitFont(ctx, String(title).toUpperCase(), w - 2 * pad, 13 * s);
  ctx.fillStyle = C.dim; ctx.fillText(String(title).toUpperCase(), pad, pad + tSize);
  let top = pad + tSize + 5 * s;
  if (value != null) {
    const vSize = fitFont(ctx, String(value), w - 2 * pad, Math.min(36 * s, 0.42 * w), true);
    ctx.fillStyle = valueColor; ctx.textAlign = "right";
    ctx.fillText(String(value), w - pad, top + vSize);
    ctx.textAlign = "left";
    top += vSize + 6 * s;
  }
  if (attr) { fitFont(ctx, attr, w - 2 * pad, 8.5 * s); ctx.fillStyle = C.dim; ctx.fillText(attr, pad, h - 5 * s); }
  return top;
}
function chartBox(w, h, top) {
  const s = k(h), y = top != null ? top : 26 * s;
  return { x: 9 * s, y, w: w - 18 * s, h: Math.max(10, h - y - 14 * s) };
}

// ---- the tiles ----

// hamqsl band-condition word -> color.
function condColor(c) {
  return /good/i.test(c) ? C.green : /fair/i.test(c) ? C.amber : /poor/i.test(c) ? C.red : C.dim;
}

const TILES = [
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
    const top = frame(ctx, w, h, "BAND COND", null, "hamqsl");
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
    const hSize = fitFont(ctx, "NGT", w * 0.18, 11 * s);
    ctx.fillStyle = C.dim; ctx.textAlign = "right";
    ctx.fillText("DAY", colDay, top + hSize); ctx.fillText("NGT", colNgt, top + hSize);
    ctx.textAlign = "left";
    const y0 = top + hSize + 3 * s, step = (h - 12 * s - y0) / Math.max(1, names.length);
    const cell = Math.min(step * 0.8, 18 * s);
    names.forEach((name, i) => {
      const y = y0 + step * (i + 0.72), bd = (td.bands || {})[name] || {};
      const dv = (bd.day || "-").slice(0, 4), nv = (bd.night || "-").slice(0, 4);
      ctx.textAlign = "left"; ctx.fillStyle = C.dim;
      fitFont(ctx, name, w * 0.28, cell, true); ctx.fillText(name, pad, y);
      ctx.textAlign = "right";
      fitFont(ctx, dv, w * 0.18, cell, true); ctx.fillStyle = condColor(bd.day); ctx.fillText(dv, colDay, y);
      fitFont(ctx, nv, w * 0.18, cell, true); ctx.fillStyle = condColor(bd.night); ctx.fillText(nv, colNgt, y);
    });
    ctx.textAlign = "left";
  } },
  { id: "sun", title: "SUN", draw(ctx, w, h, td) {
    const s = k(h);
    const top = frame(ctx, w, h, td.sunLabel || "SUN HMI", null, td.sunAttr || "NASA/SDO");
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
    const top = frame(ctx, w, h, "WX DE", wx ? `${Math.round(wx.tempF)}°F` : DASH, "open-meteo.com", C.amber);
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
    fitFont(ctx, "az 000  el 00", w - 12 * s, 13 * s, true); ctx.fillStyle = C.green; ctx.textAlign = "center";
    ctx.fillText(`az ${la.az.toFixed(0)}  el ${la.el.toFixed(0)}`, cx, h - 6 * s); ctx.textAlign = "left";
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
];

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
