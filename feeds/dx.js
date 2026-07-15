const BANDS = [
  [1800, 2000, "160m"], [3500, 4000, "80m"], [5250, 5450, "60m"], [7000, 7300, "40m"],
  [10100, 10150, "30m"], [14000, 14350, "20m"], [18068, 18168, "17m"], [21000, 21450, "15m"],
  [24890, 24990, "12m"], [28000, 29700, "10m"], [50000, 54000, "6m"], [144000, 148000, "2m"],
  [222000, 225000, "1.25m"], [420000, 450000, "70cm"],
];
export function bandFor(khz) { for (const [lo, hi, b] of BANDS) if (khz >= lo && khz <= hi) return b; return ""; }

export function parseSpots(json, limit = 25) {
  let arr;
  try { arr = typeof json === "string" ? JSON.parse(json) : json; } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const s of arr) {
    if (out.length >= limit) break;
    if (!s || s.dx_call == null || s.dx_latitude == null || s.dx_longitude == null) continue;
    const khz = Number(s.frequency) || 0;
    out.push({
      call: String(s.dx_call),
      freqKhz: khz,
      band: bandFor(khz),
      country: String(s.dx_country || ""),
      lat: Number(s.dx_latitude),
      lon: -Number(s.dx_longitude), // DXSummit is west-positive; negate to standard East-positive
      deCall: String(s.de_call || ""),
      time: String(s.time || ""),
    });
  }
  return out;
}

export function makeDxCache({ url, fetchImpl = fetch, refreshMs, limit = 25 }) {
  let items = [];
  let timer = null;
  async function refresh() {
    try {
      const res = await fetchImpl(url, {
        headers: { "user-agent": "W4EWB-ControlCenter/1.0 (W4EWB)" },
        signal: AbortSignal.timeout(12000),
      });
      const parsed = parseSpots(await res.text(), limit);
      if (parsed.length) items = parsed;
    } catch { /* keep last good */ }
  }
  if (refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); }
  return { get: () => items, refresh, stop: () => timer && clearInterval(timer) };
}
