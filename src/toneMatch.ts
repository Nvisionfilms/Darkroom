// Applying a tone match: which sliders it sets, and how far.
//
// The solver (tonematch.rs) hands back nine slider values. Everything the panel
// does with them - setting them, backing them off with a strength control,
// putting the photo back as it was - is plain arithmetic, kept here so it can be
// checked without the window.

import type { EditParams, Tune } from "./types";

export const TUNE_KEYS: (keyof Tune)[] = [
  "exposure",
  "contrast",
  "highlights",
  "shadows",
  "whites",
  "blacks",
  "temperature",
  "tint",
  "saturation",
];

/** The slider values a photo has right now. */
export function tuneOf(p: EditParams): Tune {
  return {
    exposure: p.exposure,
    contrast: p.contrast,
    highlights: p.highlights,
    shadows: p.shadows,
    whites: p.whites,
    blacks: p.blacks,
    temperature: p.temperature,
    tint: p.tint,
    saturation: p.saturation,
  };
}

/** Write a set of slider values into a photo's edits, touching nothing else. */
export function withTune(p: EditParams, t: Tune): EditParams {
  return { ...p, ...t };
}

/**
 * Blend from where the sliders started to where the match put them. Zero is the
 * photo as it was and one is the full match; every slider moves the same share
 * of its own way, so half strength really is halfway in all nine. Twin of
 * tonematch.rs blend.
 */
export function blendTune(from: Tune, to: Tune, strength: number): Tune {
  const k = Math.max(0, Math.min(1, strength));
  const out = {} as Tune;
  for (const key of TUNE_KEYS) out[key] = from[key] + (to[key] - from[key]) * k;
  return out;
}

/** How much of the gap to the reference the match closed, as a percentage. */
export function closed(before: number, after: number): number {
  if (!(before > 1e-9)) return 100;
  return Math.max(0, Math.min(100, (1 - after / before) * 100));
}
