// Pure spherical geometry for the HamClock overlays. No DOM, no Date, no fetch.
const RAD = Math.PI / 180, DEG = 180 / Math.PI;

// n points along the great circle from (lat1,lon1) to (lat2,lon2), inclusive.
// Spherical linear interpolation on unit vectors; returns [[lon,lat],...] degrees.
export function greatCircle(lat1, lon1, lat2, lon2, n = 64) {
  const p1 = lat1 * RAD, l1 = lon1 * RAD, p2 = lat2 * RAD, l2 = lon2 * RAD;
  const x1 = Math.cos(p1) * Math.cos(l1), y1 = Math.cos(p1) * Math.sin(l1), z1 = Math.sin(p1);
  const x2 = Math.cos(p2) * Math.cos(l2), y2 = Math.cos(p2) * Math.sin(l2), z2 = Math.sin(p2);
  const dot = Math.min(1, Math.max(-1, x1 * x2 + y1 * y2 + z1 * z2));
  const omega = Math.acos(dot);
  const antipodal = omega > Math.PI - 1e-4;

  // Near-antipodal endpoints: sin(omega) -> 0, so the slerp division below (a/b)
  // suffers catastrophic cancellation -- interior points collapse toward (0,0)
  // and the arc backtracks. Sidestep the division entirely by rotating v1 about
  // the great-circle-plane normal (v1 x v2) by f*omega (Rodrigues' formula).
  // That normal is well-conditioned right up to omega == pi since it only
  // involves products/differences, never a division by sin(omega).
  let ux, uy, uz;
  if (antipodal) {
    let axx = y1 * z2 - z1 * y2, axy = z1 * x2 - x1 * z2, axz = x1 * y2 - y1 * x2;
    let axisLen = Math.hypot(axx, axy, axz);
    if (axisLen < 1e-9) {
      // Exactly (anti)podal: v1 x v2 is the zero vector, so the great-circle
      // plane is genuinely undefined from the endpoints alone (infinitely many
      // great circles pass through antipodal points). Pick any axis orthogonal
      // to v1 so the arc is still deterministic and well-formed.
      if (Math.abs(x1) < 0.9) { axx = 0; axy = z1; axz = -y1; }
      else { axx = -z1; axy = 0; axz = x1; }
      axisLen = Math.hypot(axx, axy, axz);
    }
    ux = axx / axisLen; uy = axy / axisLen; uz = axz / axisLen;
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1);
    let x, y, z;
    if (omega < 1e-9) {                                     // coincident points: linear
      x = (1 - f) * x1 + f * x2; y = (1 - f) * y1 + f * y2; z = (1 - f) * z1 + f * z2;
    } else if (antipodal) {                                 // near-pi: axis-angle rotation (no sin(omega) division)
      const theta = f * omega, c = Math.cos(theta), s = Math.sin(theta);
      x = x1 * c + (uy * z1 - uz * y1) * s;
      y = y1 * c + (uz * x1 - ux * z1) * s;
      z = z1 * c + (ux * y1 - uy * x1) * s;
    } else {                                                 // normal case: spherical slerp
      const a = Math.sin((1 - f) * omega) / Math.sin(omega), b = Math.sin(f * omega) / Math.sin(omega);
      x = a * x1 + b * x2; y = a * y1 + b * y2; z = a * z1 + b * z2;
    }
    const r = Math.hypot(x, y, z) || 1;
    out.push([Math.atan2(y, x) * DEG, Math.asin(z / r) * DEG]);
  }
  return out;
}

// Split a [[lon,lat],...] polyline wherever consecutive longitudes jump > 180 deg
// (i.e. the path crossed the antimeridian) so the equirectangular map never gets a
// horizontal streak. Returns an array of segments.
export function splitAntimeridian(points) {
  const segs = [];
  let cur = [];
  for (const p of points || []) {
    if (cur.length && Math.abs(p[0] - cur[cur.length - 1][0]) > 180) { segs.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

// Center of a Maidenhead locator (4 or 6+ chars; chars past 6 ignored).
// Returns { lat, lon } in degrees or null if the locator is malformed.
export function gridToLatLon(grid) {
  const g = String(grid || "").trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}/.test(g)) return null;
  let lon = (g.charCodeAt(0) - 65) * 20 - 180 + Number(g[2]) * 2;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90 + Number(g[3]) * 1;
  if (/^[A-X]{2}/.test(g.slice(4, 6))) {
    lon += (g.charCodeAt(4) - 65) * (2 / 24) + 1 / 24;   // subsquare center
    lat += (g.charCodeAt(5) - 65) * (1 / 24) + 1 / 48;
  } else {
    lon += 1;                                            // square center
    lat += 0.5;
  }
  return { lat, lon };
}

// Azimuthal-equidistant projection about (centerLat, centerLon). Returns
// { x, y, front } in RADIANS of arc: the center maps to the origin, +y is
// toward north, +x toward local east, the antipode lands on the rim at
// radius pi. front = point is within pi/2 (the near hemisphere). The screen
// mapping (px = cx + x*scale, py = cy - y*scale) is the renderer's job.
export function azimuthal(latDeg, lonDeg, centerLatDeg, centerLonDeg) {
  const phi = latDeg * RAD, phi0 = centerLatDeg * RAD;
  const dl = (lonDeg - centerLonDeg) * RAD;
  const cosc = Math.min(1, Math.max(-1,
    Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(dl)));
  const c = Math.acos(cosc);
  if (Math.PI - c < 1e-9) return { x: Math.PI, y: 0, front: false }; // exact antipode: direction undefined -> pin to +x rim
  const k = c < 1e-9 ? 1 : c / Math.sin(c);
  return {
    x: k * Math.cos(phi) * Math.sin(dl),
    y: k * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(dl)),
    front: c <= Math.PI / 2,
  };
}

// Inverse of azimuthal(): (x, y) in radians of arc -> { lat, lon } degrees.
// Shipped for the v3.1 raster-overlay resampler; unit-tested via round-trip.
export function azimuthalInverse(x, y, centerLatDeg, centerLonDeg) {
  const c = Math.min(Math.hypot(x, y), Math.PI);
  if (c < 1e-12) return { lat: centerLatDeg, lon: centerLonDeg };
  const phi0 = centerLatDeg * RAD, lam0 = centerLonDeg * RAD;
  const sc = Math.sin(c), cc = Math.cos(c);
  const lat = Math.asin(cc * Math.sin(phi0) + (y * sc * Math.cos(phi0)) / c) * DEG;
  const lon = (lam0 + Math.atan2(x * sc, c * Math.cos(phi0) * cc - y * Math.sin(phi0) * sc)) * DEG;
  return { lat, lon: ((lon + 540) % 360) - 180 };
}
