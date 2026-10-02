// The CPU pipeline (src-tauri/src) and the GPU pipeline (src/gl/shaders.ts) are
// twins: the export is rendered by the first, the screen by the second, and
// the app's whole promise is that they agree. Most of that agreement can only
// be checked by rendering, but the constants can be checked by reading, which
// is free and catches the mistake that is easiest to make and hardest to see -
// a number changed in one file and not the other.
//
// Each entry is a number that must appear in both, written the way each
// language spells it.

import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => readFileSync(root + p, "utf8");

const groups = [
  {
    what: "film grain",
    rust: read("src-tauri/src/grain.rs"),
    glsl: read("src/gl/shaders.ts"),
    pairs: [
      ["0x7feb_352d", "0x7feb352du"],
      ["0x846c_a68b", "0x846ca68bu"],
      ["0x9e37_79b9", "0x9e3779b9u"],
      ["16_777_216.0", "16777216.0"],
      ["+ 8192", "+ 8192"],
      ["REFERENCE: f32 = 3000.0", "GRAIN_REF = 3000.0"],
      ["* 7.0", "* 7.0"], // size -> cell width
      ["2.17", "2.17"], // second octave
      ["0.65", "0.65"], // octave weights
      ["0.35", "0.35"],
      ["* 0.28", "* 0.28"], // amount -> gain
      ["0.85 + 0.15", "0.85 + 0.15"], // midtone weighting
      ["11 + channel * 101", "11u + channel * 101u"],
      ["977 + channel * 101", "977u + channel * 101u"],
    ],
  },
  {
    what: "cross-screen filter",
    rust: read("src-tauri/src/star.rs"),
    glsl: read("src/gl/shaders.ts"),
    pairs: [
      ["SAMPLES: usize = 24", "STAR_SAMPLES = 24"],
      ["let k = t * t;", "float k = t * t;"],
      ["(1.0 - t).max(1e-6).powf(exp)", "pow(max(1.0 - t, 1e-6), uFade)"],
      ["1.0 + disp", "1.0 + uDisp"],
      ["1.0 - disp", "1.0 - uDisp"],
      ["wsum += 2.0 * w", "wsum += 2.0 * w"],
      ["1e-3", "1e-3"],
      ["1e-4", "1e-4"],
    ],
  },
  {
    what: "cross-screen filter sliders",
    rust: read("src-tauri/src/star.rs"),
    glsl: read("src/star.ts"),
    pairs: [
      ["MAX_LENGTH: f32 = 0.25", "STAR_MAX_LENGTH = 0.25"],
      ["MAX_GAIN: f32 = 8.0", "STAR_MAX_GAIN = 8.0"],
      ["MAX_DISPERSION: f32 = 0.08", "STAR_MAX_DISPERSION = 0.08"],
      ["SAMPLES: usize = 24", "STAR_SAMPLES = 24"],
      ["0.5 + (self.falloff / 100.0).clamp(0.0, 1.0) * 3.5", "0.5 + clamp01(falloff / 100) * 3.5"],
      ["clamp(0.0, 0.999)", "Math.min(0.999"],
      ["clamp(2, 12)", "Math.min(12"],
    ],
  },
];

let bad = 0;
for (const g of groups) {
  for (const [rust, glsl] of g.pairs) {
    const inRust = g.rust.includes(rust);
    const inGlsl = g.glsl.includes(glsl);
    if (inRust && inGlsl) continue;
    bad++;
    const missing = !inRust ? `the Rust side is missing ${JSON.stringify(rust)}` : `the preview side is missing ${JSON.stringify(glsl)}`;
    console.error(`${g.what}: ${missing} - the two pipelines would not match`);
  }
}
if (bad === 0) console.log(`twin constants agree (${groups.reduce((n, g) => n + g.pairs.length, 0)} checked)`);
process.exit(bad === 0 ? 0 : 1);
