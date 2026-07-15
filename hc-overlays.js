// HamClock v2 overlay registry. Each overlay: { id, label, draw(ctx, rc), panel(rc)|null }.
// rc (render context): { W, H, project(lon,lat,W,H)->{x,y}, data:{solar,spots,station},
//   layers:{sats,muf,drap,psk}, station, now:Date, satlib }.
// draw/panel are ONLY invoked via drawOverlay()/overlayPanel() below, which catch and
// log throws — a broken overlay must never kill the render loop or blank the map.
import { greatCircle, splitAntimeridian, gridToLatLon } from "./geo.js";
import { subsolarPoint, terminatorLat, sunTimes } from "./astro.js";
import { moonPosition, moonPhase, moonLookAngles, moonRiseSet } from "./astro-moon.js";
import { drawMoon as drawMoonTexture, sunEquatorial, brightLimbAngle } from "./hc-moon.js";
import { subPoint, footprintRadiusDeg, nextPasses, lookAngles, dopplerHz } from "./sat-passes.js";
import { activeBeacons, allBeacons } from "./beacons.js";
import { bandOfHz, modeColor } from "./hc-psk.js";

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Legend lines (mandatory attributions — exact MUF/PSK wording is a design requirement).
export const ATTRIBUTIONS = {
  muf: "MUF: prop.kc2g.com (KC2G) · data via GIRO/INGV",
  fof2: "foF2: prop.kc2g.com (KC2G) · data via GIRO/INGV",
  drap: "DRAP: NOAA SWPC",
  aurora: "Aurora: NOAA SWPC (OVATION)",
  sats: "TLEs: CelesTrak",
  psk: "RX reports: PSKReporter.info",
  beacons: "Beacons: NCDXF/IARU",
  boundaries: "Borders: Natural Earth",
  citylights: "City lights: NASA Black Marble",
};

// Distinct per-band colors for the DX great-circle paths + legend.
const BAND_COLORS = {
  "160m": "#b06be6", "80m": "#e65b5b", "60m": "#e6905b", "40m": "#e6c95b",
  "30m": "#a7e65b", "20m": "#5be68a", "17m": "#5be6d0", "15m": "#5bb0e6",
  "12m": "#5b74e6", "10m": "#b06be6", "6m": "#e65bd0", "2m": "#e65b9c", "70cm": "#dfe6ef",
};
const BAND_ORDER = ["160m", "80m", "60m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m", "70cm"];
const bandColor = (b) => BAND_COLORS[b] || "rgba(120,200,255,0.55)";

// Downlink center frequencies (Hz) for the watchlist birds, for live Doppler.
const SAT_DOWNLINK_HZ = {
  25544: 145.800e6, // ISS FM voice
  27607: 436.795e6, // SO-50
  43017: 145.960e6, // AO-91
  24278: 435.850e6, // FO-29 SSB
  44909: 435.640e6, // RS-44 SSB
  43678: 145.900e6, // PO-101 FM
};

// Stroke a [[lon,lat],...] polyline, split at the antimeridian so nothing streaks.
function strokeSegments(ctx, points, project, W, H) {
  for (const seg of splitAntimeridian(points)) {
    if (seg.length < 2) continue;
    ctx.beginPath();
    seg.forEach(([lon, lat], i) => { const p = project(lon, lat, W, H); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
    ctx.stroke();
  }
}

// Points of the small circle of angular radius radDeg around (lat0, lon0) — the
// satellite footprint ring. Standard destination-point formula swept through 360°.
function smallCircle(lat0, lon0, radDeg, n = 72) {
  const pts = [];
  const d = radDeg * RAD, phi0 = lat0 * RAD, lam0 = lon0 * RAD;
  for (let i = 0; i <= n; i++) {
    const th = 2 * Math.PI * i / n;
    const phi = Math.asin(Math.sin(phi0) * Math.cos(d) + Math.cos(phi0) * Math.sin(d) * Math.cos(th));
    const lam = lam0 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(phi0), Math.cos(d) - Math.sin(phi0) * Math.sin(phi));
    pts.push([((lam * DEG + 540) % 360) - 180, phi * DEG]);
  }
  return pts;
}

// ---- paths: great-circle arcs DE -> each DX spot, colored by band ----
function drawPaths(ctx, rc) {
  const { W, H, project, data, station } = rc;
  ctx.lineWidth = 1.2;
  for (const s of data.spots || []) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    ctx.strokeStyle = bandColor(s.band);
    strokeSegments(ctx, greatCircle(Number(station.lat), Number(station.lon), s.lat, s.lon, 64), project, W, H);
  }
}

