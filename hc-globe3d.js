// Real 3D globe: a WebGL textured, sun-lit sphere. The basemap (satellite /
// terrain / Blue Marble) is wrapped as an equirectangular texture; day/night is
// true per-pixel lighting from the Sun's actual direction; a fresnel term adds an
// atmospheric rim. The sphere is rendered orthographically, so the SAME rotation
// matrix drives a plain-JS projector (makeProjector) that places 2D overlays
// (DX paths, markers, grids) exactly on the sphere's front face.
//
// Orientation: canonical sphere point for (lon,lat) is
//   p0 = (cosφ·sinλ, sinφ, cosφ·cosλ)      [center lon0=lat0=0 faces +Z / the viewer]
// and M = Rx(centerLat)·Ry(-centerLon) rotates the requested center to face the
// viewer. Screen: (cx + R·(M·p0).x, cy - R·(M·p0).y); front = (M·p0).z > 0.

const RAD = Math.PI / 180;

// M = Rx(cLat)·Ry(-cLon) as a row-major 3x3 (verified: center -> (0,0,1)).
export function globeMatrix(centerLatDeg, centerLonDeg) {
  const P = centerLatDeg * RAD, L = centerLonDeg * RAD;
  const cP = Math.cos(P), sP = Math.sin(P), cL = Math.cos(L), sL = Math.sin(L);
  return [
    cL, 0, -sL,
    -sP * sL, cP, -sP * cL,
    cP * sL, sP, cP * cL,
  ];
}
function lonLatToXYZ(lonDeg, latDeg) {
  const la = latDeg * RAD, lo = lonDeg * RAD, c = Math.cos(la);
  return [c * Math.sin(lo), Math.sin(la), c * Math.cos(lo)];
}
// Orthographic projector matching the shader. Returns {x,y,front}.
export function makeProjector(centerLat, centerLon, cx, cy, R) {
  const m = globeMatrix(centerLat, centerLon);
  return (lon, lat) => {
    const p = lonLatToXYZ(lon, lat);
    const rx = m[0] * p[0] + m[1] * p[1] + m[2] * p[2];
    const ry = m[3] * p[0] + m[4] * p[1] + m[5] * p[2];
    const rz = m[6] * p[0] + m[7] * p[1] + m[8] * p[2];
    if (rz > 0) return { x: cx + R * rx, y: cy - R * ry, front: true };
    // Far side: push the point radially OUTSIDE the disc so the caller's disc clip
    // hides it (and limb-crossing lines get cut at the edge). Otherwise orthographic
    // maps the back hemisphere INTO the disc and overlays show through the globe.
    const rr = Math.hypot(rx, ry);
    if (rr < 1e-3) return { x: cx, y: cy + R * 3, front: false };   // ~antipode: park far out
    const f = (2 - rr) / rr;                                        // radius -> [1, 2], beyond the limb
    return { x: cx + R * rx * f, y: cy - R * ry * f, front: false };
  };
}

const VERT = `
attribute vec3 aPos; attribute vec2 aUV;
uniform mat3 uM; uniform vec2 uCenter; uniform float uR; uniform vec2 uVP;
varying vec2 vUV; varying vec3 vN; varying vec3 vR;
void main() {
  vec3 p = uM * aPos; vUV = aUV; vN = aPos; vR = p;
  float sx = uCenter.x + uR * p.x, sy = uCenter.y - uR * p.y;
  gl_Position = vec4(sx / (uVP.x * 0.5) - 1.0, 1.0 - sy / (uVP.y * 0.5), -p.z * 0.5, 1.0);
}`;
const FRAG = `
precision highp float;
varying vec2 vUV; varying vec3 vN; varying vec3 vR;
uniform sampler2D uDay; uniform sampler2D uNight;
uniform vec3 uSun; uniform float uUseNight; uniform float uLine; uniform vec3 uLineCol; uniform float uCity;
void main() {
  float diff = dot(normalize(vN), normalize(uSun));
  float dayAmt = smoothstep(-0.09, 0.15, diff);
  vec3 dayCol = uLine > 0.5 ? uLineCol : texture2D(uDay, vUV).rgb;
  vec3 darkCol = uUseNight > 0.5 ? texture2D(uNight, vUV).rgb * 1.2 : dayCol * 0.05;
  vec3 base = mix(darkCol, dayCol * (0.9 + 0.25 * dayAmt), dayAmt);
  if (uCity > 0.5 && uUseNight < 0.5) base += texture2D(uNight, vUV).rgb * (1.0 - dayAmt) * 1.4;  // city lights overlay
  float fres = 1.0 - clamp(vR.z, 0.0, 1.0);
  base += vec3(0.30, 0.52, 1.0) * pow(fres, 3.0) * 0.85;   // atmosphere rim
  gl_FragColor = vec4(base, 1.0);
}`;

