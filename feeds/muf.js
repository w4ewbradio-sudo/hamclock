// KC2G MUF(3000) contour cache (prop.kc2g.com GeoJSON render).
// Mandatory attribution on the client: "MUF: prop.kc2g.com (KC2G) - data via GIRO/INGV".
export function parseMuf(geojson) {
  let g;
  try { g = typeof geojson === "string" ? JSON.parse(geojson) : geojson; } catch { return { contours: [] }; }
  if (!g || !Array.isArray(g.features)) return { contours: [] };
  const contours = [];
  for (const f of g.features) {
    if (!f || f.geometry?.type !== "LineString" || !Array.isArray(f.geometry.coordinates)) continue;
    const mufd = Number(f.properties?.["level-value"]);
    if (!Number.isFinite(mufd)) continue;
    const points = f.geometry.coordinates.filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]));
    if (points.length < 2) continue;
    contours.push({ mufd, color: String(f.properties?.stroke || ""), points });
  }
  return { contours };
}

export function makeMufCache({ url, fetchImpl = fetch, refreshMs }) {
  let data = { updated: null, contours: [] };
  let timer = null;
  async function refresh() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      const parsed = parseMuf(await res.text());
      if (parsed.contours.length) data = { updated: new Date().toISOString(), contours: parsed.contours }; // only replace on a good parse
    } catch { /* keep last good; retry next interval */ }
  }
  if (refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); }
  return { get: () => data, refresh, stop: () => timer && clearInterval(timer) };
}
