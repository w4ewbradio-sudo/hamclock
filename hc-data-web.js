// Standalone (browser-only) data provider for HamClock Web. Replaces the local
// Control Center's /api/hamclock, /api/hamclock/layers and mode endpoints with
// direct fetches of the upstream feeds, all of which are HTTPS + CORS-friendly:
//   DX spots .... SpotHole (spothole.app)          — HTTPS+CORS JSON cluster API
//   space wx .... NOAA SWPC (kp/flux/x-ray)        — CORS *
//   SSN ......... NOAA SWPC daily-solar-indices    — CORS * (SILSO has no CORS)
//   MUF/foF2 .... prop.kc2g.com                    — CORS *
//   DRAP/aurora . NOAA SWPC                        — CORS *
//   sats TLEs ... CelesTrak                        — CORS *
//   weather ..... open-meteo (from the QTH)        — CORS *
//   PSK ......... PSKReporter via JSONP            — no CORS, callback= works
// The cache factories are the SAME modules the kiosk server uses (they're pure
// ES modules taking fetchImpl); the build script rewrites "../x.js" -> "./feeds/x.js".
// Pure parse/map helpers live at top-level (no DOM) so node:test can cover them.
import { makeSpacewxCache } from "./feeds/spacewx.js";
import { makeMufCache } from "./feeds/muf.js";
import { makeDrapCache } from "./feeds/drap.js";
import { makeAuroraCache } from "./feeds/aurora.js";
import { makeWeatherCache } from "./feeds/weather.js";
import { makeSatsCache } from "./feeds/sats.js";
import { bandFor } from "./feeds/dx.js";

// ---- pure helpers (unit-tested) ----

// SpotHole JSON -> the same spot shape parseSpots (DXSummit) produced.
export function parseSpotHole(json, limit = 25) {
  let arr;
  try { arr = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (out.length >= limit) break;
    if (!s || s.dx_call == null || s.dx_latitude == null || s.dx_longitude == null) continue;
    const khz = (Number(s.freq) || 0) / 1000;      // SpotHole freq is Hz
    out.push({
      call: String(s.dx_call),
      freqKhz: khz,
      band: s.band || bandFor(khz),
      country: String(s.dx_country || ""),
      lat: Number(s.dx_latitude),
      lon: Number(s.dx_longitude),                 // already east-positive
      deCall: String(s.de_call || ""),
      time: String(s.time_iso || "").slice(11, 16),
    });
  }
  return out;
}

// PSKReporter JSONP JSON -> the same report shape parsePsk (XML) produced.
// direction "sender": reports OF my transmissions (who hears me) - remote = receiver.
// direction "receiver": what I hear - remote = sender. rxCall/rxGrid always carry
// the REMOTE end because that's what the map plots and the panel lists.
export function mapPskJson(json, { direction = "sender", limit = 50 } = {}) {
  const rr = json && Array.isArray(json.receptionReport) ? json.receptionReport : [];
  const out = [];
  for (const r of rr) {
    const remoteCall = direction === "sender" ? r.receiverCallsign : r.senderCallsign;
    const remoteGrid = direction === "sender" ? r.receiverLocator : r.senderLocator;
    if (!remoteGrid) continue;
    const snr = Number(r.sNR);
    out.push({
      rxCall: remoteCall || "",
      rxGrid: remoteGrid,
      txCall: (direction === "sender" ? r.senderCallsign : r.receiverCallsign) || "",
      freqHz: Number(r.frequency) || 0,
      mode: r.mode || "",
      snr: Number.isFinite(snr) ? snr : null,
      epoch: Number(r.flowStartSeconds) || 0,
    });
  }
  out.sort((a, b) => b.epoch - a.epoch);
  return out.slice(0, limit);
}

// NOAA SWPC daily-solar-indices.txt -> [{date, ssn}] (last ~30 days). Data rows:
// "2026 06 15  117     78     330 ..." = Y M D flux SSN area ...
export function parseDsd(text) {
  if (typeof text !== "string") return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d{4})\s+(\d{2})\s+(\d{2})\s+(-?\d+)\s+(-?\d+)/);
    if (!m) continue;
    const ssn = Number(m[5]);
    if (!Number.isFinite(ssn) || ssn < 0) continue;
    out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, ssn });
  }
  return out;
}

// ---- JSONP (PSKReporter has no CORS but supports callback=) ----
let jsonpN = 0;
function jsonp(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cb = "hcJsonpCb" + (++jsonpN);   // no leading underscores: pskreporter strips them from callback=
    const s = document.createElement("script");
    const done = (fn, v) => { clearTimeout(timer); delete window[cb]; s.remove(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error("jsonp timeout")), timeoutMs);
    window[cb] = (data) => done(resolve, data);
    s.onerror = () => done(reject, new Error("jsonp load error"));
    s.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
    document.head.appendChild(s);
  });
}

