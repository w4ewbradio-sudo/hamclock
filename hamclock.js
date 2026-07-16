import { subsolarPoint, terminatorLat, sunTimes, isNight } from "./astro.js";
import { listOverlays, drawOverlay, overlayPanel, ATTRIBUTIONS } from "./hc-overlays.js";
import { drawTile, listTiles, TILE_W, TILE_H } from "./hc-tiles.js";
import { azimuthal, azimuthalInverse, gridToLatLon } from "./geo.js";
import { makeGlobe3D, makeProjector } from "./hc-globe3d.js";
import { makePskJsonpCache } from "./hc-psk.js";
import { completeSatDate } from "./hc-gibs.js";
import { parseDomainRanges, lastTimes, unionTimes, nearestAtOrBefore, flipbookDates, goesUrl, viirsUrl } from "./hc-anim.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
// Standalone (HamClock Web): a static build served from GitHub Pages with no local
// Control Center. The build script sets window.HC_STANDALONE; data then comes from
// hc-data-web.js (direct upstream feeds) and assets sit beside index.html.
const STANDALONE = typeof window !== "undefined" && !!window.HC_STANDALONE;
const ASSET = (p) => (STANDALONE ? "./" : "/ui/") + p;
let land = null;      // GeoJSON features
let bounds = null;    // political boundary polylines (Borders overlay)
let data = {
  solar: null, spots: [],
  station: { call: "W4EWB", grid: "EM78", lat: 38.2527, lon: -85.7585 },
  spacewx: { kp: [], flux: [], ssn: [], xray: { series: [], class: null }, updated: null },
  weather: null,
  ui: { tileOrder: null, mapStyle: "line", mapProjection: "equirect" },
};
let layers = {
  sats: { updated: null, sats: [] },
  muf: { updated: null, contours: [] },
  drap: { updated: null, lats: [], lons: [], grid: [] },
  psk: { updated: null, reports: [] },
};
// satellite.js is a classic UMD <script> loaded before this module; if it failed to
// load, satlib is null and the sats overlay no-ops (everything else keeps running).
const satlib = window.satellite || null;
const $ = (id) => document.getElementById(id);

// ---- v3 images: live sun disc (server proxy) + bundled moon texture ----
const sunImg = new Image();
let sunReady = false;
sunImg.onload = () => { sunReady = true; renderTiles(); };
sunImg.onerror = () => { sunReady = false; };            // 503 before first fetch -> placeholder tile
// Selectable Sun view. Default (hmiic) uses the cached server proxy; the rest load
// the source image directly (display-only, so cross-origin taint is harmless).
const SDO_URL = (ch) => `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_512_${ch}.jpg`;
const SUN_VIEWS = [
  { id: "hmiic", label: "Sunspots (white light)", short: "SUN — HMI", attr: "NASA/SDO", url: null },
  { id: "0304", label: "AIA 304 — prominences", short: "SUN — 304Å", attr: "NASA/SDO", url: SDO_URL("0304") },
  { id: "0171", label: "AIA 171 — corona loops", short: "SUN — 171Å", attr: "NASA/SDO", url: SDO_URL("0171") },
  { id: "0193", label: "AIA 193 — hot corona", short: "SUN — 193Å", attr: "NASA/SDO", url: SDO_URL("0193") },
  { id: "0211", label: "AIA 211 — active regions", short: "SUN — 211Å", attr: "NASA/SDO", url: SDO_URL("0211") },
  { id: "hmib", label: "Magnetogram (HMI)", short: "SUN — MAG", attr: "NASA/SDO", url: SDO_URL("HMIB") },
  { id: "hamqsl", label: "hamqsl solar globe", short: "SUN — hamqsl", attr: "hamqsl.com", url: "https://www.hamqsl.com/solarglobe.gif" },
];
let sunView = (() => { try { const v = localStorage.getItem("hcSunView"); return SUN_VIEWS.some((x) => x.id === v) ? v : "hmiic"; } catch { return "hmiic"; } })();
const curSunView = () => SUN_VIEWS.find((x) => x.id === sunView) || SUN_VIEWS[0];
function loadSun() {
  // Kiosk default goes through the caching server proxy; standalone loads SDO direct.
  const base = curSunView().url || (STANDALONE ? SDO_URL("HMIIC") : "/api/hamclock/sun");
  sunImg.src = base + (base.includes("?") ? "&" : "?") + "t=" + Date.now();
}
function setSunView(id) {
  if (!SUN_VIEWS.some((x) => x.id === id)) return;
  sunView = id;
  try { localStorage.setItem("hcSunView", id); } catch { /* session-only */ }
  loadSun();
}
const moonTex = new Image();
let moonReady = false;
moonTex.onload = () => { moonReady = true; renderTiles(); };
moonTex.onerror = () => { moonReady = false; };          // missing moon.jpg -> procedural gray moon
moonTex.src = ASSET("moon.jpg");

// Latest SSTV RX capture. Kiosk default: the W4EWB gallery (aliases the newest to
// latest.jpg; CORS open). A custom URL in settings overrides on either build; on
// standalone with no URL configured the tile hides itself entirely.
const sstvImg = new Image();
let sstvReady = false;
sstvImg.onload = () => { sstvReady = true; renderTiles(); };
sstvImg.onerror = () => { sstvReady = false; };          // no capture yet -> placeholder tile
function sstvUrl() {
  const custom = lsGet("hcSstvUrl", "").trim();
  return custom || (STANDALONE ? "" : "https://w4ewbradio-sudo.github.io/W4EWB/sstv/rx/latest.jpg");
}
function loadSstv() {
  const u = sstvUrl();
  if (!u) { sstvReady = false; return; }
  sstvImg.src = u + (u.includes("?") ? "&" : "?") + "t=" + Date.now();
}

// Standalone band conditions: hamqsl's XML feed has no CORS, but their embeddable
// band-conditions GIF (published for exactly this purpose) displays fine.
const bandsImg = new Image();
let bandsReady = false;
bandsImg.onload = () => { bandsReady = true; renderTiles(); };
bandsImg.onerror = () => { bandsReady = false; };
function loadBandsImg() { if (STANDALONE) bandsImg.src = "https://www.hamqsl.com/solarbc.php?t=" + Date.now(); }

// ---- v3 basemap styles: bundled NASA Blue/Black Marble under the vector map ----
const worldDay = new Image();
let dayReady = false;
worldDay.onload = () => { dayReady = true; drawMap(); };
worldDay.onerror = () => { dayReady = false; };   // missing asset -> Line style fallback
worldDay.src = ASSET("world-day.jpg");
const worldNight = new Image();
let nightReady = false;
worldNight.onload = () => { nightReady = true; drawMap(); };
worldNight.onerror = () => { nightReady = false; };
worldNight.src = ASSET("world-night.jpg");

// Live satellite basemap: NASA GIBS global true-color mosaic (VIIRS). Requested
// for "yesterday" UTC so the whole globe is a COMPLETE day of real cloud cover
// (today's swaths are still filling in). CORS is open, so crossOrigin lets the
// globe raster read its pixels without tainting. Refreshed to catch the date roll.
const worldSat = new Image();
worldSat.crossOrigin = "anonymous";
let satReady = false;
worldSat.onload = () => { satReady = true; syncUi(); };   // refresh chips/legend + redraw once it's in
worldSat.onerror = () => { satReady = false; };   // GIBS unreachable -> Terrain/Line fallback
// GIBS's newest imagery can lag the wall clock by days, and this station's clock
// may even run ahead of it - so asking for "yesterday" can land past the newest
// data and return an empty (black) tile. Instead, discover the layer's actual
// latest available date from its DescribeDomains feed (open CORS) and use that.
let satDate = null;
// NOAA-20 (JPSS-1) is healthier / more current than SNPP (whose feed had stalled
// on a partial day). completeSatDate steps back TWO days from the domain's newest:
// the newest is today's still-filling composite AND even yesterday's keeps filling
// for hours after the date rolls (seen live: a missing Pacific wedge at 00:30Z).
const SAT_LAYER = "VIIRS_NOAA20_CorrectedReflectance_TrueColor";
const SAT_DOMAINS = `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/${SAT_LAYER}/default/250m/-180,-90,180,90/all.xml`;
function gibsSatUrl() {
  const iso = satDate || completeSatDate(new Date().toISOString().slice(0, 10));   // discovered latest-2, else clock-2
  return "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
    + "&LAYERS=" + SAT_LAYER + "&CRS=EPSG:4326&BBOX=-90,-180,90,180"
    + "&WIDTH=2048&HEIGHT=1024&FORMAT=image/jpeg&TIME=" + iso;
}
function loadSat() { worldSat.src = gibsSatUrl(); }
async function refreshSatDate() {
  try {
    const xml = await (await fetch(SAT_DOMAINS, { cache: "no-store" })).text();
    const dates = xml.match(/\d{4}-\d{2}-\d{2}/g);      // domain ends at today's (partial) date
    const latest = dates && dates[dates.length - 1];
    if (latest) { const complete = completeSatDate(latest); if (complete !== satDate) { satDate = complete; loadSat(); } }
  } catch { if (!satDate) loadSat(); }                  // offline: fall back to the clock-based guess
}

