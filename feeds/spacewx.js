// NOAA SWPC + SILSO space-weather trend series for the HamClock v3 tile row.
// Same discipline as solar.js: parsers never throw, the cache keeps last-good
// PER SERIES, AbortSignal.timeout bounds every fetch, refresh timers are
// unref()'d so tests and shutdown never hang.
// Attributions (rendered client-side): NOAA SWPC (Kp / F10.7 / GOES X-ray),
// SILSO / Royal Observatory of Belgium (SSN), NASA/SDO (sun image).

// noaa-planetary-k-index.json: array of { time_tag, Kp, a_running,
// station_count }, oldest-first (~56 rows = 7 days x 3-hourly), Kp numeric.
export function parseKp(json) {
  let arr;
  try { arr = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const r of arr) {
    const kp = Number(r?.Kp);
    if (!r?.time_tag || !Number.isFinite(kp)) continue;
    out.push({ t: String(r.time_tag), kp });
  }
  return out;
}

// f107_cm_flux.json: array of { time_tag, frequency, flux, ... } NEWEST-first
// (~121 rows, 3/day, ~40 days). flux is a plain number today but shipped as a
// sci-notation string ("1.07e+002") historically -- Number() accepts both.
export function parseFlux(json) {
  let arr;
  try { arr = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const r of arr) {
    const flux = Number(r?.flux);
    if (!r?.time_tag || !Number.isFinite(flux)) continue;
    out.push({ t: String(r.time_tag), flux });
  }
  out.reverse(); // newest-first upstream -> chronological for charting
  return out;
}

// SILSO EISN_current.txt: "YYYY MM DD decdate SSN std Ncalc Nobs" daily rows.
export function parseSsn(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().split(/\s+/);
    if (m.length < 5) continue;
    const y = Number(m[0]), mo = Number(m[1]), d = Number(m[2]), ssn = Number(m[4]);
    if (!Number.isInteger(y) || y < 1900 || !Number.isInteger(mo) || !Number.isInteger(d)
      || !Number.isFinite(ssn) || ssn < 0) continue; // SILSO uses negative SSN for missing days
    out.push({ t: `${m[0]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, ssn });
  }
  return out;
}

// GOES class letter from long-band (0.1-0.8nm) flux in W/m^2.
// A/B/C/M/X decades start at 1e-8/1e-7/1e-6/1e-5/1e-4; magnitude = flux/decade.
export function xrayClass(flux) {
  const f = Number(flux);
  if (!Number.isFinite(f) || f <= 0) return null;
  for (const [letter, base] of [["X", 1e-4], ["M", 1e-5], ["C", 1e-6], ["B", 1e-7]]) {
    if (f >= base) return letter + (f / base).toFixed(1);
  }
  return "A" + (f / 1e-8).toFixed(1); // everything below the B floor reads as A-class
}

// xrays-6-hour.json: TWO rows per timestamp keyed by `energy`
// ("0.1-0.8nm" long / "0.05-0.4nm" short), oldest-first, flux in W/m^2.
export function parseXray(json) {
  const empty = { series: [], class: null };
  let arr;
  try { arr = typeof json === "string" ? JSON.parse(json) : json; } catch { return empty; }
  if (!Array.isArray(arr)) return empty;
  const byT = new Map(); // insertion order == upstream chronological order
  for (const r of arr) {
    const f = Number(r?.flux);
    if (!r?.time_tag || !Number.isFinite(f)) continue;
    const e = byT.get(r.time_tag) || { t: String(r.time_tag), long: null, short: null };
    if (r.energy === "0.1-0.8nm") e.long = f;
    else if (r.energy === "0.05-0.4nm") e.short = f;
    else continue;
    byT.set(r.time_tag, e);
  }
  const series = [...byT.values()];
  let latestLong = null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].long != null) { latestLong = series[i].long; break; }
  }
  return { series, class: xrayClass(latestLong) };
}

// One cache, four independent fetches -- each series keeps its own last-good,
// so a dead SILSO never blanks the Kp chart (and vice versa).
export function makeSpacewxCache({ kpUrl, fluxUrl, ssnUrl, xrayUrl, fetchImpl = fetch, refreshMs }) {
  const data = { kp: [], flux: [], ssn: [], xray: { series: [], class: null }, updated: null };
  let timer = null;
  async function one(url, kind) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      const text = await res.text();
      if (kind === "kp") { const v = parseKp(text); if (v.length) { data.kp = v; return true; } }
      else if (kind === "flux") { const v = parseFlux(text); if (v.length) { data.flux = v; return true; } }
      else if (kind === "ssn") { const v = parseSsn(text); if (v.length) { data.ssn = v; return true; } }
      else if (kind === "xray") { const v = parseXray(text); if (v.series.length) { data.xray = v; return true; } }
    } catch { /* keep last good for this series; retry next interval */ }
    return false;
  }
  async function refresh() {
    const got = await Promise.all([one(kpUrl, "kp"), one(fluxUrl, "flux"), one(ssnUrl, "ssn"), one(xrayUrl, "xray")]);
    if (got.some(Boolean)) data.updated = new Date().toISOString();
  }
  if (refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); }
  return { get: () => ({ ...data }), refresh, stop: () => timer && clearInterval(timer) };
}

// Live SDO sun-disc JPEG proxy: fetched into an in-memory Buffer (last-good),
// served by server.js at GET /api/hamclock/sun. Never throws; a bad fetch or
// non-JPEG payload keeps the previous image. Credit: NASA/SDO (AIA/EVE/HMI).
export function makeSunImageCache({ url, fetchImpl = fetch, refreshMs }) {
  let buf = null;
  let timer = null;
  async function refresh() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return;
      const b = Buffer.from(await res.arrayBuffer());
      if (b.length > 100 && b[0] === 0xff && b[1] === 0xd8) buf = b; // JPEG magic only
    } catch { /* keep last good image; retry next interval */ }
  }
  if (refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); }
  return { get: () => buf, refresh, stop: () => timer && clearInterval(timer) };
}