const SAT_WATCHLIST = [
  { name: "ISS", norad: 25544 }, { name: "SO-50", norad: 27607 },
  { name: "AO-91", norad: 43017 }, { name: "FO-29", norad: 24278 },
  { name: "RS-44", norad: 44909 }, { name: "PO-101", norad: 43678 },
];
const PSK_MIN_MS = 5 * 60 * 1000;   // pskreporter.info policy: never faster than 5 min

// getStation() -> {call, grid, lat, lon}; getPsk() -> {direction, windowSec, contact}
export function makeWebProvider({ getStation, getPsk }) {
  const st = getStation();
  const spacewx = makeSpacewxCache({
    kpUrl: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
    fluxUrl: "https://services.swpc.noaa.gov/json/f107_cm_flux.json",
    ssnUrl: "data:,",                              // SILSO has no CORS; SSN comes from DSD below
    xrayUrl: "https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json",
    refreshMs: 30 * 60000,
  });
  const weather = makeWeatherCache({
    url: "https://api.open-meteo.com/v1/forecast?latitude=" + st.lat.toFixed(3) + "&longitude=" + st.lon.toFixed(3)
      + "&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code"
      + "&temperature_unit=fahrenheit&wind_speed_unit=mph",
    refreshMs: 15 * 60000,
  });
  const muf = makeMufCache({ url: "https://prop.kc2g.com/renders/current/mufd-normal-now.geojson", refreshMs: 15 * 60000 });
  const fof2 = makeMufCache({ url: "https://prop.kc2g.com/renders/current/fof2-normal-now.geojson", refreshMs: 15 * 60000 });
  const drap = makeDrapCache({ url: "https://services.swpc.noaa.gov/text/drap_global_frequencies.txt", refreshMs: 5 * 60000 });
  const aurora = makeAuroraCache({ url: "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", refreshMs: 10 * 60000 });
  const sats = makeSatsCache({ url: "https://celestrak.org/NORAD/elements/gp.php?GROUP=amateur&FORMAT=tle", refreshMs: 4 * 3600000, watchlist: SAT_WATCHLIST });

  // DX spots (SpotHole) + SSN (DSD) + PSK (JSONP): simple hand-rolled caches.
  let spots = [], ssn = [], psk = { updated: null, reports: [] };
  async function refreshSpots() {
    try {
      const r = await fetch("https://spothole.app/api/v1/spots?limit=40", { signal: AbortSignal.timeout(15000) });
      const v = parseSpotHole(await r.json(), 25);
      if (v.length) spots = v;
    } catch { /* keep last good */ }
  }
  async function refreshSsn() {
    try {
      const r = await fetch("https://services.swpc.noaa.gov/text/daily-solar-indices.txt", { signal: AbortSignal.timeout(15000) });
      const v = parseDsd(await r.text());
      if (v.length) ssn = v;
    } catch { /* keep last good */ }
  }
  async function refreshPsk() {
    try {
      const p = getPsk(), me = getStation().call;
      if (!me || me === "N0CALL") return;
      const who = p.direction === "receiver" ? "receiverCallsign" : "senderCallsign";
      const url = "https://retrieve.pskreporter.info/query?" + who + "=" + encodeURIComponent(me)
        + "&flowStartSeconds=-" + Math.floor(p.windowSec || 1800) + "&rronly=1"
        + (p.contact ? "&appcontact=" + encodeURIComponent(p.contact) : "");
      const json = await jsonp(url);
      psk = { updated: new Date().toISOString(), reports: mapPskJson(json, { direction: p.direction || "sender" }) };
    } catch { /* keep last good */ }
  }

  let timers = [];
  function start() {
    [spacewx, weather, muf, fof2, drap, aurora, sats].forEach((c) => c.refresh());
    refreshSpots(); refreshSsn(); refreshPsk();
    timers = [
      setInterval(refreshSpots, 3 * 60000),
      setInterval(refreshSsn, 60 * 60000),
      setInterval(refreshPsk, PSK_MIN_MS),
    ];
  }

  return {
    start,
    stop() { timers.forEach(clearInterval); [spacewx, weather, muf, fof2, drap, aurora, sats].forEach((c) => c.stop()); },
    refreshPsk,                                     // settings changes want an immediate re-query
    data() {
      return {
        solar: { bands: {}, updated: null },        // hamqsl XML has no CORS; bands tile uses their embed image
        spots,
        station: getStation(),
        spacewx: { ...spacewx.get(), ssn },
        weather: weather.get(),
        ui: {},
      };
    },
    layers() {
      return { sats: sats.get(), muf: muf.get(), drap: drap.get(), psk: psk, aurora: aurora.get(), fof2: fof2.get() };
    },
    mode() { return (psk.reports[0] && psk.reports[0].mode) || null; },
  };
}
