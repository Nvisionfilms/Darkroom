// Motion Trails: the numbers the preview and the export have to agree on.
// Twin of the trail maths in src-tauri/src/export.rs, checked by
// scripts/twins.mjs.
//
// Every length here is a fraction of the PHOTO's long edge, never of the viewer
// canvas. That distinction is the whole point of this file: measured against
// the canvas, the echoes kept their size in screen pixels while the photo under
// them grew and shrank, so the trail slid about as you zoomed and panned, and
// the preview only matched the exported file when the photo happened to be
// fitted to the window.

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The long edge the trail is measured against: the cropped frame, not the whole
 * photograph. The export lays trails on the finished, cropped picture and takes
 * its distances from that, so the preview has to as well. It used the uncropped
 * image, which made the trail a different length on screen than in the file as
 * soon as the photo was cropped - by half, for a crop that kept half the width.
 * Falls back to the whole image when no crop is known.
 */
export function trailLongEdge(frame: { width: number; height: number; outW?: number; outH?: number }): number {
  const w = frame.outW && frame.outW > 0 ? frame.outW : frame.width;
  const h = frame.outH && frame.outH > 0 ? frame.outH : frame.height;
  return Math.max(w, h);
}

/** A masked subject echoes as separate ghosts until there are enough to join up. */
export const MAX_TRAIL_COPIES = 24;

/** What Edge Feather means for a trail cut from a mask: its own edge. */
export const TRAIL_MASK_FEATHER = 0.06;

/** Echoes. Stored as copies/10 in the legacy `mirror.cx` field. */
export function trailCopies(cx: number): number {
  return Math.round(clamp(cx * 10, 1, MAX_TRAIL_COPIES));
}

/**
 * How far the furthest echo sits from the subject, in the pixels of whatever is
 * being drawn into. `pxPerImage` is how many of those pixels one photo pixel
 * covers: 1 for the export, the view scale for the preview.
 */
export function trailDistance(length: number, imgLong: number, pxPerImage: number): number {
  return clamp(length, 0, 0.7) * imgLong * pxPerImage;
}

/** Softening along the streak, same units as `trailDistance`. */
export function trailBlur(rx: number, imgLong: number, pxPerImage: number): number {
  return clamp(rx, 0, 1) * clamp(imgLong * 0.006, 2, 32) * pxPerImage;
}

/** How much of its strength each echo keeps from the one before it. */
export function trailFadeRetention(feather: number): number {
  return 0.2 + clamp(feather / 100, 0, 1) * 0.78;
}

/** Strength of echo `i` (1-based, nearest first). */
export function trailAlpha(opacity: number, amount: number, fadeRetention: number, i: number): number {
  return clamp(opacity / 100, 0, 1) * clamp(amount, 0, 1) * fadeRetention ** (i - 1) * 0.72;
}