// ---- satellite animation: CLOUDS (GOES 10-min loop) / DAYS (daily flipbook) ----
const GOES_LAYERS = ["GOES-East_ABI_GeoColor", "GOES-West_ABI_GeoColor"];
const GOES_DOMAINS = (l) => `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/${l}/default/2km/-180,-90,180,90/all.xml`;
const ANIM_FRAMES = 12, ANIM_W = 1024, ANIM_H = 512, FLIP_DAYS = 10;
const forcedAnim = new URLSearchParams(location.search).get("anim"); // debug/screenshots
let animChoice = (() => { const v = localStorage.getItem("hcAnim"); return ["clouds", "days"].includes(v) ? v : ""; })();
function animMode() {
  const m = forcedAnim != null ? (["clouds", "days"].includes(forcedAnim) ? forcedAnim : "") : animChoice;
  return effectiveStyle() === "satellite" ? m : "";
}
let animFrames = [];        // [{t, src}] src: canvas (clouds) or Image (days)
let animIdx = 0, animKey = "", animTimer = null, animRefTimer = null;
function animFrameImg() { return animFrames.length ? animFrames[Math.min(animIdx, animFrames.length - 1)].src : null; }
const loadImg = (url) => new Promise((res, rej) => {
  const im = new Image(); im.crossOrigin = "anonymous";
  im.onload = () => res(im); im.onerror = () => rej(new Error("img " + url));
  im.src = url;
});
async function buildCloudFrames() {
  // Per-layer valid times from DescribeDomains (gap-aware); frames = union of the
  // newest stamps; each sat draws its nearest frame <= t so a lagging sat holds
  // its newest picture while the fresher one keeps moving.
  const domains = await Promise.all(GOES_LAYERS.map(async (l) => {
    try { return lastTimes(parseDomainRanges(await (await fetch(GOES_DOMAINS(l), { cache: "no-store" })).text()), 72); }
    catch { return []; }
  }));
  const times = unionTimes(domains[0], domains[1], ANIM_FRAMES);
  if (!times.length || !satReady) return { key: animKey, frames: [] };
  const key = "clouds|" + times.join(",");
  if (key === animKey) return { key, frames: animFrames };   // nothing new - keep current canvases
  const frames = [];
  for (const t of times) {                              // sequential: be gentle to GIBS
    const cv = document.createElement("canvas"); cv.width = ANIM_W; cv.height = ANIM_H;
    const cx = cv.getContext("2d");
    cx.drawImage(worldSat, 0, 0, ANIM_W, ANIM_H);       // static global base under the discs
    for (let i = 0; i < GOES_LAYERS.length; i++) {
      const ft = nearestAtOrBefore(domains[i], t);
      if (!ft) continue;
      try { cx.drawImage(await loadImg(goesUrl(GOES_LAYERS[i], ft, ANIM_W, ANIM_H)), 0, 0, ANIM_W, ANIM_H); } catch { /* hole stays base */ }
    }
    frames.push({ t, src: cv });
  }
  return { key, frames };
}
async function buildDayFrames() {
  const latest = satDate || completeSatDate(new Date().toISOString().slice(0, 10));
  const dates = flipbookDates(latest, FLIP_DAYS);
  const key = "days|" + dates.join(",");
  if (key === animKey) return { key, frames: animFrames };
  const frames = [];
  for (const d of dates) {
    try { frames.push({ t: d, src: await loadImg(viirsUrl(SAT_LAYER, d, 2048, 1024)) }); } catch { /* skip missing day */ }
  }
  return { key, frames };
}
async function refreshAnimFrames() {
  const m = animMode(); if (!m) return;
  const fresh = await (m === "clouds" ? buildCloudFrames() : buildDayFrames());
  if (fresh.frames.length && animMode() === m) {
    animFrames = fresh.frames; animKey = fresh.key;
    if (animIdx >= animFrames.length) animIdx = 0;
  }
}
function animTick() {
  if (!animMode() || animFrames.length < 2) return;
  animIdx = (animIdx + 1) % animFrames.length;
  drawMap();
}
let animRunMode = "";       // mode the timers below were started for
function syncAnim() {
  // restart timers on ANY mode change (off<->on and clouds<->days); called from syncUi()
  const m = animMode();
  if (m === animRunMode) return;
  clearInterval(animTimer); clearInterval(animRefTimer);
  animTimer = animRefTimer = null; animFrames = []; animKey = ""; animIdx = 0;
  animRunMode = m;
  if (m) {
    animTimer = setInterval(animTick, 300);
    animRefTimer = setInterval(refreshAnimFrames, m === "clouds" ? 10 * 60000 : 3600 * 1000);
    refreshAnimFrames();
  }
}

const MAP_STYLES = ["line", "terrain", "day-night", "satellite"];
const forcedStyle = new URLSearchParams(location.search).get("style"); // kiosk/screenshot debug
let styleChoice = (() => {
  const v = localStorage.getItem("hcMapStyle");
  return MAP_STYLES.includes(v) ? v : null;
})();
function effectiveStyle() {
  const want = (forcedStyle && MAP_STYLES.includes(forcedStyle)) ? forcedStyle
    : (styleChoice || data.ui?.mapStyle || "line");
  if (want === "satellite") return satReady ? "satellite" : (dayReady ? "terrain" : "line"); // GIBS not in yet
  if ((want === "terrain" || want === "day-night") && !dayReady) return "line"; // image failed -> degrade
  if (want === "day-night" && !nightReady) return "terrain";
  return want;
}
function persistStyle(s) {
  if (forcedStyle) return;
  try { localStorage.setItem("hcMapStyle", s); } catch { /* session-only */ }
}

// ---- v3 projection: equirect (v2) vs dual-hemisphere azimuthal-equidistant ----
const PROJECTIONS = ["equirect", "azimuthal"];
const forcedProj = new URLSearchParams(location.search).get("proj"); // kiosk/screenshot debug
let projChoice = (() => {
  const v = localStorage.getItem("hcMapProj");
  return PROJECTIONS.includes(v) ? v : null;
})();
function effectiveProj() {
  if (forcedProj && PROJECTIONS.includes(forcedProj)) return forcedProj;
  return projChoice || data.ui?.mapProjection || "equirect";
}
function persistProj(p) {
  if (forcedProj) return;
  try { localStorage.setItem("hcMapProj", p); } catch { /* session-only */ }
}
// In globe mode the grid-raster overlays (DRAP, aurora) are reprojected into the
// disc raster instead of drawn as vectors; MUF/foF2 contours draw fine as vectors.
const AZ_HIDDEN = new Set(["drap", "aurora"]);

// ---- overlay UI state (persisted to localStorage) ----
const ALL_IDS = listOverlays().map((o) => o.id);
// kiosk/screenshot debug: /hamclock?overlay=muf forces one overlay, AUTO off, no persistence
const forced = new URLSearchParams(location.search).get("overlay");
let enabled = loadEnabled();
let auto = loadAuto();
let locked = loadLocked();   // overlays pinned ON while AUTO cycles the rest
if (forced && ALL_IDS.includes(forced)) { enabled = new Set([forced]); auto = false; }
let active = ALL_IDS.find((id) => enabled.has(id)) || null;

function loadEnabled() {
  try {
    const raw = JSON.parse(localStorage.getItem("hcOverlays"));
    if (Array.isArray(raw)) return new Set(raw.filter((id) => ALL_IDS.includes(id)));
  } catch { /* fall through to the default set */ }
  // first-load default: a legible starting rotation (ids not yet registered are dropped)
  return new Set(["paths", "psk", "moon", "muf"].filter((id) => ALL_IDS.includes(id)));
}
function loadAuto() {
  const v = localStorage.getItem("hcAuto");
  return v == null ? true : v === "1"; // AUTO on by default
}
function loadLocked() {
  try { const raw = JSON.parse(localStorage.getItem("hcLocked")); if (Array.isArray(raw)) return new Set(raw.filter((id) => ALL_IDS.includes(id))); } catch { /* none */ }
  return new Set();
}
function persist() {
  if (forced) return; // never persist a screenshot-debug override
  try {
    localStorage.setItem("hcOverlays", JSON.stringify([...enabled]));
    localStorage.setItem("hcAuto", auto ? "1" : "0");
    localStorage.setItem("hcLocked", JSON.stringify([...locked]));
  } catch { /* storage unavailable -> session-only state */ }
}
function enabledInOrder() { return ALL_IDS.filter((id) => enabled.has(id)); }
// The overlays AUTO cycles through: enabled but NOT locked (locked ones stay on).
function cycleIds() { return enabledInOrder().filter((id) => !locked.has(id)); }
// AUTO: the locked overlays + the current cycle pick; manual: all enabled together.
function visibleIds() {
  if (!auto) return enabledInOrder();
  const pinned = enabledInOrder().filter((id) => locked.has(id));
  return active && enabled.has(active) && !locked.has(active) ? [...pinned, active] : pinned;
}
// Lock pins an overlay ON (always visible during AUTO); locking also enables it.
function toggleLock(id) {
  if (locked.has(id)) locked.delete(id);
  else { locked.add(id); enabled.add(id); }
  if (auto && !cycleIds().includes(active)) active = cycleIds()[0] || null;
  persist(); syncUi();
}
function rcFor(W, H) {
  const wp = webPsk();
  return {
    W, H, project, data, layers, station: data.station, now: new Date(), satlib, bounds,
    pskColorBy: pskColorBy(), pskDirection: wp.direction, pskMode: wp.mode, pskBand: wp.band,
    moonTex: moonReady ? moonTex : null,   // reuse the same loaded Image the moon tile uses
  };
}

// ---- v3 tile row: order from localStorage override > config ui.tileOrder > registry ----
function loadTileOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem("hcTileOrder"));
    if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) return raw;
  } catch { /* fall through */ }
  return null;
}
function loadHiddenTiles() {
  try {
    const raw = JSON.parse(localStorage.getItem("hcTilesHidden"));
    if (Array.isArray(raw)) return new Set(raw.filter((x) => typeof x === "string"));
  } catch { /* fall through */ }
  return new Set();
}
let hiddenTiles = loadHiddenTiles();
function persistHiddenTiles() {
  try { localStorage.setItem("hcTilesHidden", JSON.stringify([...hiddenTiles])); }
  catch { /* storage unavailable -> session-only */ }
}
function tileData() {
  return {
    spacewx: data.spacewx, weather: data.weather, station: data.station,
    bands: data.solar?.bands || {},
    now: new Date(),
    sunImg: sunReady ? sunImg : null,
    sunLabel: curSunView().short, sunAttr: curSunView().attr,
    moonTex: moonReady ? moonTex : null,
    sstvImg: sstvReady ? sstvImg : null,
    bandsImg: STANDALONE && bandsReady ? bandsImg : null,
    ssnAttr: STANDALONE ? "NOAA SWPC" : null,   // web SSN comes from NOAA daily indices, not SILSO
    psk: layers.psk?.reports || [],
  };
}
// Hover-tooltip copy: what each card / map control is showing.
const TILE_INFO = {
  ssn: "Sunspot Number (SILSO / Royal Obs. Belgium): today's count plus a ~40-day trend. Higher = more solar activity and generally better HF.",
  flux: "10.7 cm Solar Flux (NOAA SWPC): the classic propagation index. Under 70 is poor, 100-150 good, 150+ excellent for the high bands.",
  kp: "Planetary Kp (NOAA SWPC): geomagnetic activity 0-9 over the last 7 days. Green = quiet/good; red (5+) = a geomagnetic storm that degrades HF.",
  xray: "GOES X-ray flux (NOAA SWPC): solar flare class A/B quiet, then C, M, X. M and X flares cause HF radio blackouts on the daylit side.",
  bands: "HF band conditions (hamqsl): Good / Fair / Poor for each band group, Day vs Night. A quick read on what's open now.",
  sun: "Live image of the Sun from NASA's Solar Dynamics Observatory (HMI), refreshed about every 15 minutes. The dark specks are real sunspots.",
  wx: "Local weather at your station (open-meteo): temperature, sky, humidity and wind.",
  beacons: "NCDXF/IARU beacon network: which of the 18 worldwide beacons is transmitting on each band right now (10-second cycle). Hear it = that band is open to that region.",
  moon: "Moon phase (percent illuminated) plus its azimuth and elevation from your grid - handy for EME or just tracking the moon.",
  spots: "Live PSK Reporter activity tallied by band - a real-time gauge of which bands are busy.",
  sstv: "The latest SSTV image received at W4EWB (auto-published to the GitHub RX gallery); refreshes about once a minute.",
};
const OVERLAY_INFO = {
  paths: "Great-circle paths from your station to each spotted DX station, colored by band (legend in the side panel).",
  grayline: "Grayline: highlights the day/night terminator, where HF propagation is often enhanced around sunrise and sunset. Side panel shows your sunrise/sunset times.",
  muf: "Maximum Usable Frequency (KC2G): colored contours of the highest frequency the ionosphere is bending back to earth.",
  fof2: "foF2 critical frequency (KC2G): teal dashed contours of the highest frequency reflected straight up — your NVIS/short-skip ceiling (MUF is roughly 3× this for long paths).",
  drap: "D-Region Absorption Prediction (NOAA SWPC): shading where solar X-rays are absorbing HF on the daylit side.",
  aurora: "Aurora nowcast (NOAA SWPC OVATION): green shading shows where the aurora is active right now — auroral absorption degrades HF near the poles, but the oval can also enable VHF aurora scatter.",
  sats: "Amateur satellites: current position and footprint circle. The side panel lists the next pass — or, when a bird is overhead now, its live elevation/azimuth and Doppler shift.",
  moon: "Plots the Moon on the map at its sub-lunar point; phase and az/el show in the side panel.",
  psk: "PSK Reporter: who is hearing your station right now, plotted at the receivers' locations.",
  beacons: "Plots all 18 NCDXF beacons on the map and highlights the ones transmitting now.",
  boundaries: "Political boundaries: country border lines (Natural Earth). Combines with any basemap — e.g. borders over the live satellite view.",
  citylights: "City Lights: NASA Black Marble night-lights glow on the dark side, over any basemap. Lock it on to keep it while Auto cycles.",
  __auto: "Auto-rotate: cycles hands-free through the overlays you've turned on. Lock (🔒) an overlay to keep it visible the whole time.",
};
const CTRL_INFO = {
  line: "Line map: dark vector coastlines - fastest and least busy.",
  terrain: "Terrain: NASA Blue Marble satellite imagery as the basemap.",
  "day-night": "Day / Night: Blue Marble by day plus Black Marble city-lights on the night side, split at the terminator.",
  satellite: "Satellite: NASA GIBS global true-color mosaic (VIIRS) — the latest complete day of real cloud cover, updated daily.",
  equirect: "Flat (equirectangular): the standard rectangular world map.",
  azimuthal: "Globe: a real WebGL 3D sphere, sun-lit with true day/night. Drag to rotate, SPIN to auto-rotate, HOME to re-center on your station.",
  anim: "Animate the satellite view: CLOUDS loops the last two hours of 10-minute NOAA GOES imagery (western hemisphere); DAYS flips through the last 10 days of global mosaics.",
};