function pathsPanel(rc) {
  const spots = rc.data.spots || [];
  if (!spots.length) return `<p class="hcMuted">no DX spots</p>`;
  const counts = {};
  for (const s of spots) if (s.band) counts[s.band] = (counts[s.band] || 0) + 1;
  const rows = BAND_ORDER.filter((b) => counts[b]).map((b) =>
    `<div class="hcKv"><span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;background:${bandColor(b)};margin-right:7px;vertical-align:-1px"></span>${b}</span><b>${counts[b]}</b></div>`
  ).join("");
  return (rows || `<p class="hcMuted">spots have no band</p>`) + `<p class="hcAttr">DX paths colored by band</p>`;
}

// ---- aurora: NOAA SWPC OVATION nowcast, green shading by probability ----
function drawAurora(ctx, rc) {
  const { W, H, project, layers } = rc;
  const pts = layers.aurora?.points || [];
  const cw = (1 / 360) * W, ch = (1 / 180) * H;   // OVATION grid: 1° × 1° cells
  for (const [lon, lat, val] of pts) {
    const p = project(lon, lat, W, H);
    const a = Math.min(0.75, 0.12 + val / 160);
    ctx.fillStyle = `rgba(74,255,140,${a.toFixed(3)})`;
    ctx.fillRect(p.x - cw / 2, p.y - ch / 2, cw + 0.6, ch + 0.6);
  }
}

function auroraPanel(rc) {
  const a = rc.layers.aurora;
  const attr = `<p class="hcAttr">${esc(ATTRIBUTIONS.aurora)}</p>`;
  const pts = a?.points || [];
  if (!pts.length) return `<p class="hcMuted">no significant aurora</p>` + attr;
  const max = Math.max(...pts.map((p) => p[2]));
  const nStrong = pts.filter((p) => p[1] > 0 && p[2] >= 20).length;
  const sStrong = pts.filter((p) => p[1] < 0 && p[2] >= 20).length;
  return `<div class="hcKv"><span>Peak probability</span><b>${max}%</b></div>`
    + `<div class="hcKv"><span>Active cells</span><b>${pts.length}</b></div>`
    + `<div class="hcKv"><span>N / S strong</span><b>${nStrong} / ${sStrong}</b></div>`
    + `<div class="hcKv"><span>Updated</span><b>${esc((a.forecast || "").slice(11, 16) || "—")}</b></div>`
    + attr;
}

// ---- grayline: highlight the day/night terminator band (enhanced DX) ----
function drawGrayline(ctx, rc) {
  const { W, H, project, now } = rc;
  const sub = subsolarPoint(now);
  const pts = [];
  for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, terminatorLat(lon, sub)]);
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,168,54,0.32)"; ctx.lineWidth = 16;  // soft band
  strokeSegments(ctx, pts, project, W, H);
  ctx.strokeStyle = "rgba(255,205,110,0.85)"; ctx.lineWidth = 2;  // bright center line
  strokeSegments(ctx, pts, project, W, H);
  ctx.restore();
}

