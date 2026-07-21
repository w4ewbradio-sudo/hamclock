// PSK Reporter client: shared by the kiosk page and HamClock Web. PSKReporter
// has no CORS but supports JSONP (callback= — names must NOT start with "_",
// pskreporter strips leading underscores). HARD RULE per pskreporter.info usage
// policy: never query more often than once per 5 minutes; carry appcontact when
// the operator provides one. Pure helpers (mapPskJson/bandOfHz/modeColor) are
// DOM-free for node:test.

// PSKReporter JSONP JSON -> flat report shape.
// The `callsign=` query returns BOTH directions interleaved, so direction is a
// property of each ROW, not of the query: if we are the sender the remote end is
// the receiver (they heard us, dir "sender"); if we are the receiver the remote
// end is the sender (we heard them, dir "receiver"). rxCall/rxGrid always carry
// the REMOTE end because that's what the map plots and the panel lists.
export function mapPskJson(json, { call = "", limit = 50, band = "" } = {}) {
  const rr = json && Array.isArray(json.receptionReport) ? json.receptionReport : [];
  const me = String(call || "").trim().toUpperCase();
  // Newest report per direction+receiver+mode+band: a beaconing station gets
  // re-reported by the same receivers all day, and the map draws one line per
  // remote end anyway.
  const byKey = new Map();
  for (const r of rr) {
    const direction = String(r.senderCallsign || "").toUpperCase() === me ? "sender" : "receiver";
    const remoteCall = direction === "sender" ? r.receiverCallsign : r.senderCallsign;
    // Self-reception (we are BOTH ends) would plot a line from us to us.
    if (String(remoteCall || "").toUpperCase() === me) continue;
    const remoteGrid = direction === "sender" ? r.receiverLocator : r.senderLocator;
    if (!remoteGrid) continue;
    if (band && bandOfHz(r.frequency) !== band) continue;   // band filters client-side (no query param for it)
    const snr = Number(r.sNR);
    const rep = {
      rxCall: remoteCall || "",
      rxGrid: remoteGrid,
      txCall: (direction === "sender" ? r.senderCallsign : r.receiverCallsign) || "",
      freqHz: Number(r.frequency) || 0,
      mode: r.mode || "",
      snr: Number.isFinite(snr) ? snr : null,
      epoch: Number(r.flowStartSeconds) || 0,
      dir: direction,
    };
    const key = rep.dir + "|" + rep.rxCall + "|" + rep.mode + "|" + bandOfHz(rep.freqHz);
    const prev = byKey.get(key);
    if (!prev || rep.epoch > prev.epoch) byKey.set(key, rep);
  }
  // Fair-share the limit across modes: an always-on beacon (VARAC every few
  // minutes) otherwise fills the whole newest-first slice and every other mode
  // vanishes - a 24h "All" query would show zero of last night's FT8.
  const groups = new Map();
  for (const rep of byKey.values()) {
    if (!groups.has(rep.mode)) groups.set(rep.mode, []);
    groups.get(rep.mode).push(rep);
  }
  for (const g of groups.values()) g.sort((a, b) => b.epoch - a.epoch);
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let took = false;
    for (const g of groups.values()) {
      if (i < g.length && out.length < limit) { out.push(g[i]); took = true; }
    }
    if (!took) break;
  }
  out.sort((a, b) => b.epoch - a.epoch);
  return out;
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
// Callback names carry a per-page-load random token: two loads must never issue
// byte-identical query URLs (pskreporter answers a too-soon identical repeat with
// a throttle page instead of JSONP, which Chrome ORB-blocks).
let jsonpN = 0;
const jsonpTok = Math.random().toString(36).slice(2, 6);
export function jsonp(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const cb = "hcJsonpCb" + jsonpTok + (++jsonpN);
    const s = document.createElement("script");
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); delete window[cb]; s.remove(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error("jsonp timeout")), timeoutMs);
    window[cb] = (data) => done(resolve, data);
    s.onerror = () => done(reject, new Error("jsonp blocked (load error)"));
    // An ORB-blocked response "loads" as an empty script and never invokes the
    // callback - reject right away instead of burning the full timeout.
    s.onload = () => done(reject, new Error("jsonp blocked (empty answer)"));
    s.src = url + (url.includes("?") ? "&" : "?") + "callback=" + cb;
    document.head.appendChild(s);
  });
}

const MIN_MS = 5 * 60 * 1000;

// How far back a single upstream query asks. Deliberately short and independent of
// the operator's display window - see the note at the query site: the endpoint
// truncates by result volume, so a long window returns a partial, mode-skewed
// answer while a short one returns a complete slice that retention accumulates.
const QUERY_WINDOW_SEC = 3600;