let lastTilesH = -1;
function renderTiles() {
  const host = $("hcTiles"); if (!host) return;
  const known = listTiles();
  const saved = (loadTileOrder() || data.ui?.tileOrder || known).filter((id) => known.includes(id));
  const order = [...saved, ...known.filter((id) => !saved.includes(id))];   // append any new tiles
  const want = order.filter((id) => !hiddenTiles.has(id) && !(id === "sstv" && !sstvUrl()));
  for (const el of [...host.querySelectorAll("canvas.hcTile")]) {
    if (!want.includes(el.dataset.id)) el.remove();
  }
  // Tiles render at (up to) their natural size and flow in as FEW rows as fit, so
  // hiding cards shrinks the header (fewer rows) and hands that space to the map -
  // instead of stretching the survivors ever wider/taller. Aspect from TILE_W/H.
  const GAP = 8, ASPECT = TILE_W / TILE_H;
  const avail = host.clientWidth || (TILE_W * 5);
  const n = want.length || 1;
  // Tile SIZE depends only on the available width, never on the count, so the row
  // stays the same size whether 10 cards show or 3 (fewer tiles don't balloon).
  // `perRow` natural-width tiles fill the row; fewer tiles just use fewer columns
  // and rows, freeing vertical space for the map. CSS grid pins exactly `cols`
  // per row so both rows stay uniform (flexbox would squeeze in an extra one).
  const REF = 200;   // target column width: sets tiles-per-full-row (count-independent)
  const perRow = Math.max(1, Math.floor((avail + GAP) / (REF + GAP)));
  const tileW = Math.max(120, Math.floor((avail - (perRow - 1) * GAP) / perRow));
  const rows = Math.ceil(n / perRow);
  const cols = Math.max(1, Math.ceil(n / rows));
  // Height: a reduced number of rows grows TALLER to fill the vertical band the
  // full set would occupy (capped at 2 rows) - so a single row uses the freed
  // vertical space instead of sitting short. Width stays constant (no sideways
  // ballooning); 2+ rows keep their natural height.
  const naturalH = Math.round(tileW / ASPECT);
  const bandRows = Math.min(2, Math.max(1, Math.ceil(known.length / perRow)));
  const bandH = bandRows * naturalH + (bandRows - 1) * GAP;
  const tileH = Math.max(naturalH, Math.round((bandH - (rows - 1) * GAP) / rows));
  host.style.display = noCards ? "none" : "grid";
  host.style.gridTemplateColumns = `repeat(${cols}, ${tileW}px)`;
  host.style.gap = `${GAP}px`;
  host.style.justifyContent = "center";
  host.style.alignContent = "flex-start";
  const td = tileData();
  for (const id of want) {
    let el = host.querySelector(`canvas.hcTile[data-id="${id}"]`); // ids are our own registry strings
    if (!el) {
      el = document.createElement("canvas");
      el.className = "hcTile";
      el.dataset.id = id;
      el.dataset.info = (TILE_INFO[id] || "") + " (Double-click to hide; drag to reorder.)";
      el.addEventListener("dblclick", () => { hiddenTiles.add(id); persistHiddenTiles(); renderView(); renderTiles(); });
      el.draggable = true;
      el.addEventListener("dragstart", (e) => { dragTileId = id; e.dataTransfer.effectAllowed = "move"; el.style.opacity = "0.4"; });
      el.addEventListener("dragend", () => { el.style.opacity = ""; dragTileId = null; });
      el.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
      el.addEventListener("drop", (e) => { e.preventDefault(); if (dragTileId && dragTileId !== el.dataset.id) reorderTiles(dragTileId, el.dataset.id); });
    }
    el.style.width = tileW + "px";
    el.style.height = tileH + "px";
    host.appendChild(el);            // appendChild also reorders an existing node
    drawTile(id, el, td, tileW, tileH);
  }
  // (restore-hidden control lives in the #hcView chip row now, so it never adds a
  // grid cell that would change the tile row's height)
  // Hiding/showing cards changes the header height; hand the delta to the map so
  // fewer tiles => a bigger map (covers dblclick-hide, restore, and the picker).
  const nowH = host.offsetHeight;
  if (nowH !== lastTilesH) { lastTilesH = nowH; requestAnimationFrame(() => drawMap()); }
}

function project(lon, lat, W, H) { return { x: (lon + 180) / 360 * W, y: (90 - lat) / 180 * H }; }

// Drag-to-reorder the header data cards; the new order persists to hcTileOrder.
let dragTileId = null;
function reorderTiles(fromId, toId) {
  const known = listTiles();
  let ord = (loadTileOrder() || data.ui?.tileOrder || known).filter((x) => known.includes(x));
  ord = ord.filter((x) => x !== fromId);
  const idx = ord.indexOf(toId);
  ord.splice(idx < 0 ? ord.length : idx, 0, fromId);
  try { localStorage.setItem("hcTileOrder", JSON.stringify(ord)); } catch { /* session-only */ }
  renderTiles();
}

// ---- personalization (all localStorage-backed; edited in the settings panel) ----
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* session-only */ } };
let customCall = lsGet("hcCall", "").trim();
let timeFmt = lsGet("hcTimeFmt", "24") === "12" ? "12" : "24";     // local clock: 24-hour vs 12-hour
let autoSec = Math.max(3, Math.min(120, +lsGet("hcAutoSec", 15) || 15));   // AUTO overlay-cycle period
let spinRate = Math.max(0.2, Math.min(4, +lsGet("hcSpinRate", 1) || 1));   // globe auto-rotate deg/tick
function stationCall() { return (customCall || data.station?.call || "W4EWB").toUpperCase(); }
function applyCall() {
  const c = stationCall();
  const hdr = document.querySelector(".hcCall"); if (hdr) hdr.textContent = c;
  const de = $("hcDeTitle"); if (de) de.textContent = "DE — " + c;
}

// ---- map zoom + pan (scroll to zoom toward the cursor, drag to pan) ----
let mapZoom = 1, mapPanX = 0, mapPanY = 0;
function clampMap() {
  const c = $("hcMap"); if (!c) return;
  if (mapZoom <= 1) { mapZoom = 1; mapPanX = 0; mapPanY = 0; return; }
  mapZoom = Math.min(6, mapZoom);
  const W = c.clientWidth, H = c.clientHeight;
  mapPanX = Math.min(0, Math.max(W * (1 - mapZoom), mapPanX));
  mapPanY = Math.min(0, Math.max(H * (1 - mapZoom), mapPanY));
}

// ---- globe rotation (azimuthal view): drag to spin, or slow auto-rotate ----
// Rotation is an offset from the station-centered "home" view. The rendered
// center is quantized to whole degrees so the terrain raster and the vector
// overlays always agree and the raster only rebuilds on a degree step (bounds
// the per-pixel reproject cost during a spin). Home = station, offsets = 0.
let globeRotLon = 0, globeRotLat = 0, globeSpin = false, globeGrab = false, globeSingle = false;
try { globeSpin = localStorage.getItem("hcSpin") === "1"; globeSingle = localStorage.getItem("hcGlobeSingle") === "1"; } catch { /* defaults off */ }
function globeCenter(exact) {
  const st = data.station || {};
  let lat = (Number(st.lat) || 0) + globeRotLat;
  let lon = (Number(st.lon) || 0) + globeRotLon;
  lat = Math.max(-90, Math.min(90, lat));
  lon = ((lon + 180) % 360 + 360) % 360 - 180;      // wrap into [-180, 180)
  // exact = fractional (WebGL globe rotates smoothly); rounded = for the 2D
  // raster fallback, whose per-pixel reproject is cached per whole-degree step.
  return exact ? { lat, lon } : { lat: Math.round(lat), lon: Math.round(lon) };
}
const globeHome = () => globeRotLon === 0 && globeRotLat === 0;

