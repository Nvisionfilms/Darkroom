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
 * Mirror power window. Center as fractions of image width/height, sizes and
 * distances as fractions of the long edge, angles in degrees (0 = right, 90 = down).
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
    cx: 0.5,
    cy: 0.45,
    rx: 0.18,
    ry: 0.22,
    rotation: 0,
    feather: 30,
    direction: 90,
    offset: 0,
    length: 0.35,
    opacity: 70,
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
