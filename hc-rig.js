// Rig tile data source for HamClock. Maintains a live receive-audio waterfall
// (offscreen scrolling canvas fed by the /api/rig/spectrum SSE) plus rig status
// (/api/rig, polled). Calls a redraw callback so the single tile repaints in place.
// Everything is gated on tab visibility so the shack-PC capture process only runs
// while someone is actually looking at the HamClock.

const WF_H = 64; // offscreen waterfall history height (px); blitted/scaled into the tile

// Thermal palette (0..255 -> rgb), matched to the Rig tab's waterfall.
const PALETTE = (() => {
  const stops = [[0, 0, 8], [16, 24, 120], [24, 150, 170], [40, 200, 90], [240, 220, 60], [255, 255, 255]];
  const p = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const a = Math.min(stops.length - 1, Math.floor(t));
    const b = Math.min(stops.length - 1, a + 1);
    const f = t - a;
    p[i * 3] = Math.round(stops[a][0] + (stops[b][0] - stops[a][0]) * f);
    p[i * 3 + 1] = Math.round(stops[a][1] + (stops[b][1] - stops[a][1]) * f);
    p[i * 3 + 2] = Math.round(stops[a][2] + (stops[b][2] - stops[a][2]) * f);
  }
  return p;
})();

// Shared, mutable state read by the tile's draw(). `wf` is the offscreen canvas.
export const rigState = { online: false, hz: null, band: null, mode: null, vfo: null, ptt: null, meters: {}, wf: null, spectrum: false };

let es = null, pollTimer = null, redraw = null, off = null, offctx = null, running = false;

function b64ToBytes(b64) {
  const s = atob(b64);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

function ensureOff(n) {
  if (off && off.width === n) return;
  off = document.createElement("canvas");
  off.width = n; off.height = WF_H;
  offctx = off.getContext("2d");
  offctx.fillStyle = "#000"; offctx.fillRect(0, 0, n, WF_H);
  rigState.wf = off;
}

function drawFrame(f) {
  const bytes = b64ToBytes(f.d);
  const n = f.n || bytes.length;
  if (!n) return;
  ensureOff(n);
  offctx.drawImage(off, 0, 0, n, WF_H - 1, 0, 1, n, WF_H - 1); // scroll down 1px
  const row = offctx.createImageData(n, 1);
  for (let x = 0; x < n; x++) {
    const v = bytes[x] * 3, o = x * 4;
    row.data[o] = PALETTE[v]; row.data[o + 1] = PALETTE[v + 1]; row.data[o + 2] = PALETTE[v + 2]; row.data[o + 3] = 255;
  }
  offctx.putImageData(row, 0, 0);
  rigState.spectrum = true;
  redraw && redraw();
}

async function pollStatus() {
  try {
    const j = await (await fetch("/api/rig")).json();
    rigState.online = j.online; rigState.hz = j.hz; rigState.band = j.band;
    rigState.mode = j.mode; rigState.vfo = j.vfo || null; rigState.ptt = j.ptt; rigState.meters = j.meters || {};
  } catch { rigState.online = false; }
  redraw && redraw();
}

function openSse() {
  if (es || typeof EventSource === "undefined") return;
  es = new EventSource("/api/rig/spectrum");
  es.onmessage = (ev) => {
    let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.err) { rigState.spectrum = false; return; }
    drawFrame(f);
  };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}
function closeSse() { if (es) { try { es.close(); } catch { /* gone */ } es = null; } rigState.spectrum = false; }

function resume() {
  if (!running) return;
  openSse();
  if (!pollTimer) { pollStatus(); pollTimer = setInterval(pollStatus, 3000); }
}
function suspend() {
  closeSse();
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
function onVis() { if (document.hidden) suspend(); else resume(); }

export function startRig(onUpdate) {
  redraw = onUpdate;
  running = true;
  resume();
  document.addEventListener("visibilitychange", onVis);
}
export function stopRig() {
  running = false;
  suspend();
  document.removeEventListener("visibilitychange", onVis);
}