// ---- view controls: per-card picker, hide the whole row, bigger map ----
let bigMap = false, noCards = false, cardMenuOpen = false;
try { bigMap = localStorage.getItem("hcBig") === "1"; noCards = localStorage.getItem("hcNoCards") === "1"; } catch { /* defaults */ }
const CARD_NAMES = { ssn: "Sunspots", flux: "Solar Flux", kp: "Kp Index", xray: "X-ray", bands: "Band Cond", sun: "Sun Image", wx: "Weather", beacons: "Beacons", moon: "Moon", spots: "PSK Bands", sstv: "SSTV RX" };
function applyView() {
  const hc = $("hc"); if (!hc) return;
  hc.classList.toggle("hcBig", bigMap);
  hc.classList.toggle("hcNoCards", noCards);
}
function renderView() {
  const el = $("hcView"); if (!el) return;
  el.innerHTML =
    `<button class="hcChip${settingsOpen ? " on" : ""}" data-view="settings" data-info="Settings: show/hide cards, map overlays, and the Sun image.">&#9881; SETTINGS</button>`
    + `<button class="hcChip${aboutOpen ? " on" : ""}" data-view="about" data-info="What everything on this page means, and how to set it up.">&#9432; ABOUT</button>`
    + (effectiveProj() === "azimuthal"
      ? `<button class="hcChip${globeSpin ? " on" : ""}" data-view="spin" data-info="Slowly auto-rotate the globe. Grab it with the mouse to steer; release to keep spinning from there.">${globeSpin ? "&#9210; SPINNING" : "&#8635; SPIN"}</button>`
        + (!globeHome() ? `<button class="hcChip" data-view="home" data-info="Re-center the globe on your station.">&#8962; HOME</button>` : "")
      : "")
    + (mapZoom > 1.01 ? `<button class="hcChip" data-view="reset" data-info="Reset the map zoom and pan.">RESET ${mapZoom.toFixed(1)}&times;</button>` : "");
}
let settingsOpen = false, aboutOpen = false;
function renderAbout() {
  const el = $("hcAbout"); if (!el) return;
  el.style.display = aboutOpen ? "block" : "none";
  if (!aboutOpen) return;
  const sec = (title, html) => `<div class="hcSetSec"><h4>${title}</h4><div class="hcAboutBody">${html}</div></div>`;
  el.innerHTML =
    `<div class="hcSetHead"><span>About HamClock${STANDALONE ? " Web" : ""}</span><button class="hcSetX" data-view="about" title="close">&times;</button></div>`
    + sec("What is this?",
      `A ham-shack clock and propagation dashboard: live space weather, DX activity, and where <em>your</em> signal is landing — on a world map or a 3D globe. `
      + `Inspired by <b>HamClock</b> by Elwood Downey, WB0OEW (SK) — an independent, from-scratch implementation carrying the idea forward.`
      + (STANDALONE ? ` It runs 100% in your browser: no install, no server, no account. Your settings stay in this browser only.` : ""))
    + sec("Quick start",
      `<b>1.</b> Open <b>&#9881; Settings</b> and enter your <b>callsign</b> and 4&ndash;6 character <b>grid square</b> (e.g. EM78). Your grid drives the map center, weather, and sunrise/sunset.<br>`
      + `<b>2.</b> Pick your map: LINE / TERRAIN / DAY-NITE / SATELLITE (yesterday's real clouds from NASA), and FLAT vs GLOBE (a real 3D globe &mdash; drag to spin, SPIN to auto-rotate, HOME to re-center).<br>`
      + `<b>3.</b> Turn on the overlays you like. That's it &mdash; everything refreshes itself.`)
    + sec("The PSK Reporter layer (your signal!)",
      `The glowing lines are <b>real reception reports</b> from the PSK Reporter network.<br>`
      + `&bull; <b>Who hears me</b> &mdash; receivers that actually decoded <em>your</em> transmissions (FT8, VarAC, etc.). This is measured propagation from your antenna.<br>`
      + `&bull; <b>What I hear</b> &mdash; stations your own monitor reported hearing.<br>`
      + `&bull; <b>Window</b>: how far back to look (15 min to 24 h). Long windows show your whole day's reach.<br>`
      + `&bull; <b>Colors</b>: by band (matches the Paths legend), by mode (FT8, FT4, VARA, SSTV, CW&hellip;), or mono.<br>`
      + `&bull; The <b>MODE</b> readout in the header is the mode of your newest report &mdash; transmit for a couple of minutes and it appears. Queries respect pskreporter.info's 5-minute rule; adding your email in settings is good etiquette.`)
    + sec("Overlays",
      `<b>Paths</b>: DX cluster spots (stations active worldwide) drawn as great circles from your QTH &mdash; the bearing you'd use to work them, colored by band. `
      + `<b>Grayline</b>: the day/night terminator, where HF often peaks. <b>MUF / foF2</b>: ionosphere ceilings (KC2G). <b>DRAP</b>: solar X-ray absorption. `
      + `<b>Aurora</b>: NOAA's oval nowcast. <b>Sats</b>: amateur satellites + next pass. <b>Moon</b>: sub-lunar point, az/el for EME. <b>Beacons</b>: the 18 NCDXF beacons, live slots. `
      + `<b>Borders</b> and <b>City Lights</b> dress any basemap.<br>`
      + `<b>AUTO</b> cycles your enabled overlays; the <b>&#128274; lock</b> beside each one pins it on while the rest rotate.`)
    + sec("Cards",
      `The top row: sunspots + solar flux (higher = better HF), Kp (5+ = geomagnetic storm), GOES X-ray (M/X flares = daytime blackouts), `
      + `band conditions, live Sun imagery (pick a wavelength in settings), weather at your QTH, NCDXF beacon schedule, Moon, and live PSK spot counts. `
      + `Drag cards to reorder; double-click to hide; the settings panel restores them.`)
    + sec("Data sources",
      `DX: SpotHole &middot; Space wx: NOAA SWPC &middot; MUF/foF2: KC2G &middot; RX reports: PSKReporter.info &middot; TLEs: CelesTrak &middot; `
      + `WX: open-meteo &middot; Band conditions: hamqsl.com (N0NBH) &middot; Sun: NASA SDO &middot; Satellite map: NASA GIBS &middot; Basemaps: NASA Blue/Black Marble &middot; Borders: Natural Earth.`
      + (STANDALONE ? `<br>Privacy: static page; your callsign/grid live in this browser and are only sent to the services above on your behalf.` : ""))
    + `<div class="hcSetSec"><div class="hcAboutBody" style="color:#6b7a99">73 &mdash; and thank you, Elwood. <b>W4EWB</b></div></div>`;
}
function renderSettings() {
  const el = $("hcSettings"); if (!el) return;
  el.style.display = settingsOpen ? "block" : "none";
  if (!settingsOpen) return;
  const cardRows = listTiles().map((id) =>
    `<button class="hcSetOpt${hiddenTiles.has(id) ? "" : " on"}" data-card="${esc(id)}">${esc(CARD_NAMES[id] || id)}</button>`).join("");
  const ovRows = listOverlays().map((o) =>
    `<div class="hcSetRow">`
    + `<button class="hcSetOpt hcSetRowMain${enabled.has(o.id) ? " on" : ""}" data-id="${esc(o.id)}">${esc(o.label)}</button>`
    + `<button class="hcSetLock${locked.has(o.id) ? " on" : ""}" data-lock="${esc(o.id)}" title="Lock on: stays visible while Auto cycles the rest">&#128274;</button>`
    + `</div>`).join("");
  const sunRows = SUN_VIEWS.map((v) =>
    `<button class="hcSetOpt${sunView === v.id ? " on" : ""}" data-sun="${esc(v.id)}">${esc(v.label)}</button>`).join("");
  const timeBtns = [["24", "24-hour"], ["12", "12-hour"]].map(([v, l]) =>
    `<button class="hcSetOpt${timeFmt === v ? " on" : ""}" data-time="${v}">${l}</button>`).join("");
  const autoBtns = [5, 10, 15, 30, 60].map((v) =>
    `<button class="hcSetOpt${autoSec === v ? " on" : ""}" data-auto="${v}">${v}s</button>`).join("");
  const spinBtns = [["0.4", "Slow"], ["1", "Medium"], ["2", "Fast"]].map(([v, l]) =>
    `<button class="hcSetOpt${Math.abs(spinRate - +v) < 0.05 ? " on" : ""}" data-spin="${v}">${l}</button>`).join("");
  const st = STANDALONE ? webStation() : null;
  const stationRows = STANDALONE
    ? `<div class="hcSetLbl">Grid square (QTH)</div>`
      + `<input class="hcSetInput" data-grid type="text" maxlength="6" placeholder="EM78" value="${esc(lsGet("hcGrid", ""))}">`
      + `<div class="hcSetHint">${st.grid} &rarr; ${st.lat.toFixed(2)}, ${st.lon.toFixed(2)} &middot; drives map, weather, sun times</div>`
    : "";
  const pskCfg = webPsk(), pskCol = pskColorBy();
  const pskSec = `<div class="hcSetSec"><h4>PSK Reporter</h4>`
    + `<div class="hcSetLbl">Direction</div><div class="hcSetChips">`
      + `<button class="hcSetOpt${pskCfg.direction === "sender" ? " on" : ""}" data-pskdir="sender">Who hears me</button>`
      + `<button class="hcSetOpt${pskCfg.direction === "receiver" ? " on" : ""}" data-pskdir="receiver">What I hear</button></div>`
    + `<div class="hcSetLbl">Window</div><div class="hcSetChips">`
      + [[15, "15m"], [30, "30m"], [60, "1h"], [360, "6h"], [1440, "24h"]].map(([m, l]) =>
          `<button class="hcSetOpt${pskCfg.windowSec === m * 60 ? " on" : ""}" data-pskmin="${m}">${l}</button>`).join("") + `</div>`
    + `<div class="hcSetLbl">Mode</div><div class="hcSetChips">`
      + ["", "FT8", "FT4", "CW", "JS8", "VARAC", "WSPR", "SSTV", "RTTY", "PSK"].map((m) =>
          `<button class="hcSetOpt${(pskCfg.mode || "") === m ? " on" : ""}" data-pskmode="${m}">${m || "All"}</button>`).join("") + `</div>`
    + `<div class="hcSetLbl">Band</div><div class="hcSetChips">`
      + ["", "160m", "80m", "40m", "30m", "20m", "17m", "15m", "12m", "10m", "6m", "2m"].map((b) =>
          `<button class="hcSetOpt${(pskCfg.band || "") === b ? " on" : ""}" data-pskband="${b}">${b || "All"}</button>`).join("") + `</div>`
    + `<div class="hcSetLbl">Color lines by</div><div class="hcSetChips">`
      + [["band", "Band"], ["mode", "Mode"], ["mono", "Mono"]].map(([v, l]) =>
          `<button class="hcSetOpt${pskCol === v ? " on" : ""}" data-pskcolor="${v}">${l}</button>`).join("") + `</div>`
    + `<div class="hcSetLbl">Contact email (PSKReporter etiquette)</div>`
    + `<input class="hcSetInput hcSetUrl" data-pskmail type="text" maxlength="80" placeholder="you@example.com" value="${esc(lsGet("hcPskContact", ""))}">`
    + `</div>`;
  el.innerHTML =
    `<div class="hcSetHead"><span>Settings</span><button class="hcSetX" data-view="settings" title="close">&times;</button></div>`
    + `<div class="hcSetSec"><h4>${STANDALONE ? "Station" : "Display"}</h4>`
      + `<input class="hcSetInput" data-call type="text" maxlength="12" placeholder="Callsign" value="${esc(customCall)}">`
      + stationRows
      + `<div class="hcSetLbl">Local time</div><div class="hcSetChips">${timeBtns}</div>`
      + `<div class="hcSetLbl">Auto-cycle every</div><div class="hcSetChips">${autoBtns}</div>`
      + `<div class="hcSetLbl">Globe spin</div><div class="hcSetChips">${spinBtns}</div>`
      + `<div class="hcSetLbl">SSTV image URL${STANDALONE ? " (blank = hide tile)" : ""}</div>`
      + `<input class="hcSetInput hcSetUrl" data-sstvurl type="text" maxlength="300" placeholder="https://..." value="${esc(lsGet("hcSstvUrl", ""))}"></div>`
    + pskSec
    + `<div class="hcSetSec"><h4>View</h4><div class="hcSetGrid">`
      + `<button class="hcSetOpt${!noCards ? " on" : ""}" data-view="cards">Card row</button>`
      + `<button class="hcSetOpt${bigMap ? " on" : ""}" data-view="big">Bigger map</button></div></div>`
    + `<div class="hcSetSec"><h4>Cards<button class="hcSetAll" data-card="__all">${hiddenTiles.size ? "show all" : "hide all"}</button></h4><div class="hcSetGrid">${cardRows}</div></div>`
    + `<div class="hcSetSec"><h4>Map overlays</h4>`
      + `<button class="hcSetOpt hcSetAuto${auto ? " on" : ""}" data-id="__auto" style="width:100%;margin-bottom:6px">${auto ? "AUTO cycle · on" : "AUTO cycle · off"}</button>`
      + `<div class="hcSetList">${ovRows}</div></div>`
    + `<div class="hcSetSec"><h4>Sun image</h4><div class="hcSetList">${sunRows}</div></div>`;
}

