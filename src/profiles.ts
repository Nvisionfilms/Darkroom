// Twin of src-tauri/src/profiles.rs. The numbers must match exactly.

export interface ProfileLook {
  contrast: number;
  saturation: number;
  vibrance: number;
  temperature: number;
  bandSat: number[];
  bandLum: number[];
  bandHue: number[];
  mono: boolean;
  monoMix: [number, number, number];
}

const Z = () => [0, 0, 0, 0, 0, 0, 0, 0];
const REC709: [number, number, number] = [0.2126, 0.7152, 0.0722];

const base = (): ProfileLook => ({
  contrast: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  bandSat: Z(),
  bandLum: Z(),
  bandHue: Z(),
  mono: false,
  monoMix: REC709,
});

export const PROFILES: { id: string; name: string; hint: string }[] = [
  { id: "standard", name: "Standard", hint: "NFrame Studio's neutral starting point" },
  { id: "neutral", name: "Neutral", hint: "Softer contrast, easy to grade from" },
  { id: "portrait", name: "Portrait", hint: "Gentle contrast, calmer skin tones" },
  { id: "landscape", name: "Landscape", hint: "Stronger contrast, deeper greens and skies" },
  { id: "vivid", name: "Vivid", hint: "Punchy contrast and colour" },
  { id: "flat", name: "Flat", hint: "Low contrast, maximum latitude" },
  { id: "mono", name: "Monochrome", hint: "Black and white, neutral mix" },
  { id: "mono-yellow", name: "Mono · Yellow filter", hint: "Black and white, slightly darker skies" },
  { id: "mono-red", name: "Mono · Red filter", hint: "Black and white, dramatic skies" },
];

/**
 * What each picture profile adds to the sliders.
 *
 * TWIN of profiles.rs: the preview reads this table and the export reads that
 * one, so every number has to be the same in both. They were once strengthened
 * in the Rust file alone, which changed every export and left the screen exactly
 * as it was - the profiles looked as though they did nothing, because on screen
 * they did not. scripts/twins.mjs now compares the two tables number for number.
 */
export function look(id: string): ProfileLook {
  switch (id) {
    case "flat":
    case "linear":
      return { ...base(), contrast: -22, saturation: -18 };
    case "neutral":
      return { ...base(), contrast: -14, saturation: -12, vibrance: 8 };
    case "portrait":
      return {
        ...base(),
        contrast: 10,
        saturation: -5,
        vibrance: 22,
        temperature: 8,
        bandSat: [-9, -18, -9, 0, 0, 0, 0, -5],
        bandLum: [5, 12, 7, 0, 0, 0, 0, 0],
        bandHue: [0, 7, 0, 0, 0, 0, 0, 0],
      };
    case "landscape":
      return {
        ...base(),
        contrast: 26,
        saturation: 14,
        vibrance: 26,
        temperature: -5,
        bandSat: [0, 0, 14, 30, 22, 30, 0, 0],
        bandLum: [0, 0, 5, -9, -5, -13, 0, 0],
        bandHue: [0, 0, -9, -13, 0, 0, 0, 0],
      };
    case "vivid":
      return { ...base(), contrast: 38, saturation: 38, vibrance: 22 };
    case "mono":
      return { ...base(), contrast: 18, mono: true };
    case "mono-red":
      return { ...base(), contrast: 26, mono: true, monoMix: [0.62, 0.31, 0.07] };
    case "mono-yellow":
      return { ...base(), contrast: 22, mono: true, monoMix: [0.42, 0.48, 0.1] };
    default:
      return base();
  }
}

/** Profiles that produce a black and white result. */
export function isMono(id: string): boolean {
  return look(id).mono;
}