function graylinePanel(rc) {
  const { station, now } = rc;
  const st = sunTimes(Number(station.lat), Number(station.lon), now);
  const hhmm = (h) => (h == null ? "—" : `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}Z`);
  return `<div class="hcKv"><span>Your sunrise</span><b>${hhmm(st.riseUTC)}</b></div>`
    + `<div class="hcKv"><span>Your sunset</span><b>${hhmm(st.setUTC)}</b></div>`
    + `<div class="hcKv"><span>Daylight</span><b>${st.dayHours.toFixed(1)} h</b></div>`
    + `<p class="hcAttr">Grayline: work DX along the terminator around your sunrise/sunset.</p>`;
}

// ---- muf: KC2G MUF(3000) iso-contours, colored by KC2G's own level colors ----
function drawMuf(ctx, rc) {
  const { W, H, project, layers } = rc;
  ctx.lineWidth = 1.4;
  ctx.font = "10px ui-monospace, monospace";
  for (const c of layers.muf?.contours || []) {
    ctx.strokeStyle = c.color || "#4488ff";
    strokeSegments(ctx, c.points, project, W, H);
    const mid = c.points[Math.floor(c.points.length / 2)];
    if (mid) {
      const p = project(mid[0], mid[1], W, H);
      ctx.fillStyle = c.color || "#4488ff";
      ctx.fillText(String(c.mufd), p.x + 3, p.y - 3);
    }
  }
}

function mufPanel(rc) {
  const cs = rc.layers.muf?.contours || [];
  const attr = `<p class="hcAttr">${esc(ATTRIBUTIONS.muf)}</p>`;
  if (!cs.length) return `<p class="hcMuted">no MUF data</p>` + attr;
  const vals = [...new Set(cs.map((c) => c.mufd))].sort((a, b) => a - b);
  return `<div class="hcKv"><span>Contours</span><b>${cs.length}</b></div>`
    + `<div class="hcKv"><span>MUF range</span><b>${vals[0]}&ndash;${vals[vals.length - 1]} MHz</b></div>`
    + `<div class="hcKv"><span>Updated</span><b>${esc((rc.layers.muf.updated || "").slice(11, 16) || "—")}</b></div>`
    + attr;
}

// ---- fof2: KC2G foF2 (critical frequency) iso-contours, teal ----
function drawFoF2(ctx, rc) {
  const { W, H, project, layers } = rc;
  ctx.lineWidth = 1.2;
  ctx.font = "10px ui-monospace, monospace";
  ctx.setLineDash([5, 3]);
  for (const c of layers.fof2?.contours || []) {
    ctx.strokeStyle = "rgba(45,212,170,0.8)";
    strokeSegments(ctx, c.points, project, W, H);
    const mid = c.points[Math.floor(c.points.length / 2)];
    if (mid) {
      const p = project(mid[0], mid[1], W, H);
      ctx.fillStyle = "rgba(45,212,170,0.9)";
      ctx.fillText(String(c.mufd), p.x + 3, p.y - 3);
    }
  }
  ctx.setLineDash([]);
}

function fof2Panel(rc) {
  const cs = rc.layers.fof2?.contours || [];
  const attr = `<p class="hcAttr">${esc(ATTRIBUTIONS.fof2)}</p>`;
  if (!cs.length) return `<p class="hcMuted">no foF2 data</p>` + attr;
  const vals = [...new Set(cs.map((c) => c.mufd))].sort((a, b) => a - b);
  return `<div class="hcKv"><span>Contours</span><b>${cs.length}</b></div>`
    + `<div class="hcKv"><span>foF2 range</span><b>${vals[0]}&ndash;${vals[vals.length - 1]} MHz</b></div>`
    + `<div class="hcKv"><span>Updated</span><b>${esc((rc.layers.fof2.updated || "").slice(11, 16) || "—")}</b></div>`
    + `<p class="hcAttr">Critical frequency — NVIS/short-skip ceiling</p>` + attr;
}