function drawLand(ctx, W, H) {
  ctx.fillStyle = "#12305a"; ctx.strokeStyle = "#1f4e86"; ctx.lineWidth = 0.6;
  for (const f of (land?.features || [])) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        ctx.beginPath();
        ring.forEach(([lon, lat], i) => { const p = project(lon, lat, W, H); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
  }
}

function nightPath(ctx, sub, W, H) {
  const southPole = sub.lat >= 0;   // the pole in full night is opposite the subsolar hemisphere
  ctx.beginPath();
  for (let px = 0; px <= W; px += 3) {
    const lon = px / W * 360 - 180;
    const { y } = project(lon, terminatorLat(lon, sub), W, H);
    px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
  }
  ctx.lineTo(W, southPole ? H : 0);
  ctx.lineTo(0, southPole ? H : 0);
  ctx.closePath();
}

function drawNight(ctx, sub, W, H) {
  nightPath(ctx, sub, W, H);
  ctx.fillStyle = "rgba(3,6,16,0.60)"; ctx.fill();
}

// Base layer under all overlays/markers, by style. Never blanks: any missing
// image already degraded inside effectiveStyle().
function drawBase(ctx, W, H, style, sub) {
  if (style === "satellite") {
    const fr = animMode() ? animFrameImg() : null;
    ctx.drawImage(fr || worldSat, 0, 0, W, H);   // live loop frame, else static mosaic
    if (!animMode()) drawNight(ctx, sub, W, H);  // GOES GeoColor already carries real day/night
    return;
  }
  if (style === "terrain") {
    ctx.drawImage(worldDay, 0, 0, W, H);
    drawNight(ctx, sub, W, H);
    return;
  }
  if (style === "day-night") {
    ctx.drawImage(worldDay, 0, 0, W, H);
    ctx.save();
    nightPath(ctx, sub, W, H);
    ctx.clip();
    ctx.drawImage(worldNight, 0, 0, W, H);    // night-lights inside the terminator
    ctx.fillStyle = "rgba(3,6,16,0.25)";      // slight darkening for marker contrast
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    return;
  }
  ctx.fillStyle = "#0a1020"; ctx.fillRect(0, 0, W, H);  // line (v2 look)
  drawLand(ctx, W, H);
  drawNight(ctx, sub, W, H);
}

// ---- v3 azimuthal rendering: two discs (DE + antipode), vector layers only ----
function azProjector(centerLat, centerLon, cx, cy, R) {
  const scale = R / (Math.PI / 2);   // hemisphere edge (c = pi/2) lands on the rim
  return (lon, lat) => {
    const a = azimuthal(lat, lon, centerLat, centerLon);
    return { x: cx + a.x * scale, y: cy - a.y * scale, front: a.front };
  };
}

// Split [[lon,lat],...] into runs of consecutive front-hemisphere points.
function frontSegments(points, projFn) {
  const segs = [];
  let cur = [];
  for (const pt of points || []) {
    const p = projFn(pt[0], pt[1]);
    if (p.front) cur.push(p);
    else if (cur.length) { segs.push(cur); cur = []; }
  }
  if (cur.length) segs.push(cur);
  return segs;
}

function strokeFront(ctx, points, projFn) {
  for (const seg of frontSegments(points, projFn)) {
    if (seg.length < 2) continue;
    ctx.beginPath();
    seg.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
  }
}

// ---- globe raster resampler: reproject the flat basemap + grid overlays
// (terrain/day-night + DRAP + aurora) onto each hemisphere disc, per pixel. The
// flat raster and the two reprojected discs are cached and rebuilt only when an
// input changes (size / style / minute / layer update), so pan/zoom stays smooth.
const FR_W = 1024, FR_H = 512;
let flatRasterCv = null;
const discCv = [null, null];
let reprojKey = null;
function buildFlatRaster(style, sub) {
  if (!flatRasterCv) { flatRasterCv = document.createElement("canvas"); flatRasterCv.width = FR_W; flatRasterCv.height = FR_H; }
  const fx = flatRasterCv.getContext("2d");
  fx.setTransform(1, 0, 0, 1, 0, 0);
  fx.clearRect(0, 0, FR_W, FR_H);
  drawBase(fx, FR_W, FR_H, style, sub);                                       // basemap + day/night, flat
  const flatRc = { W: FR_W, H: FR_H, project: (lon, lat) => ({ x: (lon + 180) / 360 * FR_W, y: (90 - lat) / 180 * FR_H }), layers, data, station: data.station, now: new Date(), satlib };
  for (const id of ["drap", "aurora"]) if (visibleIds().includes(id)) drawOverlay(id, fx, flatRc);
  return flatRasterCv;
}
function reprojectDisc(flatData, R, centerLat, centerLon, i) {
  const size = 2 * R + 1;
  if (!discCv[i]) discCv[i] = document.createElement("canvas");
  const cv = discCv[i]; cv.width = size; cv.height = size;
  const dctx = cv.getContext("2d");
  const out = dctx.createImageData(size, size);
  const od = out.data, fd = flatData.data, scale = R / (Math.PI / 2), R2 = R * R;
  for (let dy = -R; dy <= R; dy++) {
    const ay = -dy / scale;
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R2) continue;
      const ll = azimuthalInverse(dx / scale, ay, centerLat, centerLon);
      let sx = ((ll.lon + 180) / 360 * FR_W) | 0; if (sx < 0) sx = 0; else if (sx >= FR_W) sx = FR_W - 1;
      let sy = ((90 - ll.lat) / 180 * FR_H) | 0; if (sy < 0) sy = 0; else if (sy >= FR_H) sy = FR_H - 1;
      const si = (sy * FR_W + sx) << 2, di = ((dy + R) * size + (dx + R)) << 2;
      od[di] = fd[si]; od[di + 1] = fd[si + 1]; od[di + 2] = fd[si + 2]; od[di + 3] = fd[si + 3];
    }
  }
  dctx.putImageData(out, 0, 0);
}
function ensureGlobeRaster(W, H, R, style, sub, discs) {
  const key = `${W}x${H}|${R}|${discs.length}|${style}|${discs[0].lat},${discs[0].lon}|${Math.floor(sub.lon)},${Math.floor(sub.lat)}|${layers.drap?.updated || ""}|${layers.aurora?.updated || ""}|${visibleIds().filter((id) => AZ_HIDDEN.has(id)).join(",")}|${dayReady}${nightReady}${satReady}`;
  if (key === reprojKey && discs.every((_, i) => discCv[i])) return;
  const flatData = buildFlatRaster(style, sub).getContext("2d").getImageData(0, 0, FR_W, FR_H);
  discs.forEach((d, i) => reprojectDisc(flatData, R, d.lat, d.lon, i));
  reprojKey = key;
}

