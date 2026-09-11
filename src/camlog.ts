// Twin of src-tauri/src/camlog.rs: camera log encodings and gamuts for looks
// built for log footage. Curves and primaries are the manufacturers'
// published specifications; the numbers must match the Rust file.

import { davinciIntermediateEncode } from "./color";

export type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];

export const ENC_DISPLAY = 0;
export const ENC_SLOG3 = 1;
export const ENC_CLOG3 = 2;
export const ENC_BMDFILM5 = 3;
export const ENC_DI = 4;

type XY = [number, number];
type Primaries = [XY, XY, XY];

const D65: XY = [0.3127, 0.329];
const DWG: Primaries = [[0.8, 0.313], [0.1682, 0.9877], [0.079, -0.1155]];
const S_GAMUT3_CINE: Primaries = [[0.766, 0.275], [0.225, 0.8], [0.089, -0.087]];
const S_GAMUT3: Primaries = [[0.73, 0.28], [0.14, 0.855], [0.1, -0.05]];
const CINEMA_GAMUT: Primaries = [[0.74, 0.27], [0.17, 1.14], [0.08, -0.1]];
const BMD_WG_GEN5: Primaries = [[0.7177215, 0.3171181], [0.228041, 0.861569], [0.1005841, -0.0820452]];
const BMD_WG_GEN5_WHITE: XY = [0.312717, 0.3290312];

/** Look input ids as stored in the sidecar, with their display names. */
export const LOOK_INPUTS: { id: string; name: string }[] = [
  { id: "display", name: "Rec.709 / sRGB (display)" },
  { id: "slog3-sgamut3cine", name: "Sony S-Log3 / S-Gamut3.Cine" },
  { id: "slog3-sgamut3", name: "Sony S-Log3 / S-Gamut3" },
  { id: "clog3-cinema", name: "Canon Log 3 / Cinema Gamut" },
  { id: "bmdfilm5-bmdwg5", name: "Blackmagic Film Gen 5 / Wide Gamut" },
  { id: "di-dwg", name: "DaVinci Intermediate / Wide Gamut" },
];

function mul(a: Mat3, b: Mat3): Mat3 {
  const o = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ] as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
  return o;
}