// Display-time filter over the retained set. The cache holds BOTH directions and
// ALL modes; the page filters what it SHOWS, so clicking a mode/band/direction chip
// is instant, fires NO pskreporter query, and can never blank the retained data.
// Shared by the kiosk (over the server layer) and HamClock Web (over the JSONP cache).
export function filterPskReports(reports, { direction = "both", mode = "", band = "", windowSec = 0 } = {}, nowMs = Date.now()) {
  const nowS = nowMs / 1000;
  return (reports || []).filter((r) => {
    if (direction !== "both" && r.dir && r.dir !== direction) return false;
    if (mode && !String(r.mode || "").toUpperCase().startsWith(mode.toUpperCase())) return false;
    if (band && bandOfHz(r.freqHz) !== band) return false;
    if (windowSec && r.epoch && nowS - r.epoch > windowSec) return false;
    return true;
  });
}

// How long a spot stays on the map after it was last reported. Retaining spots
// across polls is what stops the display from blanking during the things that
// kept wiping it: pskreporter 503s / empty-throttle answers, brief quiet gaps,
// and mode switches (VARAC beacon <-> FT8 receive). Honors a long window if set,
// but always keeps at least 2h so a receive-only or between-beacons lull holds.
function retentionMs(windowSec) {
  return Math.min(Math.max((windowSec || 1800) * 1000, 2 * 3600000), 24 * 3600000);
}

// getStation() -> {call,...}; getPsk() -> {direction:"sender"|"receiver"|"both", windowSec, mode, band, contact}
// Injectables (jsonpImpl/storage/nowFn/rand) exist for node:test; browser callers
// pass none of them. onUpdate fires after EVERY query outcome so the page can
// merge + redraw immediately instead of waiting for its next layers tick.
const LS_KEY = "hcPskCache1";

