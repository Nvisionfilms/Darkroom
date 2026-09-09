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
  { id: "standard", name: "Standard", hint: "Darkroom's neutral starting point" },
  { id: "neutral", name: "Neutral", hint: "Softer contrast, easy to grade from" },
  { id: "portrait", name: "Portrait", hint: "Gentle contrast, calmer skin tones" },
  { id: "landscape", name: "Landscape", hint: "Stronger contrast, deeper greens and skies" },
  { id: "vivid", name: "Vivid", hint: "Punchy contrast and colour" },
  { id: "flat", name: "Flat", hint: "Low contrast, maximum latitude" },
  { id: "mono", name: "Monochrome", hint: "Black and white, neutral mix" },
  { id: "mono-yellow", name: "Mono · Yellow filter", hint: "Black and white, slightly darker skies" },
  { id: "mono-red", name: "Mono · Red filter", hint: "Black and white, dramatic skies" },
];

export function look(id: string): ProfileLook {
  switch (id) {
    case "flat":
    case "linear":
      return { ...base(), contrast: -10, saturation: -8 };
    case "neutral":
      return { ...base(), contrast: -6, saturation: -6, vibrance: 4 };
    case "portrait":
      return {
        ...base(),
        contrast: 4,
        saturation: -2,
        vibrance: 10,
        temperature: 4,
        bandSat: [-4, -8, -4, 0, 0, 0, 0, -2],
        bandLum: [2, 5, 3, 0, 0, 0, 0, 0],
        bandHue: [0, 3, 0, 0, 0, 0, 0, 0],
      };
    case "landscape":
      return {
        ...base(),
        contrast: 12,
        saturation: 6,
        vibrance: 12,
        temperature: -2,
        bandSat: [0, 0, 6, 14, 10, 14, 0, 0],
        bandLum: [0, 0, 2, -4, -2, -6, 0, 0],
        bandHue: [0, 0, -4, -6, 0, 0, 0, 0],
      };
    case "vivid":
      return { ...base(), contrast: 18, saturation: 18, vibrance: 10 };
    case "mono":
      return { ...base(), contrast: 8, mono: true };
    case "mono-red":
      return { ...base(), contrast: 12, mono: true, monoMix: [0.62, 0.31, 0.07] };
    case "mono-yellow":
      return { ...base(), contrast: 10, mono: true, monoMix: [0.42, 0.48, 0.1] };
    default:
      return base();
  }
}

/** Profiles that produce a black and white result. */
export function isMono(id: string): boolean {
  return look(id).mono;
}
