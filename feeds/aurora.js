// NOAA SWPC OVATION aurora nowcast cache. The JSON is a 1°x1° global grid of
// aurora probability (0-100%) given as [lon(0-359), lat(-90..90), value] triples
// under "coordinates". We keep only cells at/above minVal (the visible oval) so
// the layers payload stays small. Never throws; keeps the last good grid.
export function parseAurora(text, { minVal = 5 } = {}) {
  let obj = text;
  if (typeof text === "string") { try { obj = JSON.parse(text); } catch { return null; } }
  const coords = obj?.coordinates;
  if (!Array.isArray(coords)) return null;
  const points = [];
  for (const c of coords) {
    if (!Array.isArray(c) || c.length < 3) continue;
    const val = Number(c[2]);
    if (!Number.isFinite(val) || val < minVal) continue;
    let lon = Number(c[0]); const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (lon > 180) lon -= 360;                 // OVATION lon is 0..359 -> standard -180..180
    points.push([lon, lat, val]);
  }
  return { points, forecast: obj["Forecast Time"] || obj["Observation Time"] || null };
}

export function makeAuroraCache({ url, fetchImpl = fetch, refreshMs, minVal = 5 }) {
  let data = { updated: null, points: [], forecast: null };
  let timer = null;
  async function refresh() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      const parsed = parseAurora(await res.text(), { minVal });
      if (parsed) data = { updated: new Date().toISOString(), ...parsed }; // only replace on a good parse
    } catch { /* keep last good; retry next interval */ }
  }
  if (refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); }
  return { get: () => data, refresh, stop: () => timer && clearInterval(timer) };
}
