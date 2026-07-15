const RAD = Math.PI / 180, DEG = 180 / Math.PI;

function dayInfo(date) {
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 0);
  const doy = (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - yearStart) / 86400000;
  const ut = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  return { doy, ut };
}

// Solar declination (deg) + equation of time (min) — standard Fourier approximation (Spencer).
function solarDeclEot(doy) {
  const y = (2 * Math.PI / 365) * (doy - 1);
  const decl = 0.006918 - 0.399912 * Math.cos(y) + 0.070257 * Math.sin(y)
    - 0.006758 * Math.cos(2 * y) + 0.000907 * Math.sin(2 * y)
    - 0.002697 * Math.cos(3 * y) + 0.00148 * Math.sin(3 * y); // radians
  const eot = 229.18 * (0.000075 + 0.001868 * Math.cos(y) - 0.032077 * Math.sin(y)
    - 0.014615 * Math.cos(2 * y) - 0.040849 * Math.sin(2 * y)); // minutes
  return { declDeg: decl * DEG, eotMin: eot };
}

export function subsolarPoint(date) {
  const { doy, ut } = dayInfo(date);
  const { declDeg, eotMin } = solarDeclEot(doy);
  let lon = (12 - ut - eotMin / 60) * 15; // longitude where apparent solar time = noon
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return { lat: declDeg, lon };
}

export function terminatorLat(lonDeg, sub) {
  const t = Math.tan(sub.lat * RAD);
  if (Math.abs(t) < 1e-9) return 0;
  return Math.atan(-Math.cos((lonDeg - sub.lon) * RAD) / t) * DEG;
}

export function isNight(latDeg, lonDeg, sub) {
  const el = Math.sin(latDeg * RAD) * Math.sin(sub.lat * RAD)
    + Math.cos(latDeg * RAD) * Math.cos(sub.lat * RAD) * Math.cos((lonDeg - sub.lon) * RAD);
  return el < 0;
}

export function sunTimes(latDeg, lonDeg, date) {
  const { doy } = dayInfo(date);
  const { declDeg, eotMin } = solarDeclEot(doy);
  const lat = latDeg * RAD, decl = declDeg * RAD;
  const cosH = (Math.cos(90.833 * RAD) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl));
  if (cosH > 1) return { riseUTC: null, setUTC: null, dayHours: 0 };
  if (cosH < -1) return { riseUTC: null, setUTC: null, dayHours: 24 };
  const H = Math.acos(cosH) * DEG; // degrees of hour angle
  const noonUTC = 12 - lonDeg / 15 - eotMin / 60;
  const wrap = (h) => ((h % 24) + 24) % 24;
  return { riseUTC: wrap(noonUTC - H / 15), setUTC: wrap(noonUTC + H / 15), dayHours: 2 * H / 15 };
}
