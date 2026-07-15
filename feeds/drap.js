// NOAA SWPC DRAP (D-Region Absorption Prediction) global grid cache.
// Format: '#' comments, a longitude header row, an all-dashes separator, then
// data rows "  <lat> |  <mhz> <mhz> ..." (lat descending 89..-89 step -2).
export function parseDrap(text) {
  if (typeof text !== "string" || !text) return null;
  let lons = null;
  const lats = [], grid = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || /^-+$/.test(t)) continue;   // blank, comment, dashes separator
    if (!line.includes("|")) {
      // the one non-piped numeric row is the longitude header
      const vals = t.split(/\s+/).map(Number);
      if (!lons && vals.length > 1 && vals.every(Number.isFinite)) lons = vals;
      continue;
    }
    const [latPart, dataPart] = line.split("|");
    const lat = Number(latPart.trim());
    const row = (dataPart || "").trim().split(/\s+/).map(Number);
    if (!Number.isFinite(lat) || !row.length || !row.every(Number.isFinite)) continue;
    lats.push(lat);
    grid.push(row);
  }
  if (!lons || !grid.length || grid.some((r) => r.length !== lons.length)) return null;
  return { lats, lons, grid };
}

export function makeDrapCache({ url, fetchImpl = fetch, refreshMs }) {
  let data = { updated: null, lats: [], lons: [], grid: [] };
  let timer = null;
  async function refresh() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      const parsed = parseDrap(await res.text());
      if (parsed) data = { updated: new Date().toISOString(), ...parsed }; // only replace on a good parse
    } catch { /* keep last good; retry next interval */ }
  }
  if (refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); }
  return { get: () => data, refresh, stop: () => timer && clearInterval(timer) };
}
