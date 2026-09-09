// Object remover helpers for the preview. The colour offset formula is the
// twin of `heal_offset` in src-tauri/src/heal.rs, evaluated on the preview
// instead of the full-resolution photo.

import { f16ToNumber } from "./mask";
import type { HealSpot, PreviewImage } from "./types";

/** Mean linear colour of a disc, sampled on the preview's half floats. */
function discMean(img: PreviewImage, cx: number, cy: number, r: number): [number, number, number] {
  const step = Math.max(1, r / 6);
  let acc = [0, 0, 0];
  let n = 0;
  for (let dy = -r; dy <= r; dy += step) {
    for (let dx = -r; dx <= r; dx += step) {
      if (dx * dx + dy * dy > r * r) continue;
      const x = Math.round(cx + dx);
      const y = Math.round(cy + dy);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const i = (y * img.width + x) * 3;
      acc[0] += f16ToNumber(img.data[i]);
      acc[1] += f16ToNumber(img.data[i + 1]);
      acc[2] += f16ToNumber(img.data[i + 2]);
      n++;
    }
  }
  return n > 0 ? [acc[0] / n, acc[1] / n, acc[2] / n] : [0, 0, 0];
}

/**
 * The smooth colour/brightness difference a heal spot adds to the copied
 * patch. Clone spots get no offset.
 */
export function healOffset(img: PreviewImage, spot: HealSpot): [number, number, number] {
  if (spot.kind === "clone") return [0, 0, 0];
  const long = Math.max(img.width, img.height);
  const r = Math.max(1, spot.radius * long) * 1.35;
  const d = discMean(img, spot.x * img.width, spot.y * img.height, r);
  const s = discMean(img, spot.sx * img.width, spot.sy * img.height, r);
  return [d[0] - s[0], d[1] - s[1], d[2] - s[2]];
}

/** A stable key for the set of spots, used to cache the heal pass. */
export function healKey(spots: HealSpot[]): string {
  return spots
    .filter((s) => s.enabled && s.opacity > 0 && s.radius > 0)
    .map((s) => [s.kind, s.x, s.y, s.sx, s.sy, s.radius, s.feather, s.opacity].join(","))
    .join("|");
}