// ---- drap: NOAA SWPC D-region absorption, orange/red shading by MHz ----
function drawDrap(ctx, rc) {
  const { W, H, project, layers } = rc;
  const d = layers.drap;
  if (!d?.grid?.length || !d.lons?.length) return;
  const cw = (4 / 360) * W, ch = (2 / 180) * H;   // SWPC grid: 4° lon × 2° lat cells
  for (let i = 0; i < d.lats.length; i++) {
    for (let j = 0; j < d.lons.length; j++) {
      const v = d.grid[i]?.[j];
      if (!Number.isFinite(v) || v < 1.5) continue;   // quiet background stays invisible
      const p = project(d.lons[j], d.lats[i], W, H);
      ctx.fillStyle = `rgba(255,120,30,${Math.min(0.6, 0.08 + v / 40).toFixed(3)})`;
      ctx.fillRect(p.x - cw / 2, p.y - ch / 2, cw + 0.5, ch + 0.5);
    }
  }
}

function drapPanel(rc) {
  const d = rc.layers.drap;
  const attr = `<p class="hcAttr">${esc(ATTRIBUTIONS.drap)}</p>`;
  const flat = (d?.grid || []).flat().filter(Number.isFinite);
  if (!flat.length) return `<p class="hcMuted">no DRAP data</p>` + attr;
  const max = Math.max(...flat);
  return `<div class="hcKv"><span>Peak absorption</span><b>${max.toFixed(1)} MHz</b></div>`
    + `<div class="hcKv"><span>Grid</span><b>${d.lats.length} &times; ${d.lons.length}</b></div>`
    + `<div class="hcKv"><span>Updated</span><b>${esc((d.updated || "").slice(11, 16) || "—")}</b></div>`
    + attr;
}

// ---- sats: sub-satellite point + footprint ring, propagated client-side ----
const satrecCache = new Map();  // tle1 -> satrec (rebuilds automatically when TLEs update)
function satrecFor(satlib, s) {
  let rec = satrecCache.get(s.tle1);
  if (!rec) {
    try { rec = satlib.twoline2satrec(s.tle1, s.tle2); } catch { rec = null; }
    if (satrecCache.size > 100) satrecCache.clear(); // cap unbounded growth on 24/7 kiosk
    satrecCache.set(s.tle1, rec);
  }
  return rec && rec.error === 0 ? rec : null;
}
const passCache = new Map();    // noradId -> { at: ms, key: tle1, passes }
function passesFor(satlib, s, station, now) {
  const hit = passCache.get(s.noradId);
  if (hit && hit.key === s.tle1 && now.getTime() - hit.at < 600000) return hit.passes;   // 10-min cache
  const rec = satrecFor(satlib, s);
  const passes = rec
    ? nextPasses(rec, { lat: Number(station.lat), lon: Number(station.lon), altKm: 0.14 }, now, 24, 60, satlib)
    : [];
  passCache.set(s.noradId, { at: now.getTime(), key: s.tle1, passes });
  return passes;
}

function drawSats(ctx, rc) {
  const { W, H, project, layers, now, satlib } = rc;
  if (!satlib) return;   // satellite.js failed to load -> overlay is a silent no-op
  ctx.font = "10px ui-monospace, monospace";
  for (const s of layers.sats?.sats || []) {
    const rec = satrecFor(satlib, s);
    if (!rec) continue;
    const sp = subPoint(rec, now, satlib);
    if (!sp) continue;   // decayed/garbage propagation -> skip this bird
    ctx.strokeStyle = "rgba(255,255,255,0.45)";
    ctx.lineWidth = 0.8;
    strokeSegments(ctx, smallCircle(sp.lat, sp.lon, footprintRadiusDeg(sp.altKm)), project, W, H);
    const p = project(sp.lon, sp.lat, W, H);
    ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, 2 * Math.PI); ctx.fillStyle = "#ff5fd0"; ctx.fill();
    ctx.fillStyle = "rgba(255,95,208,0.95)";
    ctx.fillText(String(s.name), p.x + 6, p.y + 3);
  }
}

