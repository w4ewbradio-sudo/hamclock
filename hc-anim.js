// Satellite-animation timeline math (pure, node:test-able).
// GIBS DescribeDomains lists a layer's valid TIMEs as comma-separated
// "start/end/PT<step>M" ranges WITH GAPS (outages) - never assume a
// contiguous grid. Frame times come from enumerating those ranges.
export function parseDomainRanges(xml) {
  const out = [];
  const re = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\/PT(\d+)M/g;
  let m;
  while ((m = re.exec(String(xml || ""))) !== null) out.push({ start: m[1], end: m[2], stepMin: Number(m[3]) });
  return out;
}

export function lastTimes(ranges, count) {
  const all = [];
  for (const r of ranges) {
    const step = (r.stepMin > 0 ? r.stepMin : 10) * 60000;
    for (let t = Date.parse(r.start); t <= Date.parse(r.end); t += step) {
      all.push(new Date(t).toISOString().replace(".000Z", "Z"));
    }
  }
  all.sort();
  return all.slice(-count);
}

export function unionTimes(a, b, count) {
  return [...new Set([...(a || []), ...(b || [])])].sort().slice(-count);
}

export function nearestAtOrBefore(times, t) {
  let best = null;
  for (const x of times || []) { if (x <= t) best = x; else break; }
  return best;
}

// prevDay lives in hc-gibs.js; re-implemented here would drift - import it.
import { prevDay } from "./hc-gibs.js";
export function flipbookDates(latestCompleteIso, count) {
  const out = [latestCompleteIso];
  while (out.length < count) out.unshift(prevDay(out[0]));
  return out;
}

// Earth-disk footprint of a geostationary satellite: the cap of angular radius
// `radiusDeg` around the sub-satellite point (on the equator). GOES GeoColor
// imagery carries opaque junk outside the real disk (gray limb halo + a yellow
// edge line), so composites must clip to this cap - a few degrees inside the
// geometric limb (81.3 deg) to crop the fuzzy border. Longitudes are returned
// CONTINUOUS around subLon (may exceed +-180): the equirect consumer draws the
// polygon at x, x-W, x+W to cover antimeridian wrap.
export function footprintPoints(subLonDeg, radiusDeg, steps = 90) {
  const rad = Math.PI / 180, d = radiusDeg * rad;
  const out = [];
  for (let i = 0; i < steps; i++) {
    const th = (i / steps) * 2 * Math.PI;               // bearing from north
    const lat = Math.asin(Math.sin(d) * Math.cos(th));
    const dLon = Math.atan2(Math.sin(th) * Math.sin(d), Math.cos(d));
    out.push([subLonDeg + dLon / rad, lat / rad]);
  }
  return out;
}

// A geostationary layer is only worth animating if its NEWEST frame is recent:
// a feed hours behind (GIBS's East ingest has stalled for 14h+ at a stretch)
// contributes a frozen - and often partially-ingested - disc.
export function freshEnough(times, nowMs, maxAgeMs) {
  const newest = times && times.length ? times[times.length - 1] : null;
  return !!newest && nowMs - Date.parse(newest) < maxAgeMs;
}

// Missing-sector detector: GIBS renders a partially-ingested GeoColor frame's
// missing region as flat WHITE (with a yellow boundary). Real cloud fields are
// textured and rarely saturate; a large opaque near-white fraction marks a
// broken frame. Input is RGBA pixel data; returns white/opaque ratio.
export function whiteFrac(rgba) {
  let opaque = 0, white = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 200) continue;
    opaque++;
    if (rgba[i] >= 246 && rgba[i + 1] >= 246 && rgba[i + 2] >= 246) white++;
  }
  return opaque ? white / opaque : 0;
}

// Cross-fade timing for the DAYS flipbook: 0 through the hold window, then a
// linear 0->1 ramp across the fade window, clamped at 1.
export function fadeAlpha(elapsedMs, holdMs, fadeMs) {
  if (elapsedMs <= holdMs) return 0;
  return Math.min(1, (elapsedMs - holdMs) / fadeMs);
}

const WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&CRS=EPSG:4326&BBOX=-90,-180,90,180";
export function goesUrl(layer, isoTime, w, h) {
  return `${WMS}&LAYERS=${layer}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=TRUE&TIME=${isoTime}`;
}
export function viirsUrl(layer, isoDate, w, h) {
  return `${WMS}&LAYERS=${layer}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/jpeg&TIME=${isoDate}`;
}
