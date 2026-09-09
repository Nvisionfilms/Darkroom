// Twin of src-tauri/src/geometry.rs and of the warp in PRESENT_FRAG.
// Normalised coordinates: origin at the image centre, r = 1 is half of the
// image diagonal, exactly as lensfun calibrations are defined.

import type { Lens, LensProfile, Transform } from "./types";

export const PERSPECTIVE_K = 0.9;
export const MANUAL_DISTORTION_K = 0.8;
export const MANUAL_CA_K = 0.005;

const smooth01 = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

export interface Warp {
  w: number;
  h: number;
  cx: number;
  cy: number;
  hs: number;
  ox: number;
  oy: number;
  invScale: number;
  ax: number;
  ay: number;
  cos: number;
  sin: number;
  ph: number;
  pv: number;
  transformOn: boolean;
  distModel: number;
  dist: [number, number, number];
  distAmount: number;
  cs: number;
  km: number;
  tcaR: number;
  tcaB: number;
  vig: [number, number, number];
  vigAmount: number;
  mv: number;
  mvStart: number;
  rmax: number;
}

export function transformIsIdentity(t: Transform): boolean {
  return t.vertical === 0 && t.horizontal === 0 && t.rotate === 0 && t.scale === 0 && t.aspect === 0 && t.x === 0 && t.y === 0;
}

const hasDistortion = (p: LensProfile | null) => !!p && p.distModel !== 0;
const hasVignetting = (p: LensProfile | null) => !!p && (p.vig[0] !== 0 || p.vig[1] !== 0 || p.vig[2] !== 0);
const hasTca = (p: LensProfile | null) => !!p && p.tca[0] !== 0 && p.tca[1] !== 0 && (p.tca[0] !== 1 || p.tca[1] !== 1);

export function makeWarp(t: Transform, l: Lens, profile: LensProfile | null, width: number, height: number): Warp {
  // r = 1 at half the image diagonal, the lensfun convention
  const hs = Math.max(1, Math.hypot(width, height) / 2);
  const rot = (t.rotate * Math.PI) / 180;
  const a = t.aspect / 100;
  const useProf = l.profile && !!profile;
  const distOn = useProf && hasDistortion(profile) && l.distortionAmount > 0;
  const tcaOn = useProf && l.ca && hasTca(profile);
  const vigOn = useProf && hasVignetting(profile) && l.vignetteAmount > 0;
  const cs = useProf && profile!.cropScale > 0 ? profile!.cropScale : 1;
  return {
    w: width,
    h: height,
    cx: width / 2,
    cy: height / 2,
    hs,
    ox: (t.x / 100) * (width / (2 * hs)),
    oy: (t.y / 100) * (height / (2 * hs)),
    invScale: 1 / Math.max(0.2, 1 + t.scale / 100),
    ax: Math.exp(0.4 * a),
    ay: Math.exp(-0.4 * a),
    cos: Math.cos(rot),
    sin: Math.sin(rot),
    ph: (t.horizontal / 100) * PERSPECTIVE_K,
    pv: (-t.vertical / 100) * PERSPECTIVE_K,
    transformOn: !transformIsIdentity(t),
    distModel: distOn ? profile!.distModel : 0,
    dist: profile ? profile.dist : [0, 0, 0],
    distAmount: Math.max(0, Math.min(1, l.distortionAmount / 100)),
    cs,
    km: (l.manualDistortion / 100) * MANUAL_DISTORTION_K,
    tcaR: (tcaOn ? profile!.tca[0] : 1) * (1 + (l.manualCaR / 100) * MANUAL_CA_K),
    tcaB: (tcaOn ? profile!.tca[1] : 1) * (1 + (l.manualCaB / 100) * MANUAL_CA_K),
    vig: vigOn ? profile!.vig : [0, 0, 0],
    vigAmount: Math.max(0, Math.min(1, l.vignetteAmount / 100)),
    mv: l.manualVignette / 100,
    mvStart: Math.max(0, Math.min(1, l.manualVignetteMid / 100)),
    rmax: Math.hypot(width / (2 * hs), height / (2 * hs)),
  };
}

export function warpIsIdentity(w: Warp): boolean {
  return !w.transformOn && w.distModel === 0 && w.km === 0 && w.tcaR === 1 && w.tcaB === 1;
}

