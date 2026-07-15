// Meeus low-precision lunar theory (Astronomical Algorithms ch. 22/25/47, truncated
// to the largest periodic terms). Accuracy ~0.02 deg in longitude vs Meeus Example
// 47.a — comfortably inside the +/-0.5 deg design budget. Pure module: the date is
// always injected (no Date.now()), no DOM, no fetch. Works offline by design.
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const SYNODIC_DAYS = 29.530588853;

const norm360 = (d) => ((d % 360) + 360) % 360;
const norm180 = (d) => { const x = norm360(d); return x > 180 ? x - 360 : x; };

function julianCenturies(date) {
  return (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
}

// Greenwich mean sidereal time, degrees (IAU 1982 polynomial).
function gmstDeg(date) {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const T = d / 36525;
  return norm360(280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38710000);
}

// Sun geometric longitude, degrees (Meeus ch. 25) — for elongation/phase.
function sunLongitudeDeg(T) {
  const M = norm360(357.5291092 + 35999.0502909 * T) * RAD;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const C = (1.914602 - 0.004817 * T) * Math.sin(M)
    + 0.019993 * Math.sin(2 * M)
    + 0.000289 * Math.sin(3 * M);
  return norm360(L0 + C);
}

// Meeus table 47.A (largest terms): [D, M, Mp, F, sinCoeff(1e-6 deg), cosCoeff(1e-3 km)]
const LON_DIST_TERMS = [
  [0, 0, 1, 0, 6288774, -20905355],
  [2, 0, -1, 0, 1274027, -3699111],
  [2, 0, 0, 0, 658314, -2955968],
  [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888],
  [0, 0, 0, 2, -114332, -3149],
  [2, 0, -2, 0, 58793, 246158],
  [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733],
  [2, -1, 0, 0, 45758, -204586],
  [0, 1, -1, 0, -40923, -129620],
  [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755],
  [2, 0, 0, -2, 15327, 10321],
  [0, 0, 1, 2, -12528, 0],
  [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782],
  [0, 0, 3, 0, 10034, -23210],
];
// Meeus table 47.B (largest terms): [D, M, Mp, F, sinCoeff(1e-6 deg)]
const LAT_TERMS = [
  [0, 0, 0, 1, 5128122],
  [0, 0, 1, 1, 280602],
  [0, 0, 1, -1, 277693],
  [2, 0, 0, -1, 173237],
  [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271],
  [2, 0, 0, 1, 32573],
  [0, 0, 2, 1, 17198],
  [2, 0, 1, -1, 9266],
  [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216],
  [2, 0, -2, -1, 4324],
];

// Geocentric ecliptic lon/lat (deg) + distance (km) + T, from the truncated series.
function moonEcliptic(date) {
  const T = julianCenturies(date);
  // Fundamental arguments (Meeus 47.1-47.5), degrees.
  const Lp = norm360(218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + T ** 3 / 538841 - T ** 4 / 65194000);
  const D = norm360(297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + T ** 3 / 545868 - T ** 4 / 113065000);
  const M = norm360(357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + T ** 3 / 24490000);
  const Mp = norm360(134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + T ** 3 / 69699 - T ** 4 / 14712000);
  const F = norm360(93.2720950 + 483202.0175233 * T - 0.0036539 * T * T - T ** 3 / 3526000 + T ** 4 / 863310000);
  const E = 1 - 0.002516 * T - 0.0000074 * T * T; // eccentricity damping for M terms
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of LON_DIST_TERMS) {
    const arg = (d * D + m * M + mp * Mp + f * F) * RAD;
    const e = m === 0 ? 1 : (Math.abs(m) === 1 ? E : E * E);
    sl += l * e * Math.sin(arg);
    sr += r * e * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of LAT_TERMS) {
    const arg = (d * D + m * M + mp * Mp + f * F) * RAD;
    const e = m === 0 ? 1 : (Math.abs(m) === 1 ? E : E * E);
    sb += b * e * Math.sin(arg);
  }
  return {
    lamDeg: norm360(Lp + sl / 1e6),
    betDeg: sb / 1e6,
    distKm: 385000.56 + sr / 1000,
    T,
  };
}

export function moonPosition(date) {
  const { lamDeg, betDeg, distKm, T } = moonEcliptic(date);
  const eps = (23.4392911 - 0.0130042 * T) * RAD; // mean obliquity
  const l = lamDeg * RAD, b = betDeg * RAD;
  const ra = norm360(Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l)) * DEG);
  const dec = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l)) * DEG;
  return { ra, dec, distKm, subLat: dec, subLon: norm180(ra - gmstDeg(date)) };
}

export function moonPhase(date) {
  const { lamDeg, betDeg, T } = moonEcliptic(date);
  const ls = sunLongitudeDeg(T);
  const cosPsi = Math.min(1, Math.max(-1, Math.cos(betDeg * RAD) * Math.cos((lamDeg - ls) * RAD)));
  return {
    fraction: (1 - cosPsi) / 2,                              // illuminated fraction (sun >> moon distance)
    ageDays: norm360(lamDeg - ls) / 360 * SYNODIC_DAYS,      // days since new moon
  };
}

export function moonLookAngles(lat, lon, date) {
  const m = moonPosition(date);
  const H = norm360(gmstDeg(date) + lon - m.ra) * RAD;       // local hour angle
  const phi = lat * RAD, dec = m.dec * RAD;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) * DEG;
  const az = norm360(Math.atan2(
    -Math.cos(dec) * Math.sin(H),
    Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.cos(H) * Math.sin(phi),
  ) * DEG);
  // Geocentric (ignores the ~1 deg lunar parallax) — fine for a wall-map/EME glance.
  return { az, el };
}

function bisectCross(el, a, b) {
  const aNeg = el(new Date(a)) < 0;
  for (let i = 0; i < 14; i++) {
    const mid = (a + b) / 2;
    if ((el(new Date(mid)) < 0) === aNeg) a = mid; else b = mid;
  }
  return new Date((a + b) / 2);
}

// Next moonrise and moonset within ~25h of `date`, found by scanning elevation for
// horizon crossings then bisecting each to ~1 min. Geocentric (same ~1° budget as
// moonLookAngles); either can be null if it doesn't occur in the window.
export function moonRiseSet(lat, lon, date, { stepMin = 10 } = {}) {
  const el = (t) => moonLookAngles(lat, lon, t).el;
  const start = date.getTime();
  let rise = null, set = null;
  let prev = el(date);
  for (let m = stepMin; m <= 1500 && (!rise || !set); m += stepMin) {
    const t0 = start + (m - stepMin) * 60000, t1 = start + m * 60000;
    const cur = el(new Date(t1));
    if (!rise && prev < 0 && cur >= 0) rise = bisectCross(el, t0, t1);
    if (!set && prev >= 0 && cur < 0) set = bisectCross(el, t0, t1);
    prev = cur;
  }
  return { rise, set };
}