export function makeGlobe3D() {
  const cv = document.createElement("canvas");
  const gl = cv.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: false })
    || cv.getContext("experimental-webgl", { antialias: true, alpha: true });
  if (!gl) return null;   // caller falls back to the 2D globe

  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);

  // UV sphere geometry (built once).
  const LON = 120, LAT = 60, pos = [], uv = [], idx = [];
  for (let j = 0; j <= LAT; j++) {
    const lat = 90 - (j / LAT) * 180;
    for (let i = 0; i <= LON; i++) {
      const lon = -180 + (i / LON) * 360;
      pos.push(...lonLatToXYZ(lon, lat));
      uv.push((lon + 180) / 360, (90 - lat) / 180);
    }
  }
  for (let j = 0; j < LAT; j++) for (let i = 0; i < LON; i++) {
    const a = j * (LON + 1) + i, b = a + LON + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const buf = (data, Type) => { const b = gl.createBuffer(); gl.bindBuffer(Type || gl.ARRAY_BUFFER, b); gl.bufferData(Type || gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
  buf(new Float32Array(pos)); const aPos = gl.getAttribLocation(prog, "aPos"); gl.enableVertexAttribArray(aPos); gl.vertexAttribPointer(aPos, 3, gl.FLOAT, false, 0, 0);
  const uvBuf = buf(new Float32Array(uv)); const aUV = gl.getAttribLocation(prog, "aUV"); gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf); gl.enableVertexAttribArray(aUV); gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
  buf(new Uint16Array(idx), gl.ELEMENT_ARRAY_BUFFER);
  const nIdx = idx.length;

  const U = (n) => gl.getUniformLocation(prog, n);
  const uM = U("uM"), uCenter = U("uCenter"), uR = U("uR"), uVP = U("uVP"),
    uSun = U("uSun"), uUseNight = U("uUseNight"), uLine = U("uLine"), uLineCol = U("uLineCol"),
    uCity = U("uCity"), uDayS = U("uDay"), uNightS = U("uNight");
  gl.uniform1i(uDayS, 0); gl.uniform1i(uNightS, 1);
  gl.enable(gl.DEPTH_TEST);

  const mkTex = (unit) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };
  const dayTex = mkTex(0), nightTex = mkTex(1);
  let dayKey = null, nightKey = null;
  function upload(unit, tex, img, keyGet, keySet) {
    if (!img || !img.complete || !img.naturalWidth) return;
    if (keyGet() === img.src) return;                 // already uploaded this image
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      // Wrap longitude (S) so the ±180 edges blend -> no meridian seam. WebGL1 only
      // allows REPEAT on power-of-two textures; fall back to CLAMP otherwise.
      const pot = (img.naturalWidth & (img.naturalWidth - 1)) === 0 && (img.naturalHeight & (img.naturalHeight - 1)) === 0;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, pot ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      keySet(img.src);
    } catch { /* CORS-tainted etc: skip */ }
  }

  // opts: { W,H,dpr,cx,cy,R,centerLat,centerLon,sunLon,sunLat, style, dayImg, nightImg, lineColor }
  function render(o) {
    const pw = Math.max(1, Math.round(o.W * o.dpr)), ph = Math.max(1, Math.round(o.H * o.dpr));
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    gl.viewport(0, 0, pw, ph);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(prog);
    const line = o.style === "line";
    if (!line) upload(0, dayTex, o.dayImg, () => dayKey, (v) => (dayKey = v));
    // night-lights texture is needed for day-night style AND the City Lights overlay
    if (o.style === "day-night" || o.cityLights) upload(1, nightTex, o.nightImg, () => nightKey, (v) => (nightKey = v));
    gl.uniformMatrix3fv(uM, false, glMat3(globeMatrix(o.centerLat, o.centerLon)));
    gl.uniform2f(uCenter, o.cx, o.cy); gl.uniform1f(uR, o.R); gl.uniform2f(uVP, o.W, o.H);
    const sun = lonLatToXYZ(o.sunLon, o.sunLat); gl.uniform3f(uSun, sun[0], sun[1], sun[2]);
    gl.uniform1f(uUseNight, o.style === "day-night" ? 1 : 0);
    gl.uniform1f(uCity, o.cityLights ? 1 : 0);
    gl.uniform1f(uLine, line ? 1 : 0);
    const lc = o.lineColor || [0.07, 0.19, 0.42]; gl.uniform3f(uLineCol, lc[0], lc[1], lc[2]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dayTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, nightTex);
    gl.drawElements(gl.TRIANGLES, nIdx, gl.UNSIGNED_SHORT, 0);
    return cv;
  }
  // row-major (our) -> column-major (WebGL) mat3
  function glMat3(m) { return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]); }

  return { render, canvas: cv, ok: true };
}
