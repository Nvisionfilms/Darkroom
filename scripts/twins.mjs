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
    what: "sharpening reach",
    rust: read("src-tauri/src/pipeline.rs"),
    glsl: read("src/gl/Renderer.ts"),
    pairs: [
      ["SHARPEN_REF: f32 = 2048.0", "SHARPEN_REF = 2048"],
      [".max(1.0)", "Math.max(1,"],
    ],
  },
  {
    what: "auto vibrance",
    rust: read("src-tauri/src/tonematch.rs"),
    glsl: read("src/App.tsx"),
    pairs: [["AUTO_VIBRANCE: f32 = 18.0", "AUTO_VIBRANCE = 18;"]],
  },
  {
    what: "noise by tone",
    rust: read("src-tauri/src/denoise.rs"),
    glsl: read("src/gl/shaders.ts"),
    pairs: [
      ["SHADOW_FLOOR: f32 = 0.05", "max(cp[(uPr * 2 + 1) * (uPr * 2 + 1) / 2].a, 0.05)"],
      ["SHADOW_MAX: f32 = 9.0", "uShadowK / pow(max(cp[(uPr * 2 + 1) * (uPr * 2 + 1) / 2].a, 0.05), 2.0), 9.0)"],
    ],
  },
  {
    what: "vignette",
    rust: read("src-tauri/src/vignette.rs"),
    glsl: read("src/gl/shaders.ts"),
    pairs: [
      ["t * t * (3.0 - 2.0 * t)", "t * t * (3.0 - 2.0 * t)"],
      ["std::f32::consts::SQRT_2", "1.41421356"],
      ["rgb[c] * (1.0 + f)", "c * (1.0 + f)"],
      ["rgb[c] + (1.0 - rgb[c]) * f", "c + (1.0 - c) * f"],
    ],
  },
  {
    what: "vignette sliders",
    rust: read("src-tauri/src/vignette.rs"),
    glsl: read("src/gl/Renderer.ts"),
    pairs: [
      ["FEATHER_MIN: f32 = 0.04", "VIG_FEATHER_MIN = 0.04"],
      ["FEATHER_MAX: f32 = 0.60", "VIG_FEATHER_MAX = 0.6"],
    ],
  },
  {
    what: "HSL bands",
    rust: read("src-tauri/src/pipeline.rs"),
    glsl: read("src/gl/shaders.ts"),
    pairs: [
      ["if d > 180.0 { d - 360.0 } else { d }", "d > 180.0 ? d - 360.0 : d"],
      ["(1.0 - d / gap.max(1e-3)).max(0.0)", "max(1.0 - d / max(gap, 1e-3), 0.0)"],
      ["(1.0 + d / gap.max(1e-3)).max(0.0)", "max(1.0 + d / max(gap, 1e-3), 0.0)"],
      ["dh * (30.0 / 360.0) * sv", "dh * (30.0 / 360.0) * sv"],
    ],
  },
  {
    what: "retouch blending",
    rust: read("src-tauri/src/heal.rs"),
    glsl: read("src/heal.ts"),
    pairs: [
      ["const RING: usize = 96", "const RING = 96"],
      ["[0.0f32, 0.04, 0.08]", "[0.0, 0.04, 0.08]"],
      ["let steps = 96", "const steps = 96"],
      ["(px - dx) / r", "(px - dx) / r"],
    ],
  },
  {
    what: "painted repair path",
    rust: read("src-tauri/src/heal.rs"),
    glsl: read("src/heal.ts"),
    pairs: [
      ["MAX_PATH: usize = 8", "MAX_PATH = 8"],
      ["clamp(0.0, 1.0)", "Math.max(0, Math.min(1,"],
    ],
  },
  {
    what: "painted repair path in the shader",
    rust: read("src-tauri/src/heal.rs"),
    glsl: read("src/gl/shaders.ts"),
    pairs: [
      ["MAX_PATH: usize = 8", "MAX_PATH = 8"],
      ["if len2 > 1e-9", "len2 > 1e-9"],
    ],
  },
  {
    what: "retouch blending in the shader",
    rust: read("src-tauri/src/heal.rs"),
    glsl: read("src/gl/shaders.ts"),
    pairs: [["p[0][0] + p[1][0] * u + p[2][0] * v", "uSpotPlane[i * 3] + uSpotPlane[i * 3 + 1] * uv2.x + uSpotPlane[i * 3 + 2] * uv2.y"]],
  },
  {
    what: "noise reduction",
    rust: read("src-tauri/src/denoise.rs"),
    glsl: read("src/gl/Renderer.ts"),
    pairs: [
      ["RESPONSE: f32 = 2.0", "RESPONSE = 2.0"],
      ["0.4 + 4.0 * amount.powf(RESPONSE)", "0.4 + 4.0 * a ** RESPONSE"],
      ["0.4 + 5.2 * amount.powf(RESPONSE)", "0.4 + 5.2 * a ** RESPONSE"],
    ],
  },
  {
    what: "noise reduction detail threshold",
    rust: read("src-tauri/src/denoise.rs"),
    glsl: read("src/gl/shaders.ts"),
    pairs: [
      ["DETAIL_FLOOR: f32 = 1.0", "- 1.0) / (2.5 - 1.0)"],
      ["DETAIL_EDGE: f32 = 2.5", "(2.5 - 1.0)"],
      ["t * t * (3.0 - 2.0 * t)", "tt * tt * (3.0 - 2.0 * tt)"],
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
    what: "motion trails",
    rust: read("src-tauri/src/export.rs"),
    glsl: read("src/trail.ts"),
    pairs: [
      ["MAX_TRAIL_COPIES: usize = 24", "MAX_TRAIL_COPIES = 24"],
      ["TRAIL_MASK_FEATHER: f32 = 0.06", "TRAIL_MASK_FEATHER = 0.06"],
      ["0.2 + fade * 0.78", "0.2 + clamp(feather / 100, 0, 1) * 0.78"],
      ["* 0.72", "* 0.72"],
      ["clamp(0.0, 0.7)", "clamp(length, 0, 0.7)"],
      ["(long * 0.006).clamp(2.0, 32.0)", "clamp(imgLong * 0.006, 2, 32)"],
      ["fade_retention.powi(i as i32 - 1)", "fadeRetention ** (i - 1)"],
    ],
  },
  {
    what: "motion trail echo blur",
    rust: read("src-tauri/src/export.rs"),
    glsl: read("src/components/Viewer.tsx"),
    pairs: [["0.35 + t * 0.65", "0.35 + t * 0.65"]],
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

// ---------------------------------------------------------------------------
// The picture profiles are a table that lives twice: profiles.rs for the export
// and profiles.ts for the screen. They were once strengthened in the Rust file
// alone, which changed every exported file and left the preview exactly as it
// was - so the profiles looked as though they did nothing, because on screen
// they did not. Pairs of constants are not enough to catch that, so this reads
// both tables and compares every number of every profile.
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const numbersIn = (block) => {
  const out = {};
  for (const m of block.matchAll(/\b([a-z_A-Z]+):\s*\[([^\]]*)\]/g)) {
    out[camel(m[1])] = m[2].split(",").map((v) => parseFloat(v)).filter((v) => !Number.isNaN(v)).join(",");
  }
  for (const m of block.matchAll(/\b([a-z_A-Z]+):\s*(-?\d+(?:\.\d+)?)(?:f32)?\b/g)) {
    if (!(camel(m[1]) in out)) out[camel(m[1])] = String(parseFloat(m[2]));
  }
  if (/\bmono:\s*true/.test(block)) out.mono = "true";
  return out;
};
const FIELDS = ["contrast", "saturation", "vibrance", "temperature", "bandSat", "bandLum", "bandHue", "mono"];
const profilesRust = (() => {
  const src = read("src-tauri/src/profiles.rs");
  const out = {};
  for (const m of src.matchAll(/((?:"[a-z-]+"\s*\|?\s*)+)=>\s*ProfileLook\s*\{([\s\S]*?)\n\s{8}\},/g)) {
    const ids = [...m[1].matchAll(/"([a-z-]+)"/g)].map((x) => x[1]);
    for (const id of ids) out[id] = numbersIn(m[2]);
  }
  return out;
})();
const profilesTs = (() => {
  const src = read("src/profiles.ts");
  const body = src.slice(src.indexOf("export function look"));
  const out = {};
  const cases = [...body.matchAll(/((?:case "[a-z-]+":\s*)+)return\s*\{([\s\S]*?)\};/g)];
  for (const m of cases) {
    const ids = [...m[1].matchAll(/case "([a-z-]+)"/g)].map((x) => x[1]);
    for (const id of ids) out[id] = numbersIn(m[2]);
  }
  return out;
})();
let profileBad = 0;
const ids = new Set([...Object.keys(profilesRust), ...Object.keys(profilesTs)]);
if (ids.size < 7) {
  console.error(`profiles: only found ${ids.size} profiles to compare - the table was moved or reformatted`);
  profileBad++;
}
for (const id of ids) {
  const a = profilesRust[id];
  const b = profilesTs[id];
  if (!a || !b) {
    console.error(`profiles: ${id} is in the ${a ? "export (Rust)" : "preview (TypeScript)"} table only`);
    profileBad++;
    continue;
  }
  for (const f of FIELDS) {
    const x = a[f] ?? (f.startsWith("band") ? "0,0,0,0,0,0,0,0" : f === "mono" ? "false" : "0");
    const y = b[f] ?? (f.startsWith("band") ? "0,0,0,0,0,0,0,0" : f === "mono" ? "false" : "0");
    if (x !== y) {
      console.error(`profiles: ${id}.${f} is ${x} in the export but ${y} on screen`);
      profileBad++;
    }
  }
}

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
if (bad === 0) console.log(`twin constants agree (${groups.reduce((n, g) => n + g.pairs.length, 0)} checked, ${ids.size} profiles compared)`);
bad += profileBad;
process.exit(bad === 0 ? 0 : 1);
