/**
 * Phone layout: which screens get it, and how the edit sections are grouped
 * into bottom-sheet tabs.
 *
 * The desktop layout needs about 960px of width. A phone gets a different
 * shell instead - photo on top, tool tabs along the bottom, one sheet of
 * controls at a time - built from the same inspector sections, so every
 * control is shared and nothing is duplicated. Desktop windows cannot shrink
 * far enough to trip this (tauri.conf.json sets a 1024 x 640 minimum), and
 * tablets keep the desktop layout, which fits them.
 */
import { useEffect, useState } from "react";

/** Portrait phones by width, landscape phones by height. */
export const PHONE_QUERY = "(max-width: 600px), (max-height: 500px)";

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const q = window.matchMedia(query);
    const update = () => setOn(q.matches);
    update();
    q.addEventListener("change", update);
    return () => q.removeEventListener("change", update);
  }, [query]);
  return on;
}

export function usePhone(): boolean {
  return useMedia(PHONE_QUERY);
}

/**
 * A touch screen is the main input: phones and tablets, not a desktop with a
 * mouse. Controls that sit in something scrollable use it to tell a scroll
 * from an adjustment.
 */
export function useCoarsePointer(): boolean {
  return useMedia("(pointer: coarse)");
}

export type PhoneTabId =
  | "light"
  | "color"
  | "curves"
  | "detail"
  | "effects"
  | "optics"
  | "crop"
  | "masks"
  | "repair"
  | "presets";

export interface PhoneTab {
  id: PhoneTabId;
  label: string;
  glyph: string;
  /** inspector section titles shown in this tab's sheet */
  sections: string[];
}

/** In the order they sit along the bottom bar. */
export const PHONE_TABS: PhoneTab[] = [
  { id: "light", label: "Light", glyph: "☀", sections: ["Tone"] },
  { id: "color", label: "Color", glyph: "◑", sections: ["Color", "HSL", "Color Grading"] },
  { id: "curves", label: "Curves", glyph: "∿", sections: ["Curves"] },
  { id: "detail", label: "Detail", glyph: "◇", sections: ["Detail", "Noise Reduction"] },
  { id: "effects", label: "Effects", glyph: "✦", sections: ["Double Exposure", "Motion Trails", "Watermark"] },
  { id: "optics", label: "Optics", glyph: "◎", sections: ["Lens Corrections", "Transform"] },
  { id: "crop", label: "Crop", glyph: "⌗", sections: ["Crop & Straighten"] },
  { id: "masks", label: "Masks", glyph: "◐", sections: ["Masks"] },
  { id: "repair", label: "Repair", glyph: "✚", sections: ["Object Remover"] },
  { id: "presets", label: "Presets", glyph: "★", sections: ["Presets"] },
];
