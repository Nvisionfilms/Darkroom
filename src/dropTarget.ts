// Where a file dragged in from the desktop counts as dropped on the double
// exposure.
//
// Tauri owns the drag and drop, so the webview never sees an HTML dragover: the
// pointer arrives in physical pixels and is matched against the page by hand.
// It used to count only over the drop zone itself - a box a couple of hundred
// pixels wide inside an inspector section that has to be open - so a file
// dropped on the photo, or a little off the zone, did nothing at all.

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Is a point, in physical pixels, inside a box measured in CSS pixels? */
export function insideBox(x: number, y: number, box: Box, dpr: number): boolean {
  const scale = dpr > 0 ? dpr : 1;
  const cx = x / scale;
  const cy = y / scale;
  return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
}

/**
 * Does a drop at this point go to the double exposure?
 *
 * While the Double Exposure section is open, anywhere in the window does: that
 * is where your attention is, and a drop that lands on the photo is plainly
 * meant for it. With the section closed a drop is not claimed, so it cannot
 * quietly start a double exposure nobody was thinking about.
 */
export function dropGoesToBlend(sectionOpen: boolean, x: number, y: number, window: Box, dpr: number): boolean {
  return sectionOpen && insideBox(x, y, window, dpr);
}

const IMAGE_EXT = new Set([
  "jpg", "jpeg", "png", "tif", "tiff", "webp", "bmp", "gif",
  "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "rw2", "orf", "pef", "srw", "x3f", "3fr", "iiq", "kdc", "mrw", "mef", "erf", "dcr", "ari", "braw", "ctg",
]);

/**
 * The first dropped path that looks like a photo. A drop of a whole folder's
 * worth of files, or one with a stray text file in it, should still find the
 * picture rather than failing on whatever happened to come first.
 */
export function firstPhoto(paths: string[], extra: string[] = []): string | null {
  const ok = new Set([...IMAGE_EXT, ...extra.map((e) => e.replace(/^\./, "").toLowerCase())]);
  for (const p of paths) {
    const dot = p.lastIndexOf(".");
    const slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    if (dot > slash && ok.has(p.slice(dot + 1).toLowerCase())) return p;
  }
  return null;
}
