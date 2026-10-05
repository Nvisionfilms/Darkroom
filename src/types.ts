export type Point = [number, number];

/** Hot-folder tethering (see src-tauri/src/tether.rs). */
export interface TetherStatus {
  active: boolean;
  folder: string;
  count: number;
}

/** Phone monitor server (see src-tauri/src/monitor.rs). */
export interface MonitorInfo {
  active: boolean;
  url: string;
  port: number;
  qrSvg: string;
  viewers: number;
}

export interface MonitorThumb {
  name: string;
  src: string;
  active: boolean;
}

export interface MonitorShot {
  name: string;
  meta: string;
  index: number;
  total: number;
  thumbs: MonitorThumb[];
}

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
 * - offset: source image edge feather 0..0.25
 * - direction: degrees (0 = right, 90 = down)
 * - length: distance as a fraction of the long edge
 * - opacity: 0..100
 *
 * cy and rotation remain on the wire for backwards compatibility but are not
 * used by the motion-trail renderer.
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
  /** id of the mask the trail is cut from; empty = the whole frame */
  mask: string;
}

/**
 * Cross-screen ("starburst") lens filter: the highlights already in the picture
 * are smeared along a few directions and added back. Twin of star.rs.
 */
export interface Star {
  enabled: boolean;
  /** 0..100 streak brightness */
  amount: number;
  /** points on the star: 4 is the classic cross-screen, up to 12 */
  points: number;
  /** 0..100 streak length */
  length: number;
  /** rotation of the whole star, degrees */
  angle: number;
  /** 0..100 how bright a pixel has to be before it stars at all */
  threshold: number;
  /** 0..100 how quickly the streak fades along its length */
  falloff: number;
  /** 0..100 rainbow spread towards the ends of the streaks */
  dispersion: number;
  /** id of the mask the stars come from; empty = every highlight in the frame */
  mask: string;
}

/**
 * Darken or lighten towards the corners of the cropped frame. Twin of
 * vignette.rs; it follows the crop, so cropping in moves it to the new edges.
 */
export interface Vignette {
  enabled: boolean;
  /** -100 darkens the corners, +100 lightens them towards white */
  amount: number;
  /** 0..100 how far out it starts */
  midpoint: number;
  /** 0..100 how gradually it comes on */
  feather: number;
  opacity: number;
}

export function defaultVignette(): Vignette {
  return { enabled: false, amount: -35, midpoint: 50, feather: 50, opacity: 100 };
}

export function defaultStar(): Star {
  return {
    enabled: false,
    amount: 60,
    points: 4,
    length: 35,
    angle: 0,
    threshold: 75,
    falloff: 40,
    dispersion: 25,
    mask: "",
  };
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

/** Per-mask adjustment deltas, same units as the global sliders (exposure in EV). */
export interface MaskAdjust {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  saturation: number;
  texture: number;
  clarity: number;
  dehaze: number;
}

/** Order matters: it is the layout of the shader's uMaskAdj array and of pipeline.rs Tone::add. */
export const MASK_ADJUST_KEYS: (keyof MaskAdjust)[] = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "temperature",
  "tint",
  "saturation",
  "texture",
  "clarity",
  "dehaze",
];

export interface Stroke {
  /** normalised image coords */
  x: number[];
  y: number[];
  /** diameter as a fraction of the long edge */
  size: number;
  /** 0..100 */
  feather: number;
  /** 0..100 */
  flow: number;
  erase: boolean;
}

export type MaskKind = "linear" | "radial" | "brush" | "luminance" | "subject";

/**
 * "add" carries its own adjustments; "subtract" carries none and instead cuts
 * its area out of the mask above it in the stack, so a selection can be
 * narrowed without inverting anything else. Twin of mask.rs.
 */
export type MaskMode = "add" | "subtract";

/**
 * A local adjustment ("overlay"). Geometry in normalised image coordinates;
 * see src-tauri/src/mask.rs for the exact meaning of each field.
 */
export interface Mask {
  id: string;
  name: string;
  enabled: boolean;
  invert: boolean;
  kind: MaskKind;
  mode: MaskMode;
  /** 0..100 */
  amount: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rotation: number;
  /** 0..100 radial edge softness */
  feather: number;
  strokes: Stroke[];
  lumLo: number;
  lumHi: number;
  lumFeather: number;
  /** subject: grayscale PNG data URL */
  raster: string | null;
  adjust: MaskAdjust;
}

export function defaultMaskAdjust(): MaskAdjust {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    saturation: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
  };
}

export function maskAdjustIsZero(a: MaskAdjust): boolean {
  return MASK_ADJUST_KEYS.every((k) => a[k] === 0);
}

export const MASK_KIND_LABEL: Record<MaskKind, string> = {
  linear: "Linear gradient",
  radial: "Radial gradient",
  brush: "Brush",
  luminance: "Luminance range",
  subject: "Subject",
};