function satsPanel(rc) {
  const attr = `<p class="hcAttr">${esc(ATTRIBUTIONS.sats)}</p>`;
  if (!rc.satlib) return `<p class="hcMuted">satellite.js not loaded</p>` + attr;
  const sats = rc.layers.sats?.sats || [];
  if (!sats.length) return `<p class="hcMuted">no TLEs yet</p>` + attr;
  const station = { lat: Number(rc.station.lat), lon: Number(rc.station.lon), altKm: 0.14 };
  const rows = sats.map((s) => {
    const rec = satrecFor(rc.satlib, s);
    const look = rec ? lookAngles(rec, station, rc.now, rc.satlib) : null;
    if (look && look.el > 0) {                          // overhead now: live az/el + Doppler
      const dHz = SAT_DOWNLINK_HZ[s.noradId] != null ? dopplerHz(rec, station, rc.now, SAT_DOWNLINK_HZ[s.noradId], rc.satlib) : null;
      const dop = dHz != null ? ` · ${dHz >= 0 ? "+" : ""}${(dHz / 1000).toFixed(1)} kHz` : "";
      return `<div class="hcKv"><span>${esc(s.name)} &#9650;</span><b>${Math.round(look.el)}&deg; el · ${Math.round(look.az)}&deg;${dop}</b></div>`;
    }
    const p = passesFor(rc.satlib, s, rc.station, rc.now)[0];
    const txt = p ? `${p.aos.toISOString().slice(11, 16)}Z · max ${Math.round(p.maxEl)}°` : "no pass &lt;24h";
    return `<div class="hcKv"><span>${esc(s.name)}</span><b>${txt}</b></div>`;
  }).join("");
  return rows + `<p class="hcAttr">&#9650; overhead now (live az/el + Doppler)</p>` + attr;
}

// ---- moon: sublunar marker, phase-accurate textured disc (same renderer as the moon
// tile) -- falls back to a flat gray disc inside drawMoonTexture if rc.moonTex hasn't
// loaded yet. Works in both equirect and azimuthal since rc.project/front-gating are
// shared with the rest of the overlay registry.
function drawMoon(ctx, rc) {
  const { W, H, project, now } = rc;
  const m = moonPosition(now);
  const { fraction } = moonPhase(now);
  const angleDeg = brightLimbAngle(sunEquatorial(now), m);
  const p = project(m.subLon, m.subLat, W, H);
  const r = 10;
  drawMoonTexture(ctx, p.x, p.y, r, { fraction, angleDeg }, rc.moonTex);
  ctx.strokeStyle = "rgba(201,206,214,0.8)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, 2 * Math.PI); ctx.stroke();
  ctx.font = "10px ui-monospace, monospace";
  ctx.fillStyle = "rgba(201,206,214,0.9)";
  ctx.fillText("MOON", p.x + r + 6, p.y + 3);
}

function moonPanel(rc) {
  const { station, now } = rc;
  const m = moonPosition(now);
  const ph = moonPhase(now);
  const la = moonLookAngles(Number(station.lat), Number(station.lon), now);
  const rs = moonRiseSet(Number(station.lat), Number(station.lon), now);
  const hhmm = (d) => (d ? d.toISOString().slice(11, 16) + "Z" : "—");
  return `<div class="hcKv"><span>Illuminated</span><b>${(ph.fraction * 100).toFixed(0)}%</b></div>`
    + `<div class="hcKv"><span>Age</span><b>${ph.ageDays.toFixed(1)} d</b></div>`
    + `<div class="hcKv"><span>Az / El</span><b>${la.az.toFixed(0)}° / ${la.el.toFixed(0)}°</b></div>`
    + `<div class="hcKv"><span>Rise / Set</span><b>${hhmm(rs.rise)} / ${hhmm(rs.set)}</b></div>`
    + `<div class="hcKv"><span>Distance</span><b>${Math.round(m.distKm).toLocaleString()} km</b></div>`
    + `<div class="hcKv"><span>Sub-lunar</span><b>${m.subLat.toFixed(1)}, ${m.subLon.toFixed(1)}</b></div>`
    + `<p class="hcAttr">EME window: el &gt; 0°</p>`;
}

