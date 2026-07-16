function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`, "i"));
  return m ? m[1].trim() : null;
}

export function parseSolar(xml) {
  if (!xml || !/<solardata/i.test(xml)) return null;
  const bands = {};
  const re = /<band\s+name="([^"]+)"\s+time="([^"]+)"\s*>([^<]*)<\/band>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, name, time, val] = m;
    (bands[name] ||= {})[time.toLowerCase()] = val.trim();
  }
  const flux = tag(xml, "solarflux");
  if (flux == null && !Object.keys(bands).length) return null;
  return {
    flux, sunspots: tag(xml, "sunspots"), aIndex: tag(xml, "aindex"),
    kIndex: tag(xml, "kindex"), xray: tag(xml, "xray"), aurora: tag(xml, "aurora"),
    solarwind: tag(xml, "solarwind"), updated: tag(xml, "updated"), bands,
  };
}

export function makeSolarCache({ url, fetchImpl = fetch, refreshMs }) {
  let data = null;
  let timer = null;
  async function refresh() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
      const parsed = parseSolar(await res.text());
      if (parsed) data = parsed; // only replace on a good parse
    } catch { /* keep last good; retry next interval */ }
  }
  if (refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); }
  return { get: () => data, refresh, stop: () => timer && clearInterval(timer) };
}
