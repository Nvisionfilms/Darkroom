// Video scopes: waveform, RGB parade and vectorscope, built from the same
// downsampled frame the histogram already reads back, so they cost no extra
// work on the GPU.
//
// Everything here is arithmetic on pixels, kept out of the drawing code so it
// can be checked: the skin tone line in particular is derived from real skin
// colours rather than copied from a diagram.

/** Rec.709 luma, the weighting the rest of the pipeline uses. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Rec.709 colour difference, scaled so each axis runs -0.5..0.5. A vectorscope
 * plots these two against each other: the middle is grey, the distance out is
 * how saturated a colour is and the direction round is its hue.
 */
export function chroma(r: number, g: number, b: number): [number, number] {
  const y = luma(r, g, b);
  return [(b - y) / 1.8556, (r - y) / 1.5748];
}

/**
 * Skin, as a spread of real complexions rather than one swatch: light through
 * deep, warm and cool, sampled from sRGB values that photographs of people
 * actually land on.
 */
export const SKIN_REFERENCES: [number, number, number][] = [
  [0.98, 0.84, 0.74],
  [0.94, 0.78, 0.66],
  [0.89, 0.71, 0.58],
  [0.82, 0.62, 0.49],
  [0.74, 0.55, 0.42],
  [0.63, 0.45, 0.34],
  [0.51, 0.35, 0.26],
  [0.40, 0.27, 0.20],
  [0.29, 0.19, 0.14],
  [0.21, 0.14, 0.10],
];

/**
 * The direction skin sits in on the vectorscope, in radians.
 *
 * Worked out from the references above rather than taken as a constant: every
 * one of them is reduced to its colour difference, and the average direction of
 * those is the line. Complexions differ enormously in brightness and hardly at
 * all in hue, which is exactly why the line is useful - a face that is too green
 * or too magenta falls off it, whoever it belongs to.
 */
export function skinAngle(): number {
  let sx = 0;
  let sy = 0;
  for (const [r, g, b] of SKIN_REFERENCES) {
    const [cb, cr] = chroma(r, g, b);
    const m = Math.hypot(cb, cr);
    if (m < 1e-6) continue;
    // each reference counts once, however saturated it happens to be
    sx += cb / m;
    sy += cr / m;
  }
  return Math.atan2(sy, sx);
}

/** How far off the skin line a colour sits, in radians, 0 to PI. */
export function angleFromSkinLine(r: number, g: number, b: number): number {
  const [cb, cr] = chroma(r, g, b);
  if (Math.hypot(cb, cr) < 1e-6) return 0;
  let d = Math.abs(Math.atan2(cr, cb) - skinAngle());
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

export interface Frame {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Waveform: one column of the plot per column of the picture, and within it a
 * tally of how many pixels sit at each brightness. `pick` chooses what is
 * measured - luma for the waveform, one channel for a parade.
 */
export function waveform(frame: Frame, cols: number, rows: number, pick: (r: number, g: number, b: number) => number): Uint32Array {
  const out = new Uint32Array(cols * rows);
  const { data, width, height } = frame;
  if (width === 0 || height === 0) return out;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = pick(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      const col = Math.min(cols - 1, Math.floor((x / width) * cols));
      const row = Math.min(rows - 1, Math.max(0, Math.round((1 - v) * (rows - 1))));
      out[row * cols + col]++;
    }
  }
  return out;
}

/** Vectorscope: how many pixels land on each point of the colour plane. */
export function vectorscope(frame: Frame, size: number): Uint32Array {
  const out = new Uint32Array(size * size);
  const { data, width, height } = frame;
  const half = size / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [cb, cr] = chroma(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255);
      // the plot runs -0.5..0.5 on both axes, with Cr upwards as scopes draw it
      const px = Math.round(half + cb * size);
      const py = Math.round(half - cr * size);
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      out[py * size + px]++;
    }
  }
  return out;
}

/** Where the primaries and secondaries land, for the vectorscope's boxes. */
export const VECTOR_TARGETS: { name: string; rgb: [number, number, number] }[] = [
  { name: "R", rgb: [1, 0, 0] },
  { name: "Y", rgb: [1, 1, 0] },
  { name: "G", rgb: [0, 1, 0] },
  { name: "C", rgb: [0, 1, 1] },
  { name: "B", rgb: [0, 0, 1] },
  { name: "M", rgb: [1, 0, 1] },
];
