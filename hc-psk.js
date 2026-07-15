// PSK Reporter client: shared by the kiosk page and HamClock Web. PSKReporter
// has no CORS but supports JSONP (callback= — names must NOT start with "_",
// pskreporter strips leading underscores). HARD RULE per pskreporter.info usage
// policy: never query more often than once per 5 minutes; carry appcontact when
// the operator provides one. Pure helpers (mapPskJson/bandOfHz/modeColor) are
// DOM-free for node:test.

// PSKReporter JSONP JSON -> flat report shape (same as the old XML parser).
// direction "sender": reports OF my transmissions (who hears me) - remote = receiver.
// direction "receiver": what I hear - remote = sender. rxCall/rxGrid carry the
// REMOTE end because that's what the map plots and the panel lists.
export function mapPskJson(json, { direction = "sender", limit = 50 } = {}) {
  const rr = json && Array.isArray(json.receptionReport) ? json.receptionReport : [];
  const out = [];
  for (const r of rr) {
    const remoteCall = direction === "sender" ? r.receiverCallsign : r.senderCallsign;
    const remoteGrid = direction === "sender" ? r.receiverLocator : r.senderLocator;
    if (!remoteGrid) continue;
    const snr = Number(r.sNR);
    out.push({
      rxCall: remoteCall || "",
      rxGrid: remoteGrid,
      txCall: (direction === "sender" ? r.senderCallsign : r.receiverCallsign) || "",
      freqHz: Number(r.frequency) || 0,
      mode: r.mode || "",
      snr: Number.isFinite(snr) ? snr : null,
      epoch: Number(r.flowStartSeconds) || 0,
    });
  }
  out.sort((a, b) => b.epoch - a.epoch);
  return out.slice(0, limit);
}

// freqHz -> band name (mirrors the server's dx.js table; kept here so the
// overlay can band-color PSK reports without a server import).
const BANDS_HZ = [
  [1800e3, 2000e3, "160m"], [3500e3, 4000e3, "80m"], [5250e3, 5450e3, "60m"],
  [7000e3, 7300e3, "40m"], [10100e3, 10150e3, "30m"], [14000e3, 14350e3, "20m"],
  [18068e3, 18168e3, "17m"], [21000e3, 21450e3, "15m"], [24890e3, 24990e3, "12m"],
  [28000e3, 29700e3, "10m"], [50000e3, 54000e3, "6m"], [144000e3, 148000e3, "2m"],
  [420000e3, 450000e3, "70cm"],
];
export function bandOfHz(hz) {
  const f = Number(hz) || 0;
  for (const [lo, hi, b] of BANDS_HZ) if (f >= lo && f <= hi) return b;
  return "";
}

// Mode palette for the PSK overlay's color-by-mode option. Family matching so
// VARAC/"VARA HF" share a hue and FT8/FT4 stay distinguishable.
export const MODE_COLORS = [
  ["FT8", "#5be68a"], ["FT4", "#a7e65b"], ["JS8", "#5be6d0"],
  ["VARA", "#e65bd0"], ["SSTV", "#e6905b"], ["CW", "#5bb0e6"],
  ["PSK", "#b06be6"], ["RTTY", "#e6c95b"], ["WSPR", "#8a8fe6"],
  ["OLIVIA", "#e65b8a"], ["MFSK", "#8ae65b"],
];
export function modeColor(mode) {
  const m = String(mode || "").toUpperCase();
  for (const [k, c] of MODE_COLORS) if (m.startsWith(k) || (k === "VARA" && m.includes("VARA"))) return c;
  return "#40e0d0";
}

// ---- JSONP transport (browser only) ----
let jsonpN = 0;
export function jsonp(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cb = "hcJsonpCb" + (++jsonpN);
    const s = document.createElement("script");
    const done = (fn, v) => { clearTimeout(timer); delete window[cb]; s.remove(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error("jsonp timeout")), timeoutMs);
    window[cb] = (data) => done(resolve, data);
    s.onerror = () => done(reject, new Error("jsonp load error"));
    s.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
    document.head.appendChild(s);
  });
}

const MIN_MS = 5 * 60 * 1000;

// getStation() -> {call,...}; getPsk() -> {direction, windowSec, contact}
export function makePskJsonpCache({ getStation, getPsk, minMs = MIN_MS }) {
  let data = { updated: null, reports: [] };
  let timer = null, lastRun = 0;
  async function refresh(force) {
    try {
      const p = getPsk();
      const me = String(getStation()?.call || "").trim().toUpperCase();
      if (!me || me === "N0CALL") return;               // unconfigured: zero upstream traffic
      const windowSec = Math.floor(p.windowSec || 1800);
      // Big windows (6h/24h) are heavier queries: back off to 15-minute re-polls.
      const gap = windowSec >= 21600 ? 15 * 60000 : Math.max(minMs, MIN_MS);
      if (!force && Date.now() - lastRun < gap - 5000) return;
      lastRun = Date.now();
      const who = p.direction === "receiver" ? "receiverCallsign" : "senderCallsign";
      const url = "https://retrieve.pskreporter.info/query?" + who + "=" + encodeURIComponent(me)
        + "&flowStartSeconds=-" + windowSec + "&rronly=1"
        + (p.contact ? "&appcontact=" + encodeURIComponent(p.contact) : "");
      const json = await jsonp(url);
      const limit = windowSec >= 21600 ? 200 : 50;      // long windows plot more of the story
      data = { updated: new Date().toISOString(), reports: mapPskJson(json, { direction: p.direction || "sender", limit }) };
    } catch { /* keep last good; retry next interval */ }
  }
  return {
    get: () => data,
    refresh: () => refresh(true),
    start() { refresh(true); timer = setInterval(() => refresh(false), Math.max(minMs, MIN_MS)); },
    stop() { if (timer) clearInterval(timer); },
  };
}
