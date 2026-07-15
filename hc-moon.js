// Phase-accurate moon renderer for the HamClock moon tile + map marker.
// The PURE geometry (unit-tested in Node) is separated from the canvas draw:
//   phaseGeometry(fraction)    -> terminator ellipse ratio + which side the ellipse belongs to
//   sunEquatorial(date)        -> low-precision solar RA/dec, degrees (Meeus ch. 25)
//   brightLimbAngle(sun, moon) -> position angle of the bright limb, deg E of N (Meeus 48.5)
//   drawMoon(...)              -> canvas draw (browser only; never called in Node tests)
const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;

// Terminator geometry for a unit disc: the terminator projects to a
// half-ellipse with semi-minor axis |1 - 2f|. f=0 new (all dark), f=0.5
// quarter (straight terminator), f=1 full (all lit). litMajor says whether
// the ellipse lobe belongs to the lit side (gibbous) or dark side (crescent).
export function phaseGeometry(fraction) {
  const f = Math.min(1, Math.max(0, Number(fraction) || 0));
  return {
    ellipseRatio: Math.abs(1 - 2 * f),
    litMajor: f > 0.5,
    darkFraction: 1 - f,
  };
}

// Low-precision solar RA/dec (Meeus ch. 25 truncation, ~0.01 deg) -- enough
// to orient the bright limb on a kiosk tile.
export function sunEquatorial(date) {
  const T = (date.getTime() / 86400000 + 2440587.5 - 2451545.0) / 36525;
  const M = norm360(357.5291092 + 35999.0502909 * T) * RAD;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const C = (1.914602 - 0.004817 * T) * Math.sin(M)
    + 0.019993 * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const lam = norm360(L0 + C) * RAD;
  const eps = (23.4392911 - 0.0130042 * T) * RAD;
  return {
    ra: norm360(Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * DEG),
    dec: Math.asin(Math.sin(eps) * Math.sin(lam)) * DEG,
  };
}

// Meeus (48.5): position angle of the moon's bright limb, degrees E of N.
// sun/moon: { ra, dec } in degrees (moon's from astro-moon.js moonPosition()).
export function brightLimbAngle(sun, moon) {
  const da = (sun.ra - moon.ra) * RAD;
  const ds = sun.dec * RAD, dm = moon.dec * RAD;
  return norm360(Math.atan2(
    Math.cos(ds) * Math.sin(da),
    Math.sin(ds) * Math.cos(dm) - Math.cos(ds) * Math.sin(dm) * Math.cos(da),
  ) * DEG);
}

// Canvas draw. phase = { fraction, angleDeg } (angleDeg = bright-limb position
// angle; the dark-limb shading is rotated so the lit edge faces the sun).
// texture: CanvasImageSource | null -- null falls back to a flat gray disc so
// the kiosk still renders if moon.jpg is missing. Guarded: never throws out.
export function drawMoon(ctx, cx, cy, r, phase, texture = null) {
  ctx.save();
  try {
    const { ellipseRatio, litMajor } = phaseGeometry(phase.fraction);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.clip();
    if (texture) ctx.drawImage(texture, cx - r, cy - r, 2 * r, 2 * r);
    else { ctx.fillStyle = "#c9ced6"; ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r); }
    // Dark side = half-disc arc + terminator ellipse (the v2 two-arc glyph),
    // rotated so the bright limb points at angleDeg (E of N; canvas y is down,
    // and the unrotated glyph's lit side faces +x, hence the +90 offset).
    ctx.translate(cx, cy);
    ctx.rotate(((Number(phase.angleDeg) || 0) + 90) * RAD);
    ctx.beginPath();
    ctx.arc(0, 0, r, Math.PI / 2, 3 * Math.PI / 2, false);
    ctx.ellipse(0, 0, Math.max(0.001, r * ellipseRatio), r, 0, 3 * Math.PI / 2, Math.PI / 2, litMajor);
    ctx.fillStyle = "rgba(8,10,16,0.88)";
    ctx.fill();
  } catch (err) { console.error("moon draw failed:", err); }
  ctx.restore();
}