function invert(m: Mat3): Mat3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const k = 1 / det;
  return [
    [(e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k],
    [(f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k],
    [(d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k],
  ];
}

/** Normalised primary matrix: RGB with these primaries and white -> XYZ. */
function npm(p: Primaries, white: XY): Mat3 {
  const xyz = (x: number, y: number) => [x / y, 1, (1 - x - y) / y];
  const [r, g, b] = [xyz(...p[0]), xyz(...p[1]), xyz(...p[2])];
  const m: Mat3 = [
    [r[0], g[0], b[0]],
    [r[1], g[1], b[1]],
    [r[2], g[2], b[2]],
  ];
  const w = xyz(...white);
  const inv = invert(m);
  const s = [0, 1, 2].map((row) => inv[row][0] * w[0] + inv[row][1] * w[1] + inv[row][2] * w[2]);
  return m.map((row) => row.map((v, j) => v * s[j])) as Mat3;
}

const fromDwg = (target: Primaries, white: XY): Mat3 => mul(invert(npm(target, white)), npm(DWG, D65));

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

const cache = new Map<string, { encoding: number; matrix: Mat3 }>();

/** Encoding and DWG -> camera gamut matrix for a look input id. */
export function lookInput(id: string | undefined): { encoding: number; matrix: Mat3 } {
  const key = id ?? "display";
  const hit = cache.get(key);
  if (hit) return hit;
  let out: { encoding: number; matrix: Mat3 };
  switch (key) {
    case "slog3-sgamut3cine":
      out = { encoding: ENC_SLOG3, matrix: fromDwg(S_GAMUT3_CINE, D65) };
      break;
    case "slog3-sgamut3":
      out = { encoding: ENC_SLOG3, matrix: fromDwg(S_GAMUT3, D65) };
      break;
    case "clog3-cinema":
      out = { encoding: ENC_CLOG3, matrix: fromDwg(CINEMA_GAMUT, D65) };
      break;
    case "bmdfilm5-bmdwg5":
      out = { encoding: ENC_BMDFILM5, matrix: fromDwg(BMD_WG_GEN5, BMD_WG_GEN5_WHITE) };
      break;
    case "di-dwg":
      out = { encoding: ENC_DI, matrix: IDENTITY };
      break;
    default:
      out = { encoding: ENC_DISPLAY, matrix: IDENTITY };
  }
  cache.set(key, out);
  return out;
}

/** Row-major 3x3 -> the column-major array WebGL expects. */
export function columnMajor(m: Mat3): number[] {
  return [m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]];
}

export function slog3(x: number): number {
  return x >= 0.01125 ? (420 + Math.log10((x + 0.01) / 0.19) * 261.5) / 1023 : (x * (171.21029 - 95) / 0.01125 + 95) / 1023;
}

export function clog3(x: number): number {
  const v = x / 0.9;
  if (v < -0.014) return -0.36726845 * Math.log10(-v * 14.98325 + 1) + 0.12783901;
  if (v <= 0.014) return 1.9754798 * v + 0.12512219;
  return 0.36726845 * Math.log10(v * 14.98325 + 1) + 0.12240537;
}

export function bmdfilm5(x: number): number {
  return x < 0.005 ? 8.283606 * x + 0.09246575 : 0.08692876 * Math.log(x + 0.005494072) + 0.5300133;
}

export function encodeChannel(enc: number, x: number): number {
  switch (enc) {
    case ENC_SLOG3:
      return slog3(x);
    case ENC_CLOG3:
      return clog3(x);
    case ENC_BMDFILM5:
      return bmdfilm5(x);
    case ENC_DI:
      return davinciIntermediateEncode(x);
    default:
      return x;
  }
}

/** Guess a look's input from its file name or TITLE. Twin of camlog.rs detect. */
export function detectLookInput(name: string): string {
  const n = name.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (n.includes("slog3")) return n.includes("cine") ? "slog3-sgamut3cine" : "slog3-sgamut3";
  if (n.includes("clog3") || n.includes("canonlog3")) return "clog3-cinema";
  if (n.includes("bmdfilm") || n.includes("blackmagicfilm") || n.includes("gen5") || n.includes("bmdwg")) return "bmdfilm5-bmdwg5";
  if (n.includes("davinciintermediate") || n.includes("dwg") || n.includes("davinciwide")) return "di-dwg";
  return "display";
}

/** GLSL for the develop shader: the same encodings, selected by uLookLog. */
export const ENCODE_LOG_GLSL = `
float log10f(float x) { return log(x) / log(10.0); }
float slog3(float x) {
  return x >= 0.01125 ? (420.0 + log10f((x + 0.01) / 0.19) * 261.5) / 1023.0
                      : (x * (171.21029 - 95.0) / 0.01125 + 95.0) / 1023.0;
}
float clog3(float x) {
  float v = x / 0.9;
  if (v < -0.014) return -0.36726845 * log10f(-v * 14.98325 + 1.0) + 0.12783901;
  if (v <= 0.014) return 1.9754798 * v + 0.12512219;
  return 0.36726845 * log10f(v * 14.98325 + 1.0) + 0.12240537;
}
float bmdfilm5(float x) {
  return x < 0.005 ? 8.283606 * x + 0.09246575 : 0.08692876 * log(x + 0.005494072) + 0.5300133;
}
float dIntermediate(float x) {
  return x <= 0.00262409 ? x * 10.44426855 : (log2(x + 0.0075) + 7.0) * 0.07329248;
}
float encodeLogChannel(int enc, float x) {
  if (enc == 1) return slog3(x);
  if (enc == 2) return clog3(x);
  if (enc == 3) return bmdfilm5(x);
  if (enc == 4) return dIntermediate(x);
  return x;
}
vec3 encodeLog(int enc, vec3 c) {
  return vec3(encodeLogChannel(enc, c.r), encodeLogChannel(enc, c.g), encodeLogChannel(enc, c.b));
}
`;
