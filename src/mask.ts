// Mask helpers for the preview. Twin of src-tauri/src/mask.rs: the brush
// stamping here must produce the same raster the export produces at its own
// resolution, and the analytic kinds are evaluated in the develop shader with
// the same formulas as mask.rs.

import { MASK_KIND_LINEAR, MASK_KIND_LUMINANCE, MASK_KIND_RADIAL, MASK_KIND_RASTER } from "./gl/shaders";
import type { Mask, Stroke } from "./types";

export function smooth01(x: number): number {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
}

export function maskKindCode(kind: Mask["kind"]): number {
  switch (kind) {
    case "linear":
      return MASK_KIND_LINEAR;
    case "radial":
      return MASK_KIND_RADIAL;
    case "luminance":
      return MASK_KIND_LUMINANCE;
    default:
      return MASK_KIND_RASTER;
  }
}

export function isRasterMask(kind: Mask["kind"]): boolean {
  return kind === "brush" || kind === "subject";
}

export interface BrushSettings {
  /** diameter as a fraction of the long edge */
  size: number;
  feather: number;
  flow: number;
  erase: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Stamp one brush dab into `out` (row-major 0..255, `w` x `h`). Same math as
 * mask.rs brush_raster: radial falloff from hardness to the edge, flow
 * accumulated "over" for paint, multiplied out for erase.
 */
function stamp(out: Uint8Array, w: number, h: number, cx: number, cy: number, r: number, hard: number, flow: number, erase: boolean, dirty: Rect) {
  const xLo = Math.max(0, Math.floor(cx - r));
  const xHi = Math.min(w - 1, Math.ceil(cx + r));
  const yLo = Math.max(0, Math.floor(cy - r));
  const yHi = Math.min(h - 1, Math.ceil(cy + r));
  if (xLo > xHi || yLo > yHi) return;
  const soft = Math.max(1 - hard, 0.01);
  for (let y = yLo; y <= yHi; y++) {
    const dy = y + 0.5 - cy;
    for (let x = xLo; x <= xHi; x++) {
      const dx = x + 0.5 - cx;
      const d = Math.sqrt(dx * dx + dy * dy) / r;
      if (d >= 1) continue;
      const v = flow * (1 - smooth01((d - hard) / soft));
      const i = y * w + x;
      const p = out[i] / 255;
      const np = erase ? p * (1 - v) : p + v * (1 - p);
      out[i] = Math.round(np * 255);
    }
  }
  // grow the dirty rectangle (an empty rect has x = y = Infinity and no size)
  const x1 = Number.isFinite(dirty.x) ? Math.max(dirty.x + dirty.w, xHi + 1) : xHi + 1;
  const y1 = Number.isFinite(dirty.y) ? Math.max(dirty.y + dirty.h, yHi + 1) : yHi + 1;
  dirty.x = Math.min(dirty.x, xLo);
  dirty.y = Math.min(dirty.y, yLo);
  dirty.w = x1 - dirty.x;
  dirty.h = y1 - dirty.y;
}

export function emptyRect(): Rect {
  return { x: Infinity, y: Infinity, w: 0, h: 0 };
}

export function rectValid(r: Rect): boolean {
  return Number.isFinite(r.x) && r.w > 0 && r.h > 0;
}

/** Stamp state carried along a stroke so spacing stays even across segments. */
export interface StrokeCursor {
  lx: number;
  ly: number;
  carry: number;
}

function strokeGeom(s: { size: number; feather: number; flow: number }, w: number, h: number) {
  const long = Math.max(w, h);
  const r = Math.max(0.5, s.size * long * 0.5);
  return {
    r,
    hard: 1 - Math.max(0, Math.min(1, s.feather / 100)),
    flow: Math.max(0, Math.min(1, s.flow / 100)),
    spacing: Math.max(0.5, r * 0.25),
  };
}

/** Begin a stroke at normalised (nx, ny): stamps once and returns the cursor. */
export function strokeStart(out: Uint8Array, w: number, h: number, s: BrushSettings, nx: number, ny: number, dirty: Rect): StrokeCursor {
  const g = strokeGeom(s, w, h);
  const lx = nx * w;
  const ly = ny * h;
  stamp(out, w, h, lx, ly, g.r, g.hard, g.flow, s.erase, dirty);
  return { lx, ly, carry: 0 };
}

/** Extend a stroke to normalised (nx, ny), stamping along the segment. */
export function strokeTo(out: Uint8Array, w: number, h: number, s: BrushSettings, cur: StrokeCursor, nx: number, ny: number, dirty: Rect): void {
  const g = strokeGeom(s, w, h);
  const px = nx * w;
  const py = ny * h;
  const seg = Math.hypot(px - cur.lx, py - cur.ly);
  if (seg <= 0) return;
  let t = g.spacing - cur.carry;
  while (t <= seg) {
    const k = t / seg;
    stamp(out, w, h, cur.lx + (px - cur.lx) * k, cur.ly + (py - cur.ly) * k, g.r, g.hard, g.flow, s.erase, dirty);
    t += g.spacing;
  }
  cur.carry = seg - (t - g.spacing);
  cur.lx = px;
  cur.ly = py;
}

/** Rasterise all strokes of a brush mask from scratch (load, undo). */
export function brushRaster(strokes: Stroke[], w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const dirty = emptyRect();
  for (const s of strokes) {
    const n = Math.min(s.x.length, s.y.length);
    if (n === 0) continue;
    const cur = strokeStart(out, w, h, s, s.x[0], s.y[0], dirty);
    for (let i = 1; i < n; i++) strokeTo(out, w, h, s, cur, s.x[i], s.y[i], dirty);
  }
  return out;
}

/** Decode a grayscale PNG data URL into a `w` x `h` raster (bilinear resample). */
export async function decodeRaster(dataUrl: string, w: number, h: number): Promise<Uint8Array> {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("could not decode mask raster"));
    img.src = dataUrl;
  });
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4];
  return out;
}

/** Encode a raster as a grayscale PNG data URL (for the sidecar). */
export function encodeRaster(data: Uint8Array, w: number, h: number, maxEdge = 1024): string {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d")!;
  const img = sctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = data[i];
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(img, 0, 0);
  if (scale >= 1) return src.toDataURL("image/png");
  const dst = document.createElement("canvas");
  dst.width = Math.max(1, Math.round(w * scale));
  dst.height = Math.max(1, Math.round(h * scale));
  const dctx = dst.getContext("2d")!;
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = "high";
  dctx.drawImage(src, 0, 0, dst.width, dst.height);
  return dst.toDataURL("image/png");
}

/** Half float (IEEE 754 binary16) bits -> number. */
export function f16ToNumber(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

/**
 * Temperature/tint slider values that neutralise a sampled linear DWG colour.
 * Inverse of the WB step in developPixel: r(1+0.4t) = g(1-0.25u) = b(1-0.4t).
 */
export function whiteBalanceFor(r: number, g: number, b: number): { temperature: number; tint: number } {
  const eps = 1e-6;
  const rr = Math.max(r, eps);
  const gg = Math.max(g, eps);
  const bb = Math.max(b, eps);
  let t = (bb - rr) / (0.4 * (rr + bb));
  t = Math.max(-1, Math.min(1, t));
  const gray = rr * (1 + 0.4 * t);
  let u = (1 - gray / gg) / 0.25;
  u = Math.max(-1, Math.min(1, u));
  return { temperature: Math.round(t * 100), tint: Math.round(u * 100) };
}
