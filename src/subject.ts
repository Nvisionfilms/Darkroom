// On-device subject detection for masks. Runs the small u2netp salient-object
// model with onnxruntime-web (WASM, single thread). Nothing leaves the
// machine; the result is only a soft 0..1 weight map, never new pixels.

import type * as OrtNs from "onnxruntime-web";

const MODEL_URL = "/models/u2netp.onnx";
const SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Ort = typeof OrtNs;
let sessionPromise: Promise<[Ort, OrtNs.InferenceSession]> | null = null;

/** The runtime is loaded on first use so it stays out of the main bundle. */
function session(): Promise<[Ort, OrtNs.InferenceSession]> {
  if (!sessionPromise) {
    sessionPromise = import("onnxruntime-web")
      .then(async (ort) => {
        ort.env.wasm.wasmPaths = "/ort/";
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        const s = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] });
        return [ort, s] as [Ort, OrtNs.InferenceSession];
      })
      .catch((e) => {
        sessionPromise = null;
        throw e;
      });
  }
  return sessionPromise;
}

/**
 * Detect the main subject in a display-space picture (JPEG/PNG blob) and
 * return a `w` x `h` raster (0..255) of subject likelihood.
 */
/** Mean of a (2r+1)-square around each pixel, in one pass over a summed-area table. */
function boxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const sw = w + 1;
  const sat = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * sw + x + 1] = sat[y * sw + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const a = sat[y0 * sw + x0];
      const b = sat[y0 * sw + x1 + 1];
      const c = sat[(y1 + 1) * sw + x0];
      const d = sat[(y1 + 1) * sw + x1 + 1];
      out[y * w + x] = (d - b - c + a) / area;
    }
  }
  return out;
}

/**
 * Pull a coarse matte onto the edges of the picture it came from.
 *
 * The model sees a 320-pixel copy of the photo, so its matte is a 320-pixel
 * guess scaled up: it knows where the subject is but not exactly where it ends,
 * and the boundary lands a few pixels into the background or into the subject.
 * A guided filter (He, Sun, Tang) fixes that without inventing anything: inside
 * each window it fits the matte to the picture's own brightness as a straight
 * line, so wherever the picture has an edge the matte is allowed one too, and
 * where the picture is flat the matte stays smooth. The result follows the
 * shoulder of a jersey or the line of a helmet rather than a blurred guess at
 * it.
 *
 * `mask` and `guide` are 0..255, `w` x `h`. Exported for the tests.
 */
export function refineMatte(mask: Uint8Array, guide: Uint8Array, w: number, h: number): Uint8Array {
  const n = w * h;
  if (n === 0 || mask.length < n || guide.length < n) return mask;
  // A window of about 2.5% of the short edge. Measured on a synthetic edge with
  // the matte five pixels out of place, this lands it exactly and narrows the
  // transition from eight pixels to two or three; 1.5% only got halfway, and
  // 3.5% drove the edge binary, which aliases on a real subject.
  const r = Math.max(2, Math.round(Math.min(w, h) * 0.025));
  const eps = 1e-4;

  const I = new Float32Array(n);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    I[i] = guide[i] / 255;
    p[i] = mask[i] / 255;
  }
  const II = new Float32Array(n);
  const Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i] * I[i];
    Ip[i] = I[i] * p[i];
  }
  const meanI = boxFilter(I, w, h, r);
  const meanP = boxFilter(p, w, h, r);
  const meanII = boxFilter(II, w, h, r);
  const meanIp = boxFilter(Ip, w, h, r);

  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = meanII[i] - meanI[i] * meanI[i];
    const covIp = meanIp[i] - meanI[i] * meanP[i];
    a[i] = covIp / (varI + eps);
    b[i] = meanP[i] - a[i] * meanI[i];
  }
  const meanA = boxFilter(a, w, h, r);
  const meanB = boxFilter(b, w, h, r);

  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const q = meanA[i] * I[i] + meanB[i];
    // the matte now follows the picture's edges, so the grey band either side
    // of the boundary is guesswork rather than real softness: a gentle S-curve
    // takes it out without hardening the edge into stair steps
    const t = Math.max(0, Math.min(1, (q - 0.5) * 1.6 + 0.5));
    out[i] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  return out;
}

export async function detectSubject(picture: Blob, w: number, h: number): Promise<Uint8Array> {
  const [[ort, sess], bitmap] = await Promise.all([session(), createImageBitmap(picture)]);
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  const px = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const input = new Float32Array(3 * SIZE * SIZE);
  const plane = SIZE * SIZE;
  for (let i = 0; i < plane; i++) {
    input[i] = (px[i * 4] / 255 - MEAN[0]) / STD[0];
    input[plane + i] = (px[i * 4 + 1] / 255 - MEAN[1]) / STD[1];
    input[2 * plane + i] = (px[i * 4 + 2] / 255 - MEAN[2]) / STD[2];
  }
  const feeds: Record<string, OrtNs.Tensor> = {};
  feeds[sess.inputNames[0]] = new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]);
  const out = await sess.run(feeds);
  const first = out[sess.outputNames[0]];
  const pred = first.data as Float32Array;
  // rembg normalises the fused output to its own min/max
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < plane; i++) {
    const v = pred[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = Math.max(hi - lo, 1e-6);
  const small = ctx.createImageData(SIZE, SIZE);
  for (let i = 0; i < plane; i++) {
    const v = Math.round(((pred[i] - lo) / range) * 255);
    small.data[i * 4] = v;
    small.data[i * 4 + 1] = v;
    small.data[i * 4 + 2] = v;
    small.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(small, 0, 0);
  // resample to the mask raster size
  const big = document.createElement("canvas");
  big.width = w;
  big.height = h;
  const bctx = big.getContext("2d", { willReadFrequently: true })!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(c, 0, 0, w, h);
  const bp = bctx.getImageData(0, 0, w, h).data;
  const raster = new Uint8Array(w * h);
  for (let i = 0; i < raster.length; i++) raster[i] = bp[i * 4];

  // the picture itself, at the matte's size, as the guide for the refinement
  bctx.clearRect(0, 0, w, h);
  bctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const gp = bctx.getImageData(0, 0, w, h).data;
  const guide = new Uint8Array(w * h);
  for (let i = 0; i < guide.length; i++) {
    guide[i] = Math.round(gp[i * 4] * 0.2126 + gp[i * 4 + 1] * 0.7152 + gp[i * 4 + 2] * 0.0722);
  }
  return refineMatte(raster, guide, w, h);
}