// Sphere shading: a soft blue atmosphere ring around the limb, then (over the
// disc content) a radial gradient lit from the upper-left with a bright highlight
// and a dark limb - turns the flat disc into a lit ball.
function atmosphere(ctx, cx, cy, R) {
  const g = ctx.createRadialGradient(cx, cy, R * 0.93, cx, cy, R * 1.15);
  g.addColorStop(0, "rgba(96,156,255,0)");
  g.addColorStop(0.55, "rgba(96,156,255,0.17)");
  g.addColorStop(1, "rgba(96,156,255,0)");
  ctx.save(); ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.15, 0, 2 * Math.PI); ctx.fill(); ctx.restore();
}
function shadeGlobe(ctx, cx, cy, R) {   // call inside the disc clip
  const g = ctx.createRadialGradient(cx - R * 0.34, cy - R * 0.40, R * 0.05, cx, cy, R * 1.03);
  g.addColorStop(0, "rgba(255,255,255,0.18)");
  g.addColorStop(0.38, "rgba(255,255,255,0)");
  g.addColorStop(0.72, "rgba(0,0,0,0.12)");
  g.addColorStop(1, "rgba(0,0,0,0.64)");
  ctx.fillStyle = g; ctx.fillRect(cx - R, cy - R, 2 * R + 1, 2 * R + 1);
}
function drawAzimuthal(ctx, W, H) {
  ctx.fillStyle = "#05070d"; ctx.fillRect(0, 0, W, H);
  const ctr = globeCenter();                    // station + rotation offset (quantized)
  const deLat = ctr.lat, deLon = ctr.lon;
  const antiLon = deLon > 0 ? deLon - 180 : deLon + 180;
  const home = globeHome();
  // Single globe: one large disc centered on the map. Dual: DE + antipode side by side.
  const R = (globeSingle ? Math.min(W / 2, H / 2) : Math.min(W / 4, H / 2)) - 16;
  const discs = globeSingle
    ? [{ lat: deLat, lon: deLon, cx: W / 2, cy: H / 2, label: home ? "DE" : "CENTER" }]
    : [
        { lat: deLat, lon: deLon, cx: W / 4, cy: H / 2, label: home ? "DE" : "CENTER" },
        { lat: -deLat, lon: antiLon, cx: (3 * W) / 4, cy: H / 2, label: "ANTIPODE" },
      ];
  const sub = subsolarPoint(new Date());
  const now = new Date();
  ctx.font = "10px ui-monospace, monospace";
  const style = effectiveStyle();
  ensureGlobeRaster(W, H, R, style, sub, discs);
  discs.forEach((d, i) => {
    const projFn = azProjector(d.lat, d.lon, d.cx, d.cy, R);
    atmosphere(ctx, d.cx, d.cy, R);           // blue rim glow behind the sphere
    ctx.save();
    ctx.beginPath(); ctx.arc(d.cx, d.cy, R, 0, 2 * Math.PI); ctx.clip();
    // reprojected raster: basemap (terrain/day-night) + DRAP/aurora grids
    if (discCv[i]) ctx.drawImage(discCv[i], d.cx - R, d.cy - R, 2 * R + 1, 2 * R + 1);
    if (style === "line") {   // crisp coastlines over the plain line basemap
      ctx.strokeStyle = "#1f4e86"; ctx.lineWidth = 0.7;
      for (const f of (land?.features || [])) {
        const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const poly of polys) for (const ring of poly) strokeFront(ctx, ring, projFn);
      }
    }
    // graticule: meridians every 45 deg + equator
    ctx.strokeStyle = "rgba(125,216,125,0.10)"; ctx.lineWidth = 0.5;
    for (let lon = -180; lon < 180; lon += 45) {
      strokeFront(ctx, Array.from({ length: 61 }, (_, i) => [lon, -90 + i * 3]), projFn);
    }
    strokeFront(ctx, Array.from({ length: 121 }, (_, i) => [-180 + i * 3, 0]), projFn);
    // day/night terminator point-set
    ctx.strokeStyle = "rgba(232,163,61,0.5)"; ctx.lineWidth = 1;
    strokeFront(ctx, Array.from({ length: 121 }, (_, i) => {
      const lon = -180 + i * 3;
      return [lon, terminatorLat(lon, sub)];
    }), projFn);
    // vector overlays via the shared registry (rc.project remapped to this disc;
    // back-hemisphere points vanish outside the clip; DRAP/aurora are in the raster)
    const rc = { ...rcFor(W, H), project: (lon, lat) => projFn(lon, lat) };
    drawOverlaysZ(ctx, rc, AZ_HIDDEN);
    shadeGlobe(ctx, d.cx, d.cy, R);           // limb darkening + highlight over the terrain/paths
    // markers (front hemisphere only)
    const mk = (lon, lat, color, r) => {
      const p = projFn(lon, lat);
      if (!p.front) return null;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();
      return p;
    };
    const sp = mk(sub.lon, sub.lat, "#ffd23d", 6);
    if (sp) { ctx.strokeStyle = "#ffd23d"; ctx.beginPath(); ctx.arc(sp.x, sp.y, 10, 0, 2 * Math.PI); ctx.stroke(); }
    for (const s of data.spots) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
      const p = mk(s.lon, s.lat, "#e8a33d", 3);
      if (p) { ctx.fillStyle = "rgba(232,163,61,0.9)"; ctx.fillText(s.call, p.x + 5, p.y + 3); }
    }
    const de = mk(deLon, deLat, "#7dd87d", 5);
    if (de) { ctx.strokeStyle = "#7dd87d"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(de.x, de.y, 8, 0, 2 * Math.PI); ctx.stroke(); }
    ctx.restore();
    // rim + label
    ctx.strokeStyle = "#1c2740"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(d.cx, d.cy, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillStyle = "#6b7a99";
    ctx.fillText(d.label, d.cx - 20, d.cy + R + 14);
  });
  void now; // reserved for future time-dependent az layers
}

// ---- v4: real WebGL 3D globe (falls back to the 2D azimuthal if unavailable) ----
let globe3d;   // undefined = not tried, null = no WebGL
function getGlobe3D() { if (globe3d === undefined) { try { globe3d = makeGlobe3D(); } catch { globe3d = null; } } return globe3d; }
function drawGlobe3D(ctx, W, H) {
  const g3 = getGlobe3D();
  if (!g3) { drawAzimuthal(ctx, W, H); return; }   // no WebGL on this machine
  ctx.fillStyle = "#05070d"; ctx.fillRect(0, 0, W, H);
  const ctr = globeCenter(true), home = globeHome();   // fractional center -> smooth rotation
  const R = Math.min(W / 2, H / 2) - 18, cx = W / 2, cy = H / 2;
  const sub = subsolarPoint(new Date());
  const style = effectiveStyle();
  const animFr = style === "satellite" && animMode() ? animFrameImg() : null;
  const dayImg = style === "satellite" ? (animFr || worldSat) : worldDay;
  const glcv = g3.render({
    W, H, dpr: window.devicePixelRatio || 1, cx, cy, R,
    centerLat: ctr.lat, centerLon: ctr.lon, sunLon: sub.lon, sunLat: sub.lat,
    style, dayImg, nightImg: worldNight, cityLights: nightReady && visibleIds().includes("citylights"),
  });
  ctx.drawImage(glcv, 0, 0, W, H);                 // the lit, textured 3D sphere
  const projFn = makeProjector(ctr.lat, ctr.lon, cx, cy, R);
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.clip();
  ctx.font = "10px ui-monospace, monospace";
  if (style === "line") {                          // coastlines over the plain sphere
    ctx.strokeStyle = "#2a63a8"; ctx.lineWidth = 0.7;
    for (const f of (land?.features || [])) {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const poly of polys) for (const ring of poly) strokeFront(ctx, ring, projFn);
    }
  }
  ctx.strokeStyle = "rgba(210,225,255,0.12)"; ctx.lineWidth = 0.5;   // graticule
  for (let lon = -180; lon < 180; lon += 30) strokeFront(ctx, Array.from({ length: 61 }, (_, i) => [lon, -90 + i * 3]), projFn);
  for (let lat = -60; lat <= 60; lat += 30) strokeFront(ctx, Array.from({ length: 121 }, (_, i) => [-180 + i * 3, lat]), projFn);
  const rc = { ...rcFor(W, H), project: (lon, lat) => projFn(lon, lat) };
  drawOverlaysZ(ctx, rc);                                           // registry z-order (lines over fills)
  const mk = (lon, lat, color, r) => { const p = projFn(lon, lat); if (!p.front) return null; ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill(); return p; };
  const sp = mk(sub.lon, sub.lat, "#ffd23d", 6);
  if (sp) { ctx.strokeStyle = "#ffd23d"; ctx.beginPath(); ctx.arc(sp.x, sp.y, 10, 0, 2 * Math.PI); ctx.stroke(); }
  for (const s of data.spots) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const p = mk(s.lon, s.lat, "#e8a33d", 3);
    if (p) { ctx.fillStyle = "rgba(232,163,61,0.95)"; ctx.fillText(s.call, p.x + 5, p.y + 3); }
  }
  const st = data.station || {};
  const de = mk(Number(st.lon), Number(st.lat), "#7dd87d", 5);
  if (de) { ctx.strokeStyle = "#7dd87d"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(de.x, de.y, 8, 0, 2 * Math.PI); ctx.stroke(); }
  ctx.restore();
  ctx.fillStyle = "#6b7a99"; ctx.fillText(home ? "DE" : "CENTER", cx - 20, cy + R + 14);
}

function marker(ctx, lon, lat, W, H, color, r) {
  const p = project(lon, lat, W, H);
  ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();
  return p;
}

function drawMap() {
  const c = $("hcMap"); if (!c) return;
  const W = c.clientWidth, H = c.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(W * dpr), ph = Math.round(H * dpr);
  const ctx = c.getContext("2d");
  // Only reallocate (and implicitly clear) the backing store when the size really
  // changed - resizing every frame stutters the spin. Otherwise clear manually.
  if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  else { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, pw, ph); }
  ctx.setTransform(dpr * mapZoom, 0, 0, dpr * mapZoom, mapPanX * dpr, mapPanY * dpr);
  if (effectiveProj() === "azimuthal") { drawGlobe3D(ctx, W, H); return; }
  const sub = subsolarPoint(new Date());
  drawBase(ctx, W, H, effectiveStyle(), sub);
  // City Lights overlay: add Black-Marble night lights on the dark side of any style.
  if (nightReady && effectiveStyle() !== "day-night" && visibleIds().includes("citylights")) {
    ctx.save();
    nightPath(ctx, sub, W, H); ctx.clip();
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(worldNight, 0, 0, W, H);
    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
  }
  // graticule equator + prime meridian (subtle)
  ctx.strokeStyle = "rgba(125,216,125,0.12)"; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  // sun (subsolar)
  const sp = marker(ctx, sub.lon, sub.lat, W, H, "#ffd23d", 6);
  ctx.strokeStyle = "#ffd23d"; ctx.beginPath(); ctx.arc(sp.x, sp.y, 10, 0, 2 * Math.PI); ctx.stroke();
  // DX spots
  ctx.font = "10px ui-monospace, monospace";
  for (const s of data.spots) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const p = marker(ctx, s.lon, s.lat, W, H, "#e8a33d", 3);
    ctx.fillStyle = "rgba(232,163,61,0.9)"; ctx.fillText(s.call, p.x + 5, p.y + 3);
  }
  // DE marker on top
  const de = marker(ctx, data.station.lon, data.station.lat, W, H, "#7dd87d", 5);
  ctx.strokeStyle = "#7dd87d"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(de.x, de.y, 8, 0, 2 * Math.PI); ctx.stroke();
  // v2 overlays (each individually guarded inside drawOverlay)
  const rc = rcFor(W, H);
  drawOverlaysZ(ctx, rc);
}
// Draw the visible overlays in fixed registry order (z-order) so thin line overlays
// like Borders always paint on top of filled shading - independent of which are
// locked/active (visibleIds() order otherwise puts locked ones underneath).
function drawOverlaysZ(ctx, rc, skip) {
  const vis = new Set(visibleIds());
  for (const id of ALL_IDS) if (vis.has(id) && !(skip && skip.has(id))) drawOverlay(id, ctx, rc);
}

