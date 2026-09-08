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
export async function detectSubject(picture: Blob, w: number, h: number): Promise<Uint8Array> {
  const [[ort, sess], bitmap] = await Promise.all([session(), createImageBitmap(picture)]);
  const c = document.createElement("canvas");
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
  bitmap.close();
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
  return raster;
}
