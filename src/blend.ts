/**
 * Double exposure: a second photograph composited onto the one being edited.
 *
 * Twin of `src-tauri/src/blend.rs`. The placement maths below is repeated in
 * `src/gl/shaders.ts` as `blendSample`; the blend modes are repeated there as
 * `blendMode`. All three must change together or the export will not match
 * what the screen shows.
 */
import type { Blend } from "./types";

export const MODE_EXPOSE = 0;
export const MODE_NORMAL = 1;
export const MODE_SCREEN = 2;
export const MODE_MULTIPLY = 3;
export const MODE_OVERLAY = 4;
export const MODE_SOFT_LIGHT = 5;
export const MODE_LIGHTEN = 6;
export const MODE_DARKEN = 7;
export const MODE_DIFFERENCE = 8;

export interface BlendMode {
  id: string;
  name: string;
  hint: string;
}

/** In the order they appear in the panel; "expose" is the default. */
export const BLEND_MODES: BlendMode[] = [
  {
    id: "expose",
    name: "Expose (true double exposure)",
    hint: "Adds the second picture as light before the tone mapping, the way two exposures on one negative behave. Where the two overlap the highlights roll off together.",
  },
  {
    id: "screen",
    name: "Screen",
    hint: "The darkroom way: the second picture shows through the shadows and leaves the highlights alone.",
  },
  { id: "multiply", name: "Multiply", hint: "The second picture shows through the highlights and darkens the rest." },
  { id: "lighten", name: "Lighten", hint: "Keeps whichever picture is brighter at each pixel." },
  { id: "darken", name: "Darken", hint: "Keeps whichever picture is darker at each pixel." },
  { id: "overlay", name: "Overlay", hint: "Contrasty: multiplies the shadows and screens the highlights." },
  { id: "softlight", name: "Soft light", hint: "A gentler overlay; good for texture." },
  { id: "difference", name: "Difference", hint: "The distance between the two pictures. Graphic rather than photographic." },
  { id: "normal", name: "Normal", hint: "A plain layer, faded in with the opacity slider." },
];

export const BLEND_FITS = [
  { id: "cover", name: "Fill the frame" },
  { id: "contain", name: "Fit inside the frame" },
  { id: "stretch", name: "Stretch to the frame" },
];

const IDS: Record<string, number> = {
  normal: MODE_NORMAL,
  screen: MODE_SCREEN,
  multiply: MODE_MULTIPLY,
  overlay: MODE_OVERLAY,
  softlight: MODE_SOFT_LIGHT,
  lighten: MODE_LIGHTEN,
  darken: MODE_DARKEN,
  difference: MODE_DIFFERENCE,
};

/** Twin of `blend::mode_id`; anything unknown is the true double exposure. */
export function modeId(name: string): number {
  return IDS[name] ?? MODE_EXPOSE;
}

export interface Placement {
  /** centre of the overlay in frame pixels */
  cx: number;
  cy: number;
  /** the overlay's size in frame pixels */
  denx: number;
  deny: number;
  cos: number;
  sin: number;
  flip: boolean;
}

/** Twin of `blend::Placement::new`. */
export function placement(b: Blend, bw: number, bh: number, ow: number, oh: number): Placement {
  const s = Math.max(0.01, b.scale / 100);
  let kx: number;
  let ky: number;
  if (b.fit === "contain") {
    kx = ky = Math.min(bw / ow, bh / oh) * s;
  } else if (b.fit === "stretch") {
    kx = (bw / ow) * s;
    ky = (bh / oh) * s;
  } else {
    kx = ky = Math.max(bw / ow, bh / oh) * s;
  }
  const th = (b.rotation * Math.PI) / 180;
  return {
    cx: bw * 0.5 * (1 + b.x / 100),
    cy: bh * 0.5 * (1 + b.y / 100),
    denx: Math.max(1e-6, ow * kx),
    deny: Math.max(1e-6, oh * ky),
    cos: Math.cos(th),
    sin: Math.sin(th),
    flip: b.flip,
  };
}

/** File name without its folder, for the panel. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}
