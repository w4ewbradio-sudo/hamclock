// NCDXF/IARU International Beacon Project schedule -- pure computation, no
// fetch, no DOM, no Date.now(). 18 beacons rotate across 5 bands; each
// transmits 10 s per band on a 180 s cycle:
//   slot(t) = floor(utcSecondsOfDay / 10) % 18
//   beacon on band index b right now = BEACONS[((slot - b) % 18 + 18) % 18]
// Attribution (tile/legend/README): NCDXF/IARU.
import { gridToLatLon } from "./geo.js";

export const BEACON_BANDS = [
  { khz: 14100, label: "20m" },
  { khz: 18110, label: "17m" },
  { khz: 21150, label: "15m" },
  { khz: 24930, label: "12m" },
  { khz: 28200, label: "10m" },
];

// Slot order + Maidenhead grids from ncdxf.org (design spec, verified 2026-07-12).
const LIST = [
  ["4U1UN", "FN30as"], ["VE8AT", "CP38gh"], ["W6WX", "CM97bd"], ["KH6RS", "BL10ts"],
  ["ZL6B", "RE78tw"], ["VK6RBP", "OF87av"], ["JA2IGY", "PM84jk"], ["RR9O", "NO14kx"],
  ["VR2B", "OL72bg"], ["4S7B", "MJ96wv"], ["ZS6DN", "KG33xi"], ["5Z4B", "KI88hr"],
  ["4X6TU", "KM72jb"], ["OH2B", "KP20eh"], ["CS3B", "IM12jt"], ["LU4AA", "GF05tj"],
  ["OA4B", "FH17mw"], ["YV5B", "FK60nd"],
];

export function allBeacons() {
  return LIST.map(([call, grid], slot) => {
    const ll = gridToLatLon(grid);
    return { slot, call, grid, lat: ll?.lat ?? 0, lon: ll?.lon ?? 0 };
  });
}

export function slotAt(date) {
  const sec = date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds();
  return Math.floor(sec / 10) % 18;
}

// The 5 beacons transmitting right now, one per band (20m..10m order).
export function activeBeacons(date) {
  const slot = slotAt(date);
  const all = allBeacons();
  return BEACON_BANDS.map((band, b) => ({ ...band, ...all[((slot - b) % 18 + 18) % 18] }));
}
