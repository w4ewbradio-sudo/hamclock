// GIBS satellite-basemap date math (pure, node:test-able).
// A VIIRS daily composite keeps filling for many hours after its UTC date ends:
// the domain's newest date is today's partial mosaic, and even "yesterday" can
// still be missing whole swaths (seen live 2026-07-16 00:30Z: the 07-15 mosaic
// had a black Pacific wedge). latest-2 is the newest date guaranteed complete.
export function prevDay(iso) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
export function completeSatDate(latestIso) {
  return prevDay(prevDay(latestIso));
}
