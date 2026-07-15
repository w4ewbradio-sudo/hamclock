// Pure SGP4 helpers for the sats overlay. The satellite.js namespace is INJECTED as
// the `sat` parameter (browser passes window.satellite, tests pass the UMD-loaded
// module) so this file stays Node-testable with zero DOM/global dependencies.
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const EARTH_R_KM = 6371;

function propagateEci(satrec, date, sat) {
  let pv;
  try { pv = sat.propagate(satrec, date); } catch { return null; }
  const p = pv && pv.position;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
  return pv;
}

// Sub-satellite point. null when propagation is nonsense (decayed TLE, absurd date):
// satellite.js 5.0.0 can return finite-but-garbage coordinates for far-out dates, so
// we also sanity-bound the geodetic height.
export function subPoint(satrec, date, sat) {
  const pv = propagateEci(satrec, date, sat);
  if (!pv) return null;
  const gd = sat.eciToGeodetic(pv.position, sat.gstime(date));
  if (!Number.isFinite(gd.height) || gd.height <= 0 || gd.height > 100000) return null;
  return { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height };
}

// Angular radius (deg) of the horizon circle ("footprint") for a satellite at altKm.
export function footprintRadiusDeg(altKm) {
  if (!Number.isFinite(altKm) || altKm <= 0) return 0;
  return Math.acos(EARTH_R_KM / (EARTH_R_KM + altKm)) * DEG;
}

// Az/el of the satellite from station {lat, lon, altKm?} (degrees / km).
export function lookAngles(satrec, station, date, sat) {
  const pv = propagateEci(satrec, date, sat);
  if (!pv) return null;
  const gmst = sat.gstime(date);
  const observerGd = { latitude: station.lat * RAD, longitude: station.lon * RAD, height: station.altKm || 0 };
  const la = sat.ecfToLookAngles(observerGd, sat.eciToEcf(pv.position, gmst));
  return { az: ((la.azimuth * DEG) % 360 + 360) % 360, el: la.elevation * DEG };
}

// Slant range (km) from station to satellite, or null on bad propagation.
export function rangeKm(satrec, station, date, sat) {
  const pv = propagateEci(satrec, date, sat);
  if (!pv) return null;
  const observerGd = { latitude: station.lat * RAD, longitude: station.lon * RAD, height: station.altKm || 0 };
  const la = sat.ecfToLookAngles(observerGd, sat.eciToEcf(pv.position, sat.gstime(date)));
  return Number.isFinite(la.rangeSat) ? la.rangeSat : null;
}

// Doppler shift (Hz) on downlinkHz, from the numerically-differenced range rate.
// Negative range rate (closing) -> positive shift (higher observed frequency).
export function dopplerHz(satrec, station, date, downlinkHz, sat) {
  if (!Number.isFinite(downlinkHz) || downlinkHz <= 0) return null;
  const r0 = rangeKm(satrec, station, date, sat);
  const r1 = rangeKm(satrec, station, new Date(date.getTime() + 1000), sat); // +1 s
  if (r0 == null || r1 == null) return null;
  const rangeRateKmS = r1 - r0;                 // km/s over the 1 s step
  return -downlinkHz * (rangeRateKmS / 299792.458);
}

// Step-search the next passes (elevation > 0 windows) over `hours` from `fromDate`.
export function nextPasses(satrec, station, fromDate, hours = 24, stepSec = 30, sat) {
  const passes = [];
  let inPass = false, aos = null, maxEl = -90;
  const end = fromDate.getTime() + hours * 3600000;
  for (let t = fromDate.getTime(); t <= end; t += stepSec * 1000) {
    const look = lookAngles(satrec, station, new Date(t), sat);
    const up = look != null && look.el > 0;
    if (up && !inPass) { inPass = true; aos = new Date(t); maxEl = look.el; }
    else if (up) { if (look.el > maxEl) maxEl = look.el; }
    else if (inPass) { inPass = false; passes.push({ aos, los: new Date(t), maxEl }); }
  }
  if (inPass) passes.push({ aos, los: new Date(end), maxEl }); // pass still open at horizon of search
  return passes;
}