export function makePskJsonpCache({ getStation, getPsk, minMs = MIN_MS, jsonpImpl = jsonp, storage = null, nowFn = Date.now, rand = Math.random, onUpdate = null, forceFloorMs = 15000 }) {
  const store = () => storage || localStorage;    // resolved lazily; guarded by try/catch below
  const load = () => { try { return JSON.parse(store().getItem(LS_KEY)) || null; } catch { return null; } };
  const ping = () => { try { onUpdate && onUpdate(); } catch { /* ui hook must not kill the poll loop */ } };
  // Two page loads must never issue an identical query URL: pskreporter answers a
  // too-soon identical repeat with a throttle page (non-JSONP -> ORB-blocked in
  // Chrome). Shaving a random sliver off the window makes every load distinct.
  const jitterSec = Math.floor(rand() * 120);

  // retained: one entry per (direction, remote call, mode, band); newest epoch wins.
  // The map draws a line DE -> remote grid for each, so both directions coexist.
  const retained = new Map();
  const spotKey = (s) => s.dir + "|" + s.rxCall + "|" + s.mode + "|" + bandOfHz(s.freqHz);
  const prune = (retMs, now) => { for (const [k, s] of retained) if (now - (s.epoch || 0) * 1000 > retMs) retained.delete(k); };
  const list = (now, retMs) => [...retained.values()]
    .filter((s) => now - (s.epoch || 0) * 1000 <= retMs)
    .sort((a, b) => b.epoch - a.epoch).slice(0, 300);

  let updated = null;
  let status = { at: null, note: "starting" };   // last-query outcome, shown in the panel
  let timer = null, pendingT = null, lastRun = 0, filterKey = null, lastRetMs = retentionMs(1800);

  const save = () => { try { store().setItem(LS_KEY, JSON.stringify({ at: lastRun, updated, filterKey, retained: [...retained.values()] })); } catch { /* session-only */ } };

  // Restore last-good spots (aged) so a reload shows lines instantly, and a reload
  // inside the 5-minute gap does NOT re-query (pskreporter soft-throttles chatty IPs).
  // Restore filterKey too, so the first poll only clears when the SAVED filter
  // differs from the current one - not just because filterKey started null.
  const saved = load();
  if (saved && Array.isArray(saved.retained) && nowFn() - (saved.at || 0) < 24 * 3600 * 1000) {
    for (const s of saved.retained) if (s && s.rxCall) retained.set(spotKey(s), s);
    prune(lastRetMs, nowFn());
    updated = saved.updated || null;
    lastRun = saved.at || 0;
    // filterKey is now just the callsign; older saves baked filters in
    // ("W4EWB|FT8||both") - take the call part so a restore never looks like
    // a callsign change (which would clear the spots we just loaded).
    filterKey = String(saved.filterKey || "").split("|")[0] || null;
  }

  async function refresh(force) {
    let windowSec = 0, retMs = lastRetMs;   // hoisted so the catch can still age + hint
    try {
      const p = getPsk();
      const me = String(getStation()?.call || "").trim().toUpperCase();
      if (!me || me === "N0CALL") { status = { at: new Date().toISOString(), note: "no callsign set" }; return; }
      // windowSec is the operator's DISPLAY window; it drives retention and the
      // display-time filter, and may be as long as 24h.
      windowSec = Math.min(86000, Math.floor(p.windowSec || 1800));
      retMs = lastRetMs = retentionMs(windowSec);

      // Queries are UNFILTERED (no mode/band/direction baked in): direction, mode
      // and band are display-time filters (filterPskReports), so a settings change
      // is instant and can never blank the retained data. Only a CALLSIGN change
      // invalidates the set. (Baking filters into the query was the "picking a
      // mode wiped the map / refresh came back empty" bug: the clear ran before
      // the etiquette floor even allowed a replacement query.)
      if (filterKey !== null && me !== filterKey) retained.clear();
      filterKey = me;

      // Big windows (6h/24h) are heavier queries: back off to 15-minute re-polls.
      const gap = windowSec >= 21600 ? 15 * 60000 : Math.max(minMs, MIN_MS);
      if (nowFn() - lastRun < (force ? forceFloorMs : gap - 5000)) {
        // A settings change inside the etiquette floor must not vanish (the next
        // poll is minutes away): defer it to just past the floor, one at a time.
        if (force && !pendingT) {
          const wait = Math.max(50, forceFloorMs - (nowFn() - lastRun));
          pendingT = setTimeout(() => { pendingT = null; refresh(true); }, wait);
        }
        return;
      }
      if (pendingT) { clearTimeout(pendingT); pendingT = null; }   // this run supersedes any deferred one
      lastRun = nowFn();

      // ONE query covers BOTH directions. This used to alternate senderCallsign /
      // receiverCallsign per poll because retrieve.pskreporter.info/query answers
      // only one side at a time - but that endpoint now 503s every caller, and the
      // alternation also left each direction stale for a whole interval. `callsign=`
      // against the backend pskreporter.info's own map uses returns our
      // transmissions AND our receptions together, so one query per poll still
      // honors the >= 5 min etiquette floor while keeping both sides fresh.
      // The QUERY window is capped short and is NOT the display window. The endpoint
      // truncates by result VOLUME: an unfiltered 24h request comes back holding only
      // the most recent ~1h, because a busy FT8 receive period fills the cap and
      // crowds every other mode out of the answer. Asking for one hour returns a
      // COMPLETE hour with all modes present, and 5-minute polling into the retained
      // set accumulates the operator's longer window over time.
      const qWindow = Math.max(600, Math.min(QUERY_WINDOW_SEC, windowSec) - jitterSec);
      const url = "https://pskreporter.info/cgi-bin/pskquery5.pl?rronly=1"
        + "&flowStartSeconds=-" + qWindow
        + "&callsign=" + encodeURIComponent(me)
        + (p.contact ? "&appcontact=" + encodeURIComponent(p.contact) : "");
      const json = await jsonpImpl(url);
      const limit = windowSec >= 21600 ? 300 : 100;     // long windows plot more of the story
      const fresh = mapPskJson(json, { call: me, limit });
      const now = nowFn();
      for (const s of fresh) retained.set(spotKey(s), s);
      prune(retMs, now);
      updated = new Date().toISOString();
      status = { at: updated, note: (fresh.length ? fresh.length + " new / " : "") + retained.size + " held (TX+RX)" };
      save(); ping();
    } catch (e) {
      // Never wipe on a throttle/timeout: keep the retained spots (aged) on the map.
      prune(retMs, nowFn());
      const blocked = /blocked/i.test(e && e.message || "");
      status = {
        at: new Date().toISOString(),
        note: (blocked ? "throttled" : "no answer")
          + (retained.size ? " - showing last " + retained.size : "")
          + (windowSec >= 21600 ? " (try 1h)" : ""),
      };
      save(); ping();
    }
  }
  return {
    get: () => ({ updated, reports: list(nowFn(), lastRetMs), status }),
    refresh: () => refresh(true),
    start() { refresh(false); timer = setInterval(() => refresh(false), Math.max(minMs, MIN_MS)); },
    stop() { if (timer) clearInterval(timer); if (pendingT) { clearTimeout(pendingT); pendingT = null; } },
  };
}