// ---- overlay chrome: chips, cycle dots, legend, context panel ----
function renderChips() {
  const bar = $("hcChips"); if (!bar) return;
  bar.innerHTML = listOverlays().map((o) =>
    `<button class="hcChip${enabled.has(o.id) ? " on" : ""}${auto && active === o.id && enabled.has(o.id) ? " live" : ""}" data-id="${esc(o.id)}" data-info="${esc(OVERLAY_INFO[o.id] || "")}">${esc(o.label)}</button>`
  ).join("") + `<button class="hcChip hcAutoChip${auto ? " on" : ""}" data-id="__auto" data-info="${esc(OVERLAY_INFO.__auto)}">AUTO</button>`;
  const ids = enabledInOrder();
  $("hcDots").innerHTML = auto && ids.length > 1
    ? ids.map((id) => `<span class="dot${id === active ? " on" : ""}"></span>`).join("")
    : "";
}
// ---- v3 map controls: basemap style chips (Task 12 appends projection chips) ----
function renderMapCtl() {
  const el = $("hcMapCtl"); if (!el) return;
  const cur = effectiveStyle();
  el.innerHTML = MAP_STYLES.map((s) =>
    `<button class="hcChip${cur === s ? " on" : ""}" data-style="${s}" data-info="${esc(CTRL_INFO[s] || "")}">${s === "day-night" ? "DAY-NITE" : s === "satellite" ? "SATELLITE" : s.toUpperCase()}</button>`
  ).join("") + PROJECTIONS.map((p) =>
    `<button class="hcChip hcAutoChip${effectiveProj() === p ? " on" : ""}" data-proj="${p}" data-info="${esc(CTRL_INFO[p] || "")}">${p === "equirect" ? "FLAT" : "GLOBE"}</button>`
  ).join("") + (effectiveStyle() === "satellite"
    ? `<button class="hcChip hcAutoChip${animMode() ? " on" : ""}" data-anim="1" data-info="${esc(CTRL_INFO.anim)}">${animMode() === "clouds" ? "CLOUDS" : animMode() === "days" ? "DAYS" : "ANIM"}</button>`
    : "");
}
function renderLegend() {
  const lines = visibleIds().map((id) => ATTRIBUTIONS[id]).filter(Boolean);
  const est = effectiveStyle();
  if (est === "satellite") {
    lines.push("Basemap: NASA GIBS / VIIRS true-color (daily)");
    if (animMode() === "clouds") lines.push("Clouds: NOAA GOES-East/West via NASA GIBS");
  } else if (est !== "line") lines.push("Basemap: NASA Blue Marble / Black Marble");
  const el = $("hcLegend");
  el.innerHTML = lines.map((l) => `<div>${esc(l)}</div>`).join("");
  el.style.display = lines.length ? "block" : "none";
}
function renderContext() {
  const o = listOverlays().find((x) => x.id === active);
  $("hcCtxTitle").textContent = o ? o.label : "Overlay";
  const html = o && enabled.has(o.id) ? overlayPanel(o.id, rcFor(0, 0)) : null;
  $("hcCtx").innerHTML = html || `<p class="hcMuted">&mdash;</p>`;
}
function syncUi() { renderChips(); renderMapCtl(); renderLegend(); renderContext(); syncAnim(); drawMap(); }

function onChipClick(e) {
  const id = e.target?.dataset?.id;
  if (!id) return;
  if (id === "__auto") auto = !auto;
  else if (enabled.has(id)) { enabled.delete(id); if (active === id) active = enabledInOrder()[0] || null; }
  else { enabled.add(id); active = id; }   // most recently toggled-on drives the context panel
  persist(); syncUi();
}
function autoTick() {
  if (!auto) return;
  const ids = cycleIds();
  if (!ids.length) return;
  active = ids[(ids.indexOf(active) + 1) % ids.length];
  syncUi();
}
// Self-rescheduling so the cycle period can change live from the settings panel.
let autoTimer = null;
function scheduleAuto() { clearTimeout(autoTimer); autoTimer = setTimeout(() => { autoTick(); scheduleAuto(); }, Math.max(3, autoSec) * 1000); }

function hhmm(h) { if (h == null) return "--:--"; const m = Math.round(h * 60); return String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }

function renderPanels() {
  const st = data.station;
  const now = new Date();
  const t = sunTimes(Number(st.lat), Number(st.lon), now);
  $("hcDe").innerHTML =
    `<div class="hcKv"><span>Grid</span><b>${esc(st.grid)}</b></div>` +
    `<div class="hcKv"><span>Lat / Lon</span><b>${Number(st.lat).toFixed(2)}, ${Number(st.lon).toFixed(2)}</b></div>` +
    `<div class="hcKv"><span>Sunrise</span><b>${hhmm(t.riseUTC)}Z</b></div>` +
    `<div class="hcKv"><span>Sunset</span><b>${hhmm(t.setUTC)}Z</b></div>` +
    `<div class="hcKv"><span>Day length</span><b>${t.dayHours.toFixed(1)} h</b></div>`;
  $("hcSpots").innerHTML = data.spots.length
    ? data.spots.map((x) => `<div class="hcSpot"><b>${esc(x.call)}</b> <span class="hcBand">${esc(x.band || (x.freqKhz/1000).toFixed(3))}</span> <span class="hcCty">${esc(x.country)}</span> <span class="hcT">${esc((x.time || "").slice(11, 16))}</span></div>`).join("")
    : `<p class="hcMuted">no recent spots</p>`;
}

function tickClocks() {
  const now = new Date();
  $("hcUtc").textContent = now.toISOString().slice(11, 19);
  $("hcUtcDate").textContent = now.toUTCString().slice(0, 16);
  $("hcMjd").textContent = "MJD " + (now.getTime() / 86400000 + 40587).toFixed(4);
  try {
    // Kiosk pins the station timezone; standalone uses the visitor's local zone.
    const opts = STANDALONE ? { hour12: timeFmt === "12" } : { timeZone: "America/New_York", hour12: timeFmt === "12" };
    $("hcLocal").textContent = now.toLocaleTimeString("en-US", opts);
  } catch { $("hcLocal").textContent = "--:--:--"; }
  updateNightDim(now);
}

// Auto-dim the kiosk when it's night at the station, to cut glare on a wall display.
let dimState = null;
function updateNightDim(now) {
  const st = data.station;
  if (!st || st.lat == null || st.lon == null) return;
  const night = isNight(Number(st.lat), Number(st.lon), subsolarPoint(now));
  if (night === dimState) return;                 // only touch the DOM on a transition
  dimState = night;
  const hc = $("hc");
  if (hc) hc.style.filter = night ? "brightness(0.72)" : "";
}

// ---- standalone data provider (HamClock Web): direct upstream feeds ----
function webStation() {
  const call = (lsGet("hcCall", "") || "N0CALL").trim().toUpperCase();
  const grid = (lsGet("hcGrid", "") || "EM78").trim().toUpperCase();
  let lat = parseFloat(lsGet("hcLat", "")), lon = parseFloat(lsGet("hcLon", ""));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const ll = gridToLatLon(grid) || { lat: 38.25, lon: -85.76 };
    lat = ll.lat; lon = ll.lon;
  }
  return { call, grid, lat, lon };
}
function webPsk() {
  return {
    direction: lsGet("hcPskDir", "sender") === "receiver" ? "receiver" : "sender",
    windowSec: Math.max(900, Math.min(86400, (+lsGet("hcPskMin", 30) || 30) * 60)),
    mode: lsGet("hcPskMode", ""),                     // "" = all modes (server-side query filter)
    band: lsGet("hcPskBand", ""),                     // "" = all bands (client-side filter)
    // kiosk falls back to the server-configured operator email (data.ui.pskContact)
    contact: lsGet("hcPskContact", "").trim() || data.ui?.pskContact || "",
  };
}
const pskColorBy = () => { const v = lsGet("hcPskColor", "band"); return ["band", "mode", "mono"].includes(v) ? v : "band"; };
// PSK reports are fetched client-side on BOTH builds (JSONP works from any origin),
// so the settings (direction / window / colors) work on the kiosk too. The web
// provider owns its own cache; the kiosk uses this one.
let kioskPsk = null;
function kioskPskCache() {
  if (!kioskPsk) {
    // onUpdate: merge + repaint the moment an answer lands - without it the map
    // sits empty until the next 120s pullLayers tick (looked like a dead feature).
    kioskPsk = makePskJsonpCache({
      getStation: () => data.station, getPsk: webPsk,
      onUpdate: () => { layers.psk = kioskPsk.get(); renderContext(); drawMap(); renderTiles(); },
    });
    kioskPsk.start();
  }
  return kioskPsk;
}
function refreshPskNow() { if (STANDALONE) webProv?.refreshPsk?.(); else kioskPsk?.refresh?.(); }
// Memoize the PROMISE, not the instance: pull()/pullLayers()/pullMode() all call
// this concurrently at boot, and instance-memoization raced - three providers got
// built, tripling every upstream query (incl. 3x heavy PSK fetches per page load,
// which is exactly what trips pskreporter's soft-throttle).
let webProv = null, webProvP = null;
function webProvider() {
  if (!webProvP) {
    webProvP = import("./hc-data-web.js").then((mod) => {
      webProv = mod.makeWebProvider({
        getStation: webStation, getPsk: webPsk,
        // Same immediate-merge as the kiosk: repaint as soon as a PSK answer lands.
        onPskUpdate: () => { if (webProv) { layers = webProv.layers(); renderContext(); drawMap(); renderTiles(); } },
      });
      webProv.start();
      return webProv;
    });
  }
  return webProvP;
}

async function pull() {
  try {
    if (STANDALONE) {
      const p = await webProvider();
      data = p.data();
      applyCall();                       // header/DE title follow the configured station
      $("hcUpdated").textContent = "updated " + new Date().toLocaleTimeString();
    } else {
      const r = await fetch("/api/hamclock");
      if (r.ok) { data = await r.json(); $("hcUpdated").textContent = "updated " + new Date().toLocaleTimeString(); }
    }
  } catch { /* keep last data */ }
  renderPanels(); syncUi(); renderTiles();
}

async function pullLayers() {
  try {
    if (STANDALONE) layers = (await webProvider()).layers();
    else {
      const r = await fetch("/api/hamclock/layers");
      if (r.ok) layers = await r.json();
      layers.psk = kioskPskCache().get();   // psk is client-side everywhere (settings-aware)
    }
  } catch { /* keep last layers */ }
  renderContext(); drawMap(); renderTiles();
}

// Station mode. Kiosk: the scheduler's active profile (SSTV / FT8 / VarAC).
// Standalone: the mode of the newest PSKReporter report (FT8 / FT4 / SSTV / ...).
async function pullMode() {
  try {
    const el = $("hcModeV"); if (!el) return;
    if (STANDALONE) { el.textContent = (await webProvider()).mode() || "—"; return; }
    const r = await fetch("/api/scheduler");
    if (!r.ok) return;
    const s = await r.json();
    const prof = s.activeProfileId ? (s.profiles || []).find((p) => p.id === s.activeProfileId)?.label : null;
    el.textContent = prof || (s.enabled ? "IDLE" : "—");
  } catch { /* keep last shown */ }
}