let maskCounter = 0;

export function newMask(kind: MaskKind, existing: Mask[], mode: MaskMode = "add"): Mask {
  const n = existing.filter((m) => m.kind === kind).length + 1;
  maskCounter += 1;
  return {
    id: `${kind}-${Date.now().toString(36)}-${maskCounter}`,
    name: `${MASK_KIND_LABEL[kind]} ${n}`,
    enabled: true,
    invert: false,
    kind,
    mode,
    amount: 100,
    x0: 0.5,
    y0: 0.05,
    x1: 0.5,
    y1: 0.55,
    cx: 0.5,
    cy: 0.5,
    rx: 0.3,
    ry: 0.2,
    rotation: 0,
    feather: 50,
    strokes: [],
    lumLo: 0,
    lumHi: 0.35,
    lumFeather: 0.15,
    raster: null,
    adjust: defaultMaskAdjust(),
  };
}

/**
 * The mask a subtract mask at `i` cuts into: the nearest ordinary mask above
 * it, or -1 when there is none and it therefore does nothing.
 */
export function maskHead(masks: Mask[], i: number): number {
  for (let j = Math.min(i, masks.length - 1); j >= 0; j--) {
    if (masks[j].mode !== "subtract") return j;
  }
  return -1;
}

/**
 * Where a new subtract mask for the group holding `i` belongs: directly under
 * its head and any subtractions already there, so the stack reads top to
 * bottom as "this area, less this, less that".
 */
export function subtractInsertAt(masks: Mask[], i: number): number {
  const head = maskHead(masks, i);
  if (head < 0) return masks.length;
  let j = head + 1;
  while (j < masks.length && masks[j].mode === "subtract") j++;
  return j;
}

/** Perspective / geometry sliders. All -100..100 except rotate, in degrees. */
export interface Transform {
  vertical: number;
  horizontal: number;
  rotate: number;
  scale: number;
  aspect: number;
  x: number;
  y: number;
}

/** Lens correction settings; see src-tauri/src/geometry.rs. */
export interface Lens {
  profile: boolean;
  distortionAmount: number;
  vignetteAmount: number;
  ca: boolean;
  manualDistortion: number;
  manualVignette: number;
  manualVignetteMid: number;
  manualCaR: number;
  manualCaB: number;
}

/** Calibration resolved from the bundled lensfun database. */
export interface LensProfile {
  name: string;
  /** 0 none, 1 ptlens, 2 poly3, 3 poly5 */
  distModel: number;
  dist: [number, number, number];
  vig: [number, number, number];
  tca: [number, number];
  cropScale: number;
}

/** One object-remover spot. Positions are fractions of the image size. */
export interface HealSpot {
  id: string;
  /** "heal" matches the surroundings, "clone" copies as-is */
  kind: "heal" | "clone";
  enabled: boolean;
  x: number;
  y: number;
  sx: number;
  sy: number;
  /** fraction of the long edge */
  radius: number;
  /**
   * The painted path, in the same normalised coordinates as x/y. Empty or a
   * single point is a plain disc; more points sweep the brush along them, so a
   * wire or a line marking can be followed rather than covered with a row of
   * circles. Capped at MAX_PATH in heal.ts, which the shader matches.
   */
  path: [number, number][];
  feather: number;
  opacity: number;
}

/** A creative look-up table loaded from a .cube file. */
export interface Look {
  enabled: boolean;
  path: string;
  name: string;
  /** 0..100 blend with the un-looked image */
  amount: number;
  /** what the LUT expects as input: "display" or a camera log space (camlog.ts) */
  input: string;
}

export function defaultLook(): Look {
  return { enabled: true, path: "", name: "", amount: 100, input: "display" };
}

/**
 * Double exposure: a second photograph composited onto this one. See
 * blend.ts for the modes and src-tauri/src/blend.rs for the maths.
 */
export interface Blend {
  enabled: boolean;
  /** the second photograph; any format the app can open, RAW included */
  path: string;
  /** file name, shown in the panel */
  name: string;
  /** see BLEND_MODES in blend.ts */
  mode: string;
  /** 0..100 */
  opacity: number;
  /** exposure of the second picture, in stops */
  exposure: number;
  /** 10..400, percent of the fitted size */
  scale: number;
  /** -100..100, percent of half the frame */
  x: number;
  y: number;
  /** degrees, clockwise */
  rotation: number;
  flip: boolean;
  invert: boolean;
  /** "cover", "contain" or "stretch" */
  fit: string;
}

/** Film grain. Twin of grain.rs. */
export interface Grain {
  /** 0..100, how strongly the grain shows */
  amount: number;
  /** 0..100, how coarse the clumps are */
  size: number;
  /** 0..100, how much the grain tints as well as darkens */
  colour: number;
}