export function warpHasVignette(w: Warp): boolean {
  return w.vig[0] !== 0 || w.vig[1] !== 0 || w.vig[2] !== 0 || w.mv !== 0;
}

export function distortRadius(w: Warp, r: number): number {
  let rd = r;
  if (w.distModel !== 0) {
    const rc = r * w.cs;
    const [a, b, c] = w.dist;
    const f =
      w.distModel === 1
        ? rc * (a * rc * rc * rc + b * rc * rc + c * rc + 1 - a - b - c)
        : w.distModel === 2
          ? rc * (1 - a + a * rc * rc)
          : rc * (1 + a * rc * rc + b * rc * rc * rc * rc);
    rd = r + w.distAmount * (f / w.cs - r);
  }
  if (w.km !== 0) rd *= 1 + w.km * rd * rd;
  return rd;
}

/** Canvas pixel -> source position in normalised units (green channel). */
export function mapNorm(w: Warp, x: number, y: number): [number, number] {
  let px = (x - w.cx) / w.hs;
  let py = (y - w.cy) / w.hs;
  if (w.transformOn) {
    px -= w.ox;
    py -= w.oy;
    px *= w.invScale;
    py *= w.invScale;
    px /= w.ax;
    py /= w.ay;
    const rx = w.cos * px - w.sin * py;
    const ry = w.sin * px + w.cos * py;
    const q = Math.max(0.05, 1 + w.ph * rx + w.pv * ry);
    px = rx / q;
    py = ry / q;
  }
  const r = Math.hypot(px, py);
  if (r > 1e-6) {
    const k = distortRadius(w, r) / r;
    px *= k;
    py *= k;
  }
  return [px, py];
}

/** Canvas pixel -> source pixel (green channel). */
export function canvasToSource(w: Warp, x: number, y: number): [number, number] {
  const [px, py] = mapNorm(w, x, y);
  return [w.cx + px * w.hs, w.cy + py * w.hs];
}

/** Source pixel -> canvas pixel. Twin of geometry.rs source_to_canvas. */
export function sourceToCanvas(w: Warp, sx: number, sy: number): [number, number] {
  let px = (sx - w.cx) / w.hs;
  let py = (sy - w.cy) / w.hs;
  const rd = Math.hypot(px, py);
  if (rd > 1e-6 && (w.distModel !== 0 || w.km !== 0)) {
    let r = rd;
    for (let i = 0; i < 8; i++) {
      const f = distortRadius(w, r) - rd;
      const d = (distortRadius(w, r + 1e-3) - distortRadius(w, r - 1e-3)) / 2e-3;
      if (Math.abs(d) < 1e-6) break;
      r -= f / d;
    }
    const k = r / rd;
    px *= k;
    py *= k;
  }
  if (w.transformOn) {
    const den = Math.max(0.05, 1 - w.ph * px - w.pv * py);
    px /= den;
    py /= den;
    const rx = w.cos * px + w.sin * py;
    const ry = -w.sin * px + w.cos * py;
    px = (rx * w.ax) / w.invScale + w.ox;
    py = (ry * w.ay) / w.invScale + w.oy;
  }
  return [w.cx + px * w.hs, w.cy + py * w.hs];
}

/** Scene-referred gain at a source pixel (vignetting correction). */
export function vignetteGain(w: Warp, x: number, y: number): number {
  const dx = (x - w.cx) / w.hs;
  const dy = (y - w.cy) / w.hs;
  const r2 = dx * dx + dy * dy;
  let g = 1;
  if (w.vig[0] !== 0 || w.vig[1] !== 0 || w.vig[2] !== 0) {
    const rc2 = r2 * w.cs * w.cs;
    const [k1, k2, k3] = w.vig;
    const f = 1 + k1 * rc2 + k2 * rc2 * rc2 + k3 * rc2 * rc2 * rc2;
    g *= 1 + w.vigAmount * (1 / Math.max(0.05, Math.min(20, f)) - 1);
  }
  if (w.mv !== 0) g *= 1 + w.mv * smooth01((Math.sqrt(r2) - w.mvStart) / Math.max(1e-3, w.rmax - w.mvStart));
  return Math.max(0, g);
}
