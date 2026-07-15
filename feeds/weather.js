// open-meteo current conditions for the HamClock weather tile (keyless).
// Attribution (client tile): "open-meteo.com". Mirrors solar.js: never-throws,
// last-good, AbortSignal.timeout, unref'd timer.

// WMO 4677 weather interpretation codes -> short kiosk text.
const WMO = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Fog", 48: "Rime fog",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Frz drizzle", 57: "Frz drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain",
  66: "Frz rain", 67: "Frz rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
  80: "Showers", 81: "Showers", 82: "Violent showers",
  85: "Snow showers", 86: "Snow showers",
  95: "Thunderstorm", 96: "T-storm hail", 99: "T-storm hail",
};
export function wmoText(code) {
  if (code == null || code === "") return "-"; // Number(null) is 0 -> would wrongly read "Clear"
  return WMO[Number(code)] ?? "-";
}

// open-meteo ...&current=temperature_2m,relative_humidity_2m,wind_speed_10m,
// wind_direction_10m,weather_code -> { current: { temperature_2m, ... } }.
export function parseWeather(json) {
  let j;
  try { j = typeof json === "string" ? JSON.parse(json) : json; } catch { return null; }
  const c = j?.current;
  if (!c || !Number.isFinite(Number(c.temperature_2m))) return null;
  const code = Number(c.weather_code);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    tempF: Number(c.temperature_2m),
    humidity: num(c.relative_humidity_2m),
    windMph: num(c.wind_speed_10m),
    windDir: num(c.wind_direction_10m),
    code: Number.isFinite(code) ? code : null,
    text: wmoText(code),
  };
}

export function makeWeatherCache({ url, fetchImpl = fetch, refreshMs }) {
  let data = null;
  let timer = null;
  async function refresh() {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000) });
      const parsed = parseWeather(await res.text());
      if (parsed) data = { ...parsed, updated: new Date().toISOString() }; // only replace on a good parse
    } catch { /* keep last good; retry next interval */ }
  }
  if (refreshMs > 0) { timer = setInterval(refresh, refreshMs); timer.unref?.(); }
  return { get: () => data, refresh, stop: () => timer && clearInterval(timer) };
}
