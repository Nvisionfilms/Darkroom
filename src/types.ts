export type Point = [number, number];

export interface HslParams {
  hue: number[];
  saturation: number[];
  luminance: number[];
}

export interface Curves {
  master: Point[];
  red: Point[];
  green: Point[];
  blue: Point[];
}

/** Split toning / colour grading: hues 0..360, saturations 0..100, balance -100..100. */
export interface Grading {
  shadowHue: number;
  shadowSat: number;
  midHue: number;
  midSat: number;
  highHue: number;
  highSat: number;
  balance: number;
}

/**
 * Motion-trail settings stored under the legacy `mirror` sidecar key so edits
 * written by older Darkroom builds remain readable.
 *
 * Semantic mapping used by the current UI/renderers:
 * - cx: number of copies / 10 (1..8 copies)
 * - rx: blur amount 0..1
 * - ry: trail amount 0..1
 * - feather: fade 0..100
 * - direction: degrees (0 = right, 90 = down)
 * - length: distance as a fraction of the long edge
 * - opacity: 0..100
 *
 * cy, rotation and offset remain on the wire for backwards compatibility but
 * are not used by the motion-trail renderer.
 */
export interface Mirror {
  enabled: boolean;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
  feather: number;
  direction: number;
  offset: number;
  length: number;
  opacity: number;
}

/**
 * Image watermark. `path` is the overlay file (PNG with alpha works best),
 * `x`/`y` its centre as fractions of the photo width/height, `size` its width
 * as a fraction of the photo's long edge, `opacity` 0..100.
 */
export interface Watermark {
  enabled: boolean;
  path: string;
  x: number;
  y: number;
  size: number;
  opacity: number;
}

/**
 * Crop + straighten. Rectangle as fractions of the source size, measured on
 * the canvas after rotating the source by `angle` degrees about its centre.
 */
export interface Crop {
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
}

export interface EditParams {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  vibrance: number;
  saturation: number;
  baseContrast: number;
  sharpen: number;
  /** clockwise degrees: 0 | 90 | 180 | 270 */
  rotation: number;
  /** -100..100 mid-frequency local contrast (structure) */
  texture: number;
  /** -100..100 large-radius midtone local contrast */
  clarity: number;
  /** 0..100 */
  denoiseLuma: number;
  /** 0..100 */
  denoiseChroma: number;
  /** 0..100 */
  denoiseDetail: number;
  grading: Grading;
  /** legacy key; rendered as Motion Trails in the UI */
  mirror: Mirror;
  watermark: Watermark;
  crop: Crop;
  hsl: HslParams;
  curves: Curves;
}

export interface Metadata {
  kind: string;
  camera?: string | null;
  lens?: string | null;
  iso?: number | null;
  exposureTime?: string | null;
  fNumber?: number | null;
  focalLength?: number | null;
  dateTaken?: string | null;
}

export interface ImageInfo {
  path: string;
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  /** noise sigma of the preview in the sqrt-luma domain */
  noiseSigma: number;
  metadata: Metadata;
  edits: EditParams | null;
  thumbnail: string;
}

export interface PreviewImage {
  width: number;
  height: number;
  /** interleaved RGB half floats */
  data: Uint16Array;
  noiseSigma: number;
}

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
}

export type ExportFormat = "jpeg" | "png" | "tiff";

export interface ExportRequest {
  outPath: string;
  format: ExportFormat;
  quality: number;
  bitDepth: 8 | 16;
  maxLongEdge: number | null;
  params: EditParams;
  lut: number[];
}

const line = (): Point[] => [
  [0, 0],
  [1, 1],
];

export function defaultGrading(): Grading {
  return { shadowHue: 220, shadowSat: 0, midHue: 40, midSat: 0, highHue: 45, highSat: 0, balance: 0 };
}

export function defaultMirror(): Mirror {
  return {
    enabled: false,
    cx: 0.4, // 4 copies
    cy: 0.5, // legacy / unused
    rx: 0.2, // blur
    ry: 0.7, // amount
    rotation: 0, // legacy / unused
    feather: 65, // fade
    direction: -35,
    offset: 0, // legacy / unused
    length: 0.16, // distance
    opacity: 65,
  };
}

export function defaultWatermark(): Watermark {
  return { enabled: false, path: "", x: 0.85, y: 0.92, size: 0.2, opacity: 80 };
}

export interface WatermarkInfo {
  path: string;
  width: number;
  height: number;
}

export function defaultCrop(): Crop {
  return { enabled: false, x: 0, y: 0, w: 1, h: 1, angle: 0 };
}

export function cropIsIdentity(c: Crop): boolean {
  return !c.enabled || (c.angle === 0 && c.x <= 0 && c.y <= 0 && c.w >= 1 && c.h >= 1);
}

export function defaultParams(): EditParams {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    vibrance: 0,
    saturation: 0,
    baseContrast: 1,
    sharpen: 25,
    rotation: 0,
    texture: 0,
    clarity: 0,
    denoiseLuma: 0,
    denoiseChroma: 25,
    denoiseDetail: 50,
    grading: defaultGrading(),
    mirror: defaultMirror(),
    watermark: defaultWatermark(),
    crop: defaultCrop(),
    hsl: {
      hue: new Array(8).fill(0),
      saturation: new Array(8).fill(0),
      luminance: new Array(8).fill(0),
    },
    curves: { master: line(), red: line(), green: line(), blue: line() },
  };
}

export const HSL_BANDS = [
  { name: "Red", color: "#e5484d" },
  { name: "Orange", color: "#f5872b" },
  { name: "Yellow", color: "#f0c419" },
  { name: "Green", color: "#46a758" },
  { name: "Aqua", color: "#2ab3c0" },
  { name: "Blue", color: "#3e7be8" },
  { name: "Purple", color: "#8e4ec6" },
  { name: "Magenta", color: "#d6409f" },
];