// ---- psk: who is hearing us — teal dots at receiver grids + faint DE->rx arcs ----
const hexA = (hex, a) => {   // "#rrggbb" -> "rgba(r,g,b,a)"
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
function pskReportColor(r, colorBy) {
  if (colorBy === "mode") return modeColor(r.mode);
  if (colorBy === "mono") return "#40e0d0";
  return bandColor(bandOfHz(r.freqHz));               // default: band (matches the Paths legend)
}
function drawPsk(ctx, rc) {
  const { W, H, project, layers, station } = rc;
  const deLat = Number(station.lat), deLon = Number(station.lon);
  const colorBy = rc.pskColorBy || "band";
  ctx.save();
  ctx.lineWidth = 1.1;
  for (const r of layers.psk?.reports || []) {
    const ll = gridToLatLon(r.rxGrid);
    if (!ll) continue;
    const col = pskReportColor(r, colorBy);
    ctx.shadowColor = col; ctx.shadowBlur = 9;        // the glow
    ctx.strokeStyle = hexA(col, 0.55);
    strokeSegments(ctx, greatCircle(deLat, deLon, ll.lat, ll.lon, 48), project, W, H);
    const p = project(ll.lon, ll.lat, W, H);
    ctx.beginPath(); ctx.arc(p.x, p.y, 3.2, 0, 2 * Math.PI); ctx.fillStyle = col; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.3, 0, 2 * Math.PI); ctx.fillStyle = "#fff"; ctx.fill();  // hot core
  }
  ctx.restore();
}

function pskPanel(rc) {
  const attr = `<p class="hcAttr">${esc(ATTRIBUTIONS.psk)}</p>`;
  const reps = rc.layers.psk?.reports || [];
  const who = rc.pskDirection === "receiver" ? `heard by ${esc(rc.station.call)}` : `hearing ${esc(rc.station.call)}`;
  if (!reps.length) return `<p class="hcMuted">no stations ${who} in the window</p>` + attr;
  const colorBy = rc.pskColorBy || "band";
  // legend: counts per band or mode, swatches matching the map
  let legend = "";
  if (colorBy !== "mono") {
    const counts = new Map();
    for (const r of reps) {
      const k = colorBy === "mode" ? (String(r.mode || "?").toUpperCase()) : (bandOfHz(r.freqHz) || "?");
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    legend = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => {
      const col = colorBy === "mode" ? modeColor(k) : bandColor(k);
      return `<div class="hcKv"><span><span style="display:inline-block;width:11px;height:11px;border-radius:2px;background:${col};margin-right:7px;vertical-align:-1px"></span>${esc(k)}</span><b>${n}</b></div>`;
    }).join("");
  }
  const nowS = rc.now.getTime() / 1000;
  const rows = reps.slice(0, 10).map((r) => {
    const age = Math.max(0, Math.round((nowS - r.epoch) / 60));
    const snr = Number.isFinite(r.snr) ? `${r.snr} dB` : "";
    const ageTxt = age >= 90 ? `${Math.round(age / 60)}h` : `${age}m`;
    return `<div class="hcSpot"><b>${esc(r.rxCall)}</b> <span class="hcBand">${(Number(r.freqHz) / 1e6).toFixed(3)}</span> <span class="hcCty">${esc(r.mode)} ${esc(snr)}</span> <span class="hcT">${ageTxt}</span></div>`;
  }).join("");
  return legend + rows + attr;
}

