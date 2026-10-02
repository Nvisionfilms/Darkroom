// Cross-screen ("starburst") lens filter: the numbers the preview and the
// export have to agree on. Twin of src-tauri/src/star.rs - every constant and
// every mapping here appears there too, and scripts/twins.mjs checks it.

import type { Star } from "./types";

/** Samples along each half-line. Fixed so the GLSL loop is a constant bound. */
export const STAR_SAMPLES = 24;

/** Longest streak, as a fraction of the long edge at length = 100. */
export const STAR_MAX_LENGTH = 0.25;

/** Streak brightness at amount = 100. */
export const STAR_MAX_GAIN = 8.0;

/** How far dispersion pulls red and blue apart, as a fraction of the offset. */
export const STAR_MAX_DISPERSION = 0.08;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function starActive(s: Star): boolean {
  return s.enabled && s.amount > 0 && s.length > 0;
}

/** Lines of light: a star has two points per groove direction. */
export function starLines(points: number): number {
  return Math.max(1, Math.floor(Math.max(2, Math.min(12, Math.round(points))) / 2));
}

export function starGain(amount: number): number {
  return clamp01(amount / 100) * STAR_MAX_GAIN;
}

/** Streak half-length in pixels on an image whose long edge is `long`. */
export function starLenPx(length: number, long: number): number {
  return clamp01(length / 100) * STAR_MAX_LENGTH * long;
}

/** Exponent of the (1 - t) fade along the streak. */
export function starFadeExp(falloff: number): number {
  return 0.5 + clamp01(falloff / 100) * 3.5;
}

export function starDispersion(dispersion: number): number {
  return clamp01(dispersion / 100) * STAR_MAX_DISPERSION;
}

export function starThreshold(threshold: number): number {
  return Math.max(0, Math.min(0.999, threshold / 100));
}