export function defaultGrain(): Grain {
  return { amount: 0, size: 40, colour: 0 };
}

export function defaultBlend(): Blend {
  return {
    enabled: true,
    path: "",
    name: "",
    mode: "expose",
    opacity: 100,
    exposure: 0,
    scale: 100,
    x: 0,
    y: 0,
    rotation: 0,
    flip: false,
    invert: false,
    fit: "cover",
  };
}

/** A saved set of develop settings. `settings` is an EditParams subset. */
export interface Preset {
  name: string;
  settings: Partial<EditParams>;
}

/**
 * The develop fields a preset carries. Anything tied to one frame (crop,
 * rotation, perspective, masks, retouch spots, the lens calibration) is left
 * out on purpose, so applying a preset never moves the picture around.
 */
export const PRESET_KEYS: (keyof EditParams)[] = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "temperature",
  "tint",
  "vibrance",
  "saturation",
  "baseContrast",
  "sharpen",
  "texture",
  "clarity",
  "dehaze",
  "denoiseLuma",
  "denoiseChroma",
  "denoiseDetail",
  "grain",
  "star",
  "vignette",
  "grading",
  "hsl",
  "curves",
  "profile",
  "look",
  "lens",
];

/** Copy just the preset fields out of a full edit. */
export function presetSettings(p: EditParams): Partial<EditParams> {
  const out: Record<string, unknown> = {};
  for (const k of PRESET_KEYS) out[k] = p[k];
  return out as Partial<EditParams>;
}

export function defaultTransform(): Transform {
  return { vertical: 0, horizontal: 0, rotate: 0, scale: 0, aspect: 0, x: 0, y: 0 };
}

export function defaultLens(): Lens {
  return {
    profile: true,
    distortionAmount: 100,
    vignetteAmount: 100,
    ca: true,
    manualDistortion: 0,
    manualVignette: 0,
    manualVignetteMid: 50,
    manualCaR: 0,
    manualCaB: 0,
  };
}

let healCounter = 0;

export function newHealSpot(x: number, y: number, radius: number, kind: "heal" | "clone" = "heal"): HealSpot {
  healCounter += 1;
  return {
    id: `spot-${Date.now().toString(36)}-${healCounter}`,
    kind,
    enabled: true,
    x,
    y,
    sx: x,
    sy: y,
    radius,
    path: [],
    feather: 60,
    opacity: 100,
  };
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
  /** -100..100: positive removes haze, negative adds it */
  dehaze: number;
  /** local adjustments */
  masks: Mask[];
  /** picture profile id, see profiles.ts */
  profile: string;
  /** creative look from a .cube file */
  look: Look;
  transform: Transform;
  lens: Lens;
  /** calibration cached for this photo, or null when the lens is unknown */
  lensProfile: LensProfile | null;
  /** object remover spots */
  heal: HealSpot[];
  /** double exposure: a second photograph composited onto this one */
  blend: Blend;
  /** film grain */
  grain: Grain;
  /** cross-screen ("starburst") lens filter */
  star: Star;
  /** darken or lighten towards the corners of the cropped frame */
  vignette: Vignette;
  /** flagged as finished and wanted in the next export */
  marked: boolean;
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
  /** how fast noise rises into the shadows; see denoise.rs noise_factor */
  noiseShadow: number;
  metadata: Metadata;
  edits: EditParams | null;
  thumbnail: string;
  /** lens calibration found for this camera and lens, if any */
  lensProfile: LensProfile | null;
}

export interface PreviewImage {
  width: number;
  height: number;
  /** interleaved RGB half floats */
  data: Uint16Array;
  noiseSigma: number;
  noiseShadow: number;
}

/** What a picture looks like for tone matching. Twin of tonematch.rs. */
export interface ToneStats {
  /** brightness at the 1st, 5th, 25th, 50th, 75th, 95th and 99th percentiles */
  q: number[];
  /** red and blue share of the light in the mid tones */
  mid: [number, number];
  sat: number;
}

/** The sliders a tone match sets. */
export interface Tune {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  saturation: number;
}

export interface ToneMatch {
  values: Tune;
  reference: ToneStats;
  before: ToneStats;
  after: ToneStats;
  distanceBefore: number;
  distanceAfter: number;
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
    offset: 0.08, // source-frame edge feather
    length: 0.16, // distance
    opacity: 65,
    mask: "",
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
    denoiseDetail: 35,
    grading: defaultGrading(),
    mirror: defaultMirror(),
    watermark: defaultWatermark(),
    crop: defaultCrop(),
    dehaze: 0,
    masks: [],
    profile: "standard",
    look: defaultLook(),
    transform: defaultTransform(),
    lens: defaultLens(),
    lensProfile: null,
    heal: [],
    blend: defaultBlend(),
    grain: defaultGrain(),
    star: defaultStar(),
    vignette: defaultVignette(),
    marked: false,
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
