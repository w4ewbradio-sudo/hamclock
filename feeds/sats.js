// CelesTrak TLE cache for the HamClock sats overlay.
// Parser: scan for adjacent "1 NNNNN..."/"2 NNNNN..." pairs with matching NORAD ids;
// keep only watchlisted ids; display names come from the curated watchlist (the feed's
// name lines are unreliable in excerpts and carry noisy suffixes like "(ZARYA)").
export function parseTLEs(text, watchlist) {
  if (typeof text !== "string" || !text) return [];
  const wanted = new Map((watchlist || []).map((w) => [Number(w.norad), String(w.name)]));
  if (!wanted.size) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < lines.length - 1; i++) {
    const m1 = /^1 (\d{5})/.exec(lines[i]);
    const m2 = /^2 (\d{5})/.exec(lines[i + 1]);
    if (!m1 || !m2 || m1[1] !== m2[1]) continue;
    const noradId = Number(m1[1]);
    if (!wanted.has(noradId) || seen.has(noradId)) continue;
    seen.add(noradId);
    out.push({ name: wanted.get(noradId), noradId, tle1: lines[i].trimEnd(), tle2: lines[i + 1].trimEnd() });
  }
  return out;
}

export function makeSatsCache({ url, fetchImpl = fetch, refreshMs, watchlist }) {
  let data = { updated: null, sats: [] };
  let timer = null;
  async function refresh() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      // CelesTrak usage policy: on ANY non-200, keep last good and return WITHOUT
      // retrying — the next scheduled interval tick is the only retry. Repeated
      // hammering of celestrak.org gets the IP firewalled.
      if (!res.ok) return;
      const sats = parseTLEs(await res.text(), watchlist);
      if (sats.length) data = { updated: new Date().toISOString(), sats }; // only replace on a good parse
    } catch { /* keep last good; retry next interval */ }
  }
  if (refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); }
  return { get: () => data, refresh, stop: () => timer && clearInterval(timer) };
}