// ---- beacons: NCDXF/IARU network -- all 18 plotted, the 5 transmitting now highlighted ----
function drawBeacons(ctx, rc) {
  const { W, H, project, now } = rc;
  const act = activeBeacons(now || new Date());
  const activeBand = new Map(act.map((b) => [b.call, b.label]));
  ctx.font = "10px ui-monospace, monospace";
  for (const b of allBeacons()) {
    const p = project(b.lon, b.lat, W, H);
    const band = activeBand.get(b.call);
    ctx.fillStyle = band ? "#ffd23d" : "rgba(160,170,190,0.55)";
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
    if (band) {
      ctx.strokeStyle = "#ffd23d"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, 2 * Math.PI); ctx.stroke();
      ctx.fillStyle = "rgba(255,210,61,0.95)";
      ctx.fillText(`${b.call} ${band}`, p.x + 9, p.y + 3);
    }
  }
}

function beaconsPanel(rc) {
  const attr = `<p class="hcAttr">${esc(ATTRIBUTIONS.beacons)}</p>`;
  return activeBeacons(rc.now || new Date()).map((b) =>
    `<div class="hcKv"><span>${(b.khz / 1000).toFixed(3)} MHz (${esc(b.label)})</span><b>${esc(b.call)}</b></div>`
  ).join("") + attr;
}

// ---- political boundaries: country border lines (Natural Earth), any basemap ----
function drawBoundaries(ctx, rc) {
  const { W, H, project, bounds } = rc;
  if (!bounds || !bounds.length) return;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 1.8;      // dark halo for contrast on any basemap
  for (const line of bounds) strokeSegments(ctx, line, project, W, H);
  ctx.strokeStyle = "rgba(244,228,170,0.85)"; ctx.lineWidth = 0.8; // bright border line
  for (const line of bounds) strokeSegments(ctx, line, project, W, H);
}
function boundariesPanel() { return `<p class="hcAttr">${esc(ATTRIBUTIONS.boundaries)}</p>`; }
// City Lights is a basemap modifier (composited on the flat map, blended in the
// globe shader), so its overlay draw is a no-op - it just needs a registry entry
// to appear as a toggle you can enable/lock alongside the others.
function drawCityLights() { /* effect lives in the basemap, see hamclock.js */ }
function cityLightsPanel() { return `<p class="hcAttr">${esc(ATTRIBUTIONS.citylights)}</p>`; }

// Ordered registry — spec chip order: Paths · MUF · DRAP · Sats · Moon · PSK · Beacons.
const OVERLAYS = [
  { id: "paths", label: "Paths", draw: drawPaths, panel: pathsPanel },
  { id: "grayline", label: "Grayline", draw: drawGrayline, panel: graylinePanel },
  { id: "muf", label: "MUF", draw: drawMuf, panel: mufPanel },
  { id: "fof2", label: "foF2", draw: drawFoF2, panel: fof2Panel },
  { id: "drap", label: "DRAP", draw: drawDrap, panel: drapPanel },
  { id: "aurora", label: "Aurora", draw: drawAurora, panel: auroraPanel },
  { id: "sats", label: "Sats", draw: drawSats, panel: satsPanel },
  { id: "moon", label: "Moon", draw: drawMoon, panel: moonPanel },
  { id: "psk", label: "PSK", draw: drawPsk, panel: pskPanel },
  { id: "beacons", label: "Beacons", draw: drawBeacons, panel: beaconsPanel },
  { id: "boundaries", label: "Borders", draw: drawBoundaries, panel: boundariesPanel },
  { id: "citylights", label: "City Lights", draw: drawCityLights, panel: cityLightsPanel },
];

export function listOverlays() { return OVERLAYS; }

export function drawOverlay(id, ctx, rc) {
  const o = OVERLAYS.find((x) => x.id === id);
  if (!o) return;
  try { o.draw(ctx, rc); } catch (err) { console.error(`overlay ${id} draw failed:`, err); }
}

export function overlayPanel(id, rc) {
  const o = OVERLAYS.find((x) => x.id === id);
  if (!o || !o.panel) return null;
  try { return o.panel(rc); } catch (err) { console.error(`overlay ${id} panel failed:`, err); return null; }
}
