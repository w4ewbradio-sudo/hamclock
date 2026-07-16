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

const WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&CRS=EPSG:4326&BBOX=-90,-180,90,180";
export function goesUrl(layer, isoTime, w, h) {
  return `${WMS}&LAYERS=${layer}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/png&TRANSPARENT=TRUE&TIME=${isoTime}`;
}
export function viirsUrl(layer, isoDate, w, h) {
  return `${WMS}&LAYERS=${layer}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/jpeg&TIME=${isoDate}`;
}
