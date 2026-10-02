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

/** A single-channel weight map, 0..255. */
export interface AlphaMap {
  data: Uint8Array;
  w: number;
  h: number;
}

function sampleNorm(a: AlphaMap, u: number, v: number): number {
  const fx = Math.max(0, Math.min(a.w - 1, u * a.w - 0.5));
  const fy = Math.max(0, Math.min(a.h - 1, v * a.h - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, a.w - 1);
  const y1 = Math.min(y0 + 1, a.h - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const p = a.data;
  const t = p[y0 * a.w + x0] * (1 - tx) + p[y0 * a.w + x1] * tx;
  const b = p[y1 * a.w + x0] * (1 - tx) + p[y1 * a.w + x1] * tx;
  return (t * (1 - ty) + b * ty) / 255;
}

/** Luminance-range weight. Twin of mask.rs lum_weight. */
function lumWeight(y: number, lo: number, hi: number, feather: number): number {
  const f = Math.max(feather, 0.005);
  const a = smooth01((y - (lo - f)) / f);
  const b = 1 - smooth01((y - hi) / f);
  return Math.max(0, Math.min(1, a * b));
}

/** Decode a grayscale PNG data URL (a subject mask) to a weight map. */
async function decodeRasterUrl(url: string): Promise<AlphaMap | null> {
  const img = new Image();
  const ok = await new Promise<boolean>((res) => {
    img.onload = () => res(true);
    img.onerror = () => res(false);
    img.src = url;
  });
  if (!ok || !img.naturalWidth) return null;
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const out = new Uint8Array(c.width * c.height);
  // encodeRaster writes the weight into all three colour channels
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
  return { data: out, w: c.width, h: c.height };
}

/** One mask's own weight at a pixel centre, before its subtractions. */
function weightFn(
  m: Mask,
  w: number,
  h: number,
  raster: AlphaMap | null,
  luma: Uint8Array | null,
): (px: number, py: number) => number {
  const amount = Math.max(0, Math.min(1, m.amount / 100));
  const long = Math.max(w, h);
  let raw: (px: number, py: number) => number;
  switch (m.kind) {
    case "linear": {
      const ax = m.x0 * w;
      const ay = m.y0 * h;
      const dx = m.x1 * w - ax;
      const dy = m.y1 * h - ay;
      const len2 = dx * dx + dy * dy;
      raw = len2 < 1e-6 ? () => 1 : (px, py) => 1 - smooth01(((px - ax) * dx + (py - ay) * dy) / len2);
      break;
    }
    case "radial": {
      const rx = Math.max(1, m.rx * long);
      const ry = Math.max(1, m.ry * long);
      const rot = (m.rotation * Math.PI) / 180;
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const f = Math.max(0.01, Math.min(1, m.feather / 100));
      const ox = m.cx * w;
      const oy = m.cy * h;
      raw = (px, py) => {
        const dx = px - ox;
        const dy = py - oy;
        const lx = dx * c + dy * s;
        const ly = -dx * s + dy * c;
        const e = Math.hypot(lx / rx, ly / ry);
        return 1 - smooth01((e - (1 - f)) / f);
      };
      break;
    }
    case "luminance":
      raw = luma
        ? (px, py) => {
            const i = Math.min(luma.length - 1, Math.floor(py) * w + Math.floor(px));
            return lumWeight(luma[i] / 255, m.lumLo, m.lumHi, m.lumFeather);
          }
        : () => 0;
      break;
    default:
      raw = raster ? (px, py) => sampleNorm(raster, px / w, py / h) : () => 0;
  }
  return (px, py) => {
    const v = m.invert ? 1 - raw(px, py) : raw(px, py);
    return v * amount;
  };
}

/**
 * The weight of one mask and its subtractions over a `w` x `h` grid, for code
 * that needs the shape itself rather than an adjustment - Motion Trails cut
 * from a masked subject. Twin of mask.rs weight_map.
 *
 * `luma` is the developed luminance (0..255, one byte per pixel) and is only
 * read by luminance masks.
 */
export async function maskGroupAlpha(
  masks: Mask[],
  id: string,
  w: number,
  h: number,
  luma?: Uint8Array | null,
): Promise<AlphaMap | null> {
  if (w < 1 || h < 1) return null;
  const head = masks.findIndex((m) => m.id === id && m.mode !== "subtract");
  if (head < 0) return null;
  const m = masks[head];
  if (!m.enabled || m.amount <= 0) return null;
  const subs: Mask[] = [];
  for (let i = head + 1; i < masks.length && masks[i].mode === "subtract"; i++) {
    if (masks[i].enabled && masks[i].amount > 0) subs.push(masks[i]);
  }

  const rasterFor = async (k: Mask): Promise<AlphaMap | null> => {
    if (k.kind === "brush") return { data: brushRaster(k.strokes, w, h), w, h };
    if (k.kind === "subject") return k.raster ? await decodeRasterUrl(k.raster) : null;
    return null;
  };
  const fns = [m, ...subs];
  const rasters = await Promise.all(fns.map(rasterFor));
  const eval0 = fns.map((k, i) => weightFn(k, w, h, rasters[i], luma ?? null));

  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      let v = eval0[0](px, py);
      for (let i = 1; i < eval0.length && v > 0; i++) v *= 1 - eval0[i](px, py);
      data[y * w + x] = Math.round(Math.max(0, Math.min(1, v)) * 255);
    }
  }
  return { data, w, h };
}

/** Changing any of these means a cached mask weight map has to be rebuilt. */
export function maskGroupKey(masks: Mask[], id: string): string {
  const head = masks.findIndex((k) => k.id === id && k.mode !== "subtract");
  if (head < 0) return "";
  const part = (k: Mask) =>
    [
      k.id,
      k.kind,
      k.enabled ? 1 : 0,
      k.invert ? 1 : 0,
      k.amount,
      k.x0,
      k.y0,
      k.x1,
      k.y1,
      k.cx,
      k.cy,
      k.rx,
      k.ry,
      k.rotation,
      k.feather,
      k.lumLo,
      k.lumHi,
      k.lumFeather,
      k.strokes.length,
      k.strokes.reduce((n, s) => n + s.x.length, 0),
      k.raster ? k.raster.length : 0,
    ].join(",");
  const out = [part(masks[head])];
  for (let i = head + 1; i < masks.length && masks[i].mode === "subtract"; i++) out.push(part(masks[i]));
  return out.join("|");
}
