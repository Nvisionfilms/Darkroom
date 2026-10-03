// Object remover helpers for the preview. The colour offset formula is the
// twin of `heal_offset` in src-tauri/src/heal.rs, evaluated on the preview
// instead of the full-resolution photo.

import { f16ToNumber } from "./mask";
import type { HealSpot, PreviewImage } from "./types";


/** Points a spot's shape is swept along. Twin of MAX_PATH in heal.rs. */
export const MAX_PATH = 8;

/**
 * Thin a drag down to at most `n` points, evenly spaced along its length.
 *
 * The shader holds a fixed number of points per spot, and a drag records far
 * more than that. Spacing them by distance rather than by time keeps the shape
 * of the stroke whether it was drawn quickly or slowly.
 */
export function resamplePath(path: [number, number][], n: number): [number, number][] {
  if (path.length <= n) return path.slice();
  const seg: number[] = [0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    seg.push(total);
  }
  if (total <= 0) return [path[0]];
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const want = (total * k) / (n - 1);
    let i = 1;
    while (i < seg.length - 1 && seg[i] < want) i++;
    const t = seg[i] > seg[i - 1] ? (want - seg[i - 1]) / (seg[i] - seg[i - 1]) : 0;
    out.push([
      path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
      path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
    ]);
  }
  return out;
}

/** The path in image pixels, always at least one point. Twin of heal.rs. */
export function healPoints(spot: HealSpot, w: number, h: number): [number, number][] {
  const p = (spot.path ?? [])
    .slice(0, MAX_PATH)
    .map((q: [number, number]) => [q[0] * w, q[1] * h] as [number, number]);
  return p.length ? p : [[spot.x * w, spot.y * h]];
}

/** Distance to the swept path, or to the point it collapses to. Twin of heal.rs. */
export function distToPath(pts: [number, number][], px: number, py: number): number {
  if (pts.length === 1) return Math.hypot(px - pts[0][0], py - pts[0][1]);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const ex = bx - ax;
    const ey = by - ay;
    const len2 = ex * ex + ey * ey;
    const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + ex * t), py - (ay + ey * t)));
  }
  return best;
}

/** Bilinear sample of the preview's half-float data. Twin of heal.rs. */
function bilinear(img: PreviewImage, x: number, y: number): [number, number, number] {
  const fx = Math.max(0, Math.min(img.width - 1, x - 0.5));
  const fy = Math.max(0, Math.min(img.height - 1, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, img.width - 1);
  const y1 = Math.min(y0 + 1, img.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a =
      f16ToNumber(img.data[(y0 * img.width + x0) * 3 + c]) * (1 - tx) +
      f16ToNumber(img.data[(y0 * img.width + x1) * 3 + c]) * tx;
    const b =
      f16ToNumber(img.data[(y1 * img.width + x0) * 3 + c]) * (1 - tx) +
      f16ToNumber(img.data[(y1 * img.width + x1) * 3 + c]) * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
  return out;
}

/** Gauss-Jordan on a 3x3. Twin of solve3 in heal.rs. */
function solve3(a: number[][], b: number[]): number[] {
  const m = [
    [a[0][0], a[0][1], a[0][2], b[0]],
    [a[1][0], a[1][1], a[1][2], b[1]],
    [a[2][0], a[2][1], a[2][2], b[2]],
  ];
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r][col]) > Math.abs(m[piv][col])) piv = r;
    if (Math.abs(m[piv][col]) < 1e-9) return [b[0] / Math.max(a[0][0], 1e-9), 0, 0];
    [m[col], m[piv]] = [m[piv], m[col]];
    const d = m[col][col];
    for (let k = col; k < 4; k++) m[col][k] /= d;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col];
      for (let k = col; k < 4; k++) m[r][k] -= f * m[col][k];
    }
  }
  return [m[0][3], m[1][3], m[2][3]];
}

/**
 * The correction a heal spot adds to the copied patch: a plane rather than a
 * single level, so it can follow the gradient a retouch almost always lands in.
 *
 * Fitted by least squares to the ring just outside the patch, so the copied
 * pixels meet the picture at the rim on every side rather than only on average.
 * Matching only the average left the patch too dark on one side and too light
 * on the other, which is the patch you could see. Twin of heal_plane in
 * heal.rs; returned as nine numbers, [c0, cu, cv] per channel.
 */
export function healPlane(img: PreviewImage, spot: HealSpot): number[] {
  if (spot.kind === "clone") return [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const long = Math.max(img.width, img.height);
  const r = Math.max(1, spot.radius * long);
  const dx = spot.x * img.width;
  const dy = spot.y * img.height;
  const sx = spot.sx * img.width;
  const sy = spot.sy * img.height;
  const RING = 96;
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atb = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  // the rim of whatever shape this is: walk in from outside until the path is
  // within reach, which gives a circle for a disc and the outline of the sweep
  // for a painted path (twin of heal_plane in heal.rs)
  const pts = healPoints(spot, img.width, img.height);
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const [px, py] of pts) {
    bx0 = Math.min(bx0, px);
    by0 = Math.min(by0, py);
    bx1 = Math.max(bx1, px);
    by1 = Math.max(by1, py);
  }
  const cx = (bx0 + bx1) / 2;
  const cy = (by0 + by1) / 2;
  const reach = Math.hypot(bx1 - bx0, by1 - by0) / 2 + r * 2;
  for (let i = 0; i < RING; i++) {
    const a = (i * Math.PI * 2) / RING;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let rim = -1;
    const steps = 96;
    for (let st = 0; st <= steps; st++) {
      const t = reach * (1 - st / steps);
      if (distToPath(pts, cx + t * ca, cy + t * sa) <= r) {
        rim = t;
        break;
      }
    }
    if (rim < 0) continue;
    for (const k of [0.0, 0.04, 0.08]) {
      const t = rim + r * k;
      const px = cx + t * ca;
      const py = cy + t * sa;
      const dst = bilinear(img, px, py);
      const src = bilinear(img, sx + (px - dx), sy + (py - dy));
      const basis = [1, (px - dx) / r, (py - dy) / r];
      for (let bi = 0; bi < 3; bi++) {
        for (let bj = 0; bj < 3; bj++) ata[bi][bj] += basis[bi] * basis[bj];
        for (let c = 0; c < 3; c++) atb[bi][c] += basis[bi] * (dst[c] - src[c]);
      }
    }
  }
  const out = new Array(9).fill(0);
  for (let c = 0; c < 3; c++) {
    const x = solve3(ata, [atb[0][c], atb[1][c], atb[2][c]]);
    for (let k = 0; k < 3; k++) out[k * 3 + c] = x[k];
  }
  return out;
}

/** A stable key for the set of spots, used to cache the heal pass. */
export function healKey(spots: HealSpot[]): string {
  return spots
    .filter((s) => s.enabled && s.opacity > 0 && s.radius > 0)
    .map((s) => [s.kind, s.x, s.y, s.sx, s.sy, s.radius, s.feather, s.opacity].join(","))
    .join("|");
}