async function init() {
  try { land = await (await fetch(ASSET("world-land.json"))).json(); } catch { land = null; }
  fetch(ASSET("world-boundaries.json")).then((r) => r.json()).then((b) => { bounds = b; drawMap(); }).catch(() => {});
  $("hcChips").addEventListener("click", onChipClick);
  $("hcMapCtl").addEventListener("click", (e) => {
    if (e.target?.dataset?.anim) {
      animChoice = animChoice === "" ? "clouds" : animChoice === "clouds" ? "days" : "";
      try { localStorage.setItem("hcAnim", animChoice); } catch { /* session-only */ }
      syncUi(); return;
    }
    const s = e.target?.dataset?.style;
    if (s && MAP_STYLES.includes(s)) { styleChoice = s; persistStyle(s); syncUi(); return; }
    const p = e.target?.dataset?.proj;
    if (p && PROJECTIONS.includes(p)) { projChoice = p; persistProj(p); syncUi(); }
  });
  applyView(); renderView();
  $("hcView").addEventListener("click", (e) => {
    const card = e.target.closest("[data-card]");
    if (card) {
      const id = card.dataset.card;
      if (id === "__all") hiddenTiles = hiddenTiles.size ? new Set() : new Set(listTiles());
      else if (hiddenTiles.has(id)) hiddenTiles.delete(id);
      else hiddenTiles.add(id);
      persistHiddenTiles(); renderView(); renderTiles();
      return;
    }
    const v = e.target.closest("[data-view]")?.dataset?.view; if (!v) return;
    if (v === "settings") { settingsOpen = !settingsOpen; renderView(); renderSettings(); }
    else if (v === "about") { aboutOpen = !aboutOpen; renderView(); renderAbout(); }
    else if (v === "restoretiles") { hiddenTiles = new Set(); persistHiddenTiles(); renderView(); renderTiles(); }
    else if (v === "cardmenu") { cardMenuOpen = !cardMenuOpen; renderView(); }
    else if (v === "cards") { noCards = !noCards; try { localStorage.setItem("hcNoCards", noCards ? "1" : "0"); } catch { /* ignore */ } applyView(); renderView(); requestAnimationFrame(() => { drawMap(); renderTiles(); }); }
    else if (v === "big") { bigMap = !bigMap; try { localStorage.setItem("hcBig", bigMap ? "1" : "0"); } catch { /* ignore */ } applyView(); renderView(); requestAnimationFrame(drawMap); }
    else if (v === "globes") { globeSingle = !globeSingle; try { localStorage.setItem("hcGlobeSingle", globeSingle ? "1" : "0"); } catch { /* ignore */ } renderView(); requestAnimationFrame(drawMap); }
    else if (v === "spin") { globeSpin = !globeSpin; try { localStorage.setItem("hcSpin", globeSpin ? "1" : "0"); } catch { /* ignore */ } renderView(); }
    else if (v === "home") { globeRotLon = 0; globeRotLat = 0; renderView(); drawMap(); }
    else if (v === "reset") { mapZoom = 1; clampMap(); renderView(); drawMap(); }
  });
  document.addEventListener("click", (e) => { if (cardMenuOpen && !e.target.closest("#hcView")) { cardMenuOpen = false; renderView(); } });
  // Settings panel: overlays reuse the overlay toggle (onChipClick), cards/sun/view
  // toggle here. Every branch re-renders the panel so its state stays live.
  renderSettings();
  $("hcSettings").addEventListener("click", (e) => {
    const btn = e.target.closest("button"); if (!btn) return;
    const d = btn.dataset;
    if (d.lock != null) { toggleLock(d.lock); renderSettings(); return; }
    if (d.id != null) { onChipClick({ target: btn }); renderSettings(); return; }
    if (d.sun != null) { setSunView(d.sun); renderSettings(); return; }
    if (d.pskdir != null) { lsSet("hcPskDir", d.pskdir); refreshPskNow(); renderSettings(); return; }
    if (d.pskmin != null) { lsSet("hcPskMin", d.pskmin); refreshPskNow(); renderSettings(); return; }
    if (d.pskmode != null) { lsSet("hcPskMode", d.pskmode); refreshPskNow(); renderSettings(); return; }
    if (d.pskband != null) { lsSet("hcPskBand", d.pskband); refreshPskNow(); renderSettings(); return; }
    if (d.pskcolor != null) { lsSet("hcPskColor", d.pskcolor); renderSettings(); syncUi(); return; }
    if (d.time != null) { timeFmt = d.time === "12" ? "12" : "24"; lsSet("hcTimeFmt", timeFmt); tickClocks(); renderSettings(); return; }
    if (d.auto != null) { autoSec = Math.max(3, Math.min(120, +d.auto || 15)); lsSet("hcAutoSec", String(autoSec)); scheduleAuto(); renderSettings(); return; }
    if (d.spin != null) { spinRate = Math.max(0.2, Math.min(4, +d.spin || 1)); lsSet("hcSpinRate", String(spinRate)); renderSettings(); return; }
    if (d.card != null) {
      if (d.card === "__all") hiddenTiles = hiddenTiles.size ? new Set() : new Set(listTiles());
      else if (hiddenTiles.has(d.card)) hiddenTiles.delete(d.card); else hiddenTiles.add(d.card);
      persistHiddenTiles(); renderSettings(); renderTiles(); requestAnimationFrame(drawMap); return;
    }
    const v = d.view;
    if (v === "settings") { settingsOpen = false; renderSettings(); renderView(); }
    else if (v === "cards") { noCards = !noCards; try { localStorage.setItem("hcNoCards", noCards ? "1" : "0"); } catch { /* ignore */ } applyView(); renderSettings(); requestAnimationFrame(() => { drawMap(); renderTiles(); }); }
    else if (v === "big") { bigMap = !bigMap; try { localStorage.setItem("hcBig", bigMap ? "1" : "0"); } catch { /* ignore */ } applyView(); renderSettings(); requestAnimationFrame(drawMap); }
  });
  $("hcSettings").addEventListener("input", (e) => {
    const t = e.target;
    if (t.matches("[data-call]")) { customCall = t.value.trim(); lsSet("hcCall", customCall); applyCall(); }
    else if (t.matches("[data-grid]")) lsSet("hcGrid", t.value.trim().toUpperCase());
    else if (t.matches("[data-sstvurl]")) { lsSet("hcSstvUrl", t.value.trim()); loadSstv(); renderTiles(); }
    else if (t.matches("[data-pskmail]")) lsSet("hcPskContact", t.value.trim());
  });
  renderAbout();
  $("hcAbout").addEventListener("click", (e) => {
    if (e.target.closest('[data-view="about"]')) { aboutOpen = false; renderAbout(); renderView(); }
  });
  // Standalone: call/grid feed live queries (PSK, weather URL); a committed edit
  // (blur/Enter) reloads so every cache rebuilds against the new station cleanly.
  if (STANDALONE) {
    $("hcSettings").addEventListener("change", (e) => {
      if (e.target.matches("[data-call],[data-grid]")) setTimeout(() => location.reload(), 150);
    });
  }
  // map zoom (scroll toward cursor) + pan (drag)
  const mapEl = $("hcMap");
  mapEl.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = mapEl.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const wx = (mx - mapPanX) / mapZoom, wy = (my - mapPanY) / mapZoom;
    mapZoom = Math.max(1, Math.min(6, mapZoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    mapPanX = mx - wx * mapZoom; mapPanY = my - wy * mapZoom;
    clampMap(); renderView(); drawMap();
  }, { passive: false });
  // Coalesce redraws to one per animation frame so a fast drag or the spin timer
  // never piles up raster rebuilds faster than the display can show them.
  let rafPending = false;
  const scheduleDraw = () => { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; drawMap(); }); };
  let dragging = false, lastX = 0, lastY = 0;
  mapEl.addEventListener("mousedown", (e) => {
    const az = effectiveProj() === "azimuthal";
    if (!az && mapZoom <= 1) return;            // flat map only drags when zoomed in
    if (az) globeGrab = true; else dragging = true;
    lastX = e.clientX; lastY = e.clientY; mapEl.classList.add("hcPanning"); e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging && !globeGrab) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    if (globeGrab) {
      // Grab the sphere: horizontal drag spins longitude, vertical tilts latitude
      // (~90 deg across a disc radius). Center follows the surface under the cursor.
      const R = Math.min(mapEl.clientWidth / 4, mapEl.clientHeight / 2) - 16;
      const dpp = 90 / Math.max(60, R);
      globeRotLon -= dx * dpp;
      globeRotLat = Math.max(-90, Math.min(90, globeRotLat + dy * dpp));
      renderView();                             // reveal/hide the HOME chip live
    } else { mapPanX += dx; mapPanY += dy; clampMap(); }
    scheduleDraw();
  });
  window.addEventListener("mouseup", () => { dragging = false; globeGrab = false; mapEl.classList.remove("hcPanning"); });
  // Auto-rotate when SPIN is on: a per-frame (rAF) loop with a time-based step, so
  // it's smooth even at slow rates (paused while grabbing / off the globe view).
  let lastSpinT = 0;
  function spinFrame(t) {
    if (globeSpin && !globeGrab && effectiveProj() === "azimuthal") {
      if (lastSpinT) { globeRotLon += spinRate * 6.7 * ((t - lastSpinT) / 1000); drawMap(); } // spinRate 1 => ~6.7 deg/s
      lastSpinT = t;
    } else lastSpinT = 0;
    requestAnimationFrame(spinFrame);
  }
  requestAnimationFrame(spinFrame);

  applyCall(); tickClocks(); renderPanels(); syncUi();
  pull(); pullLayers(); pullMode();
  loadSun();
  setInterval(loadSun, 15 * 60000);      // SDO updates ~15 min; cache-busted URL
  loadSstv();
  setInterval(loadSstv, 60000);          // pick up a fresh SSTV capture ~once a minute
  loadBandsImg();
  if (STANDALONE) setInterval(loadBandsImg, 30 * 60000);   // hamqsl band-cond embed image
  // First visit on HamClock Web: open settings so the visitor sets call + grid.
  if (STANDALONE && !lsGet("hcGrid", "")) { settingsOpen = true; renderView(); renderSettings(); }
  // Standalone warm-up: the direct-feed caches start cold (the kiosk's server
  // caches are always warm), so re-pull a few times while they fill instead of
  // waiting out the first 60s cadence.
  if (STANDALONE) for (const ms of [3000, 8000, 15000, 30000]) setTimeout(() => { pull(); pullLayers(); pullMode(); }, ms);
  refreshSatDate();                      // discover GIBS's latest date, then load the mosaic
  setInterval(refreshSatDate, 3 * 60 * 60000);  // re-check for a newer day periodically
  setInterval(renderTiles, 10000);       // beacons tile advances every 10 s slot
  setInterval(tickClocks, 1000);
  setInterval(pull, 60000);
  setInterval(pullLayers, 120000);   // client cadence; the server's PSK cache still refreshes upstream >= 5 min
  scheduleAuto();                    // AUTO overlay cycle (period is user-adjustable)
  setInterval(drawMap, 60000);       // terminator moves ~0.25°/min
  setInterval(pullMode, 30000);      // scheduler-driven station mode
  window.addEventListener("resize", () => { clampMap(); drawMap(); renderTiles(); });

  // Hover tooltips: one shared, kiosk-styled popover driven by [data-info].
  const tip = document.createElement("div");
  tip.id = "hcTooltip";
  document.body.appendChild(tip);
  const showTip = (el) => {
    const info = el.dataset.info; if (!info) { tip.style.display = "none"; return; }
    tip.textContent = info; tip.style.display = "block";
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const x = Math.min(Math.max(6, r.left), window.innerWidth - tw - 6);
    let y = r.bottom + 8;
    if (y + th > window.innerHeight - 6) y = r.top - th - 8;
    tip.style.left = `${x}px`; tip.style.top = `${Math.max(6, y)}px`;
  };
  document.addEventListener("mouseover", (e) => {
    const el = e.target.closest && e.target.closest("[data-info]");
    if (el) showTip(el);
  });
  document.addEventListener("mouseout", (e) => {
    const el = e.target.closest && e.target.closest("[data-info]");
    if (el && !el.contains(e.relatedTarget)) tip.style.display = "none";
  });
}
init();
