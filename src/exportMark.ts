// Putting a watermark on an export, whatever each photo was saved with.
//
// The watermark is part of a photo's saved edits, so by default each photo
// exports with whatever it has - which for a batch usually means nothing,
// because the mark was only ever placed on the one photo you were looking at.
// This is the choice made at export time, kept apart from the dialog so it can
// be checked.

import type { EditParams, Watermark } from "./types";

/**
 * What to do about the watermark when exporting:
 *  - "photo": leave each photo as it was saved
 *  - "none": no watermark on any of them, whatever they were saved with
 *  - a path: that image, on every photo, placed and sized like the open photo's
 */
export type MarkChoice = "photo" | "none" | string;

export function withMark(edits: EditParams, choice: MarkChoice, placed: Watermark): EditParams {
  if (choice === "photo") return edits;
  if (choice === "none") {
    return { ...edits, watermark: { ...edits.watermark, enabled: false } };
  }
  // The position is a fraction of the cropped frame, so the same place and the
  // same size suit photos of any shape: a corner stays a corner.
  return { ...edits, watermark: { ...placed, path: choice, enabled: true } };
}
