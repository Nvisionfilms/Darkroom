import type { Curves, Point } from "./types";

/**
 * Monotone cubic Hermite interpolation (Fritsch–Carlson) through the control
 * points, sampled into a 256-entry LUT. Guarantees no overshoot between points.
 */
export function curveLut(pointsIn: Point[]): Float32Array {
  const lut = new Float32Array(256);
  const pts = [...pointsIn].sort((a, b) => a[0] - b[0]);
  // de-dupe x
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of pts) {
    if (xs.length && Math.abs(x - xs[xs.length - 1]) < 1e-6) {
      ys[ys.length - 1] = y;
    } else {
      xs.push(x);
      ys.push(y);
    }
  }
  const n = xs.length;
  if (n === 0) {
    for (let i = 0; i < 256; i++) lut[i] = i / 255;
    return lut;
  }
  if (n === 1) {
    lut.fill(clamp01(ys[0]));
    return lut;
  }
  const d: number[] = [];
  const h: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    d.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let seg = 0;
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    if (x <= xs[0]) {
      lut[i] = clamp01(ys[0]);
      continue;
    }
    if (x >= xs[n - 1]) {
      lut[i] = clamp01(ys[n - 1]);
      continue;
    }
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    const t = (x - xs[seg]) / h[seg];
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    lut[i] = clamp01(h00 * ys[seg] + h10 * h[seg] * m[seg] + h01 * ys[seg + 1] + h11 * h[seg] * m[seg + 1]);
  }
  return lut;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 4 rows x 256: master, red, green, blue. Shared by the GPU and the exporter. */
export function buildLut(curves: Curves): Float32Array {
  const out = new Float32Array(1024);
  out.set(curveLut(curves.master), 0);
  out.set(curveLut(curves.red), 256);
  out.set(curveLut(curves.green), 512);
  out.set(curveLut(curves.blue), 768);
  return out;
}

export function isIdentityCurve(points: Point[]): boolean {
  return (
    points.length === 2 &&
    Math.abs(points[0][0]) < 1e-6 &&
    Math.abs(points[0][1]) < 1e-6 &&
    Math.abs(points[1][0] - 1) < 1e-6 &&
    Math.abs(points[1][1] - 1) < 1e-6
  );
}
