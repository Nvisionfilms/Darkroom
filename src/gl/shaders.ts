// GPU twin of src-tauri/src/pipeline.rs, denoise.rs, detail.rs and mask.rs.
// Keep the math identical to the Rust code.

import { ENCODE_LOG_GLSL } from "../camlog";

export const VERTEX = `#version 300 es
in vec2 aPos;
uniform mat3 uTransform;
uniform mat3 uUvMat;   // unit quad -> texture coords (identity except for crop/straighten)
out vec2 vUv;
void main() {
  vUv = (uUvMat * vec3(aPos, 1.0)).xy;
  vec3 p = uTransform * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

export const IDENTITY3: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const COMMON = `
const vec3 LUMA_PROXY = vec3(0.2627, 0.6780, 0.0593);
const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722);
float lumaProxy(vec3 c) { return dot(c, LUMA_PROXY); }
`;

/** Maximum object-remover spots evaluated in one pass. */
export const MAX_HEAL = 16;

/** Points a retouch spot's shape is swept along. Twin of MAX_PATH in heal.rs. */
export const MAX_PATH = 8;

/**
 * Object remover: copy feathered patches from elsewhere in the same photo.
 * Twin of src-tauri/src/heal.rs. Every spot reads the untouched source, and
 * the per-spot colour offset is computed on the CPU with the same formula.
 */
export const HEAL_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uSize;
uniform int uNumSpots;
uniform vec4 uSpotPos[${MAX_HEAL}];   // dest x, dest y, source x, source y (px)
uniform vec4 uSpotShape[${MAX_HEAL}]; // radius px, hardness, opacity, unused
// three vec3 per spot: [c0, cu, cv] per channel, a plane over the patch
uniform vec3 uSpotPlane[${MAX_HEAL * 3}];
// the painted path, MAX_PATH points per spot; one point is a plain disc
uniform vec2 uSpotPath[${MAX_HEAL * MAX_PATH}];
uniform int uSpotPathN[${MAX_HEAL}];
float healDist(int i, vec2 p, vec2 centre) {
  // Distance to the swept path, or to the point it collapses to.
  // Twin of dist_to_path in heal.rs.
  int n = uSpotPathN[i];
  if (n <= 1) return length(p - centre);
  float best = 1e20;
  for (int k = 0; k < ${MAX_PATH - 1}; k++) {
    if (k >= n - 1) break;
    vec2 a = uSpotPath[i * ${MAX_PATH} + k];
    vec2 b = uSpotPath[i * ${MAX_PATH} + k + 1];
    vec2 e = b - a;
    float len2 = dot(e, e);
    float t = len2 > 1e-9 ? clamp(dot(p - a, e) / len2, 0.0, 1.0) : 0.0;
    best = min(best, length(p - (a + e * t)));
  }
  return best;
}
float smooth01(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
void main() {
  vec2 p = vUv * uSize;
  vec3 c = texture(uSrc, vUv).rgb;
  for (int i = 0; i < ${MAX_HEAL}; i++) {
    if (i >= uNumSpots) break;
    vec4 pos = uSpotPos[i];
    vec4 sh = uSpotShape[i];
    float d = healDist(i, p, pos.xy) / sh.x;
    if (d >= 1.0) continue;
    float soft = max(1.0 - sh.y, 0.01);
    float a = sh.z * (1.0 - smooth01((d - sh.y) / soft));
    if (a <= 0.0) continue;
    // twin of plane_at in heal.rs: the correction follows the gradient the
    // patch is landing in, instead of matching only its average
    vec2 uv2 = (p - pos.xy) / max(sh.x, 1e-4);
    vec3 fix = uSpotPlane[i * 3] + uSpotPlane[i * 3 + 1] * uv2.x + uSpotPlane[i * 3 + 2] * uv2.y;
    vec3 s = max(texture(uSrc, (pos.zw + (p - pos.xy)) / uSize).rgb + fix, 0.0);
    c = mix(c, s, a);
  }
  outColor = vec4(c, 1.0);
}`;

/** Source linear -> sqrt-domain (r, g, b, luma) for noise distances. */
export const PREP_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage;
${COMMON}
void main() {
  vec3 c = max(texture(uImage, vUv).rgb, 0.0);
  outColor = vec4(sqrt(c), sqrt(max(lumaProxy(c), 0.0)));
}`;

export const COPY_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
void main() { outColor = vec4(texture(uSrc, vUv).rgb, 1.0); }`;

/** Non-local means, 7x7 search / 3x3 patch, luma and chroma weighted separately. */
export const DENOISE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage; // linear DWG
uniform sampler2D uP;     // sqrt domain rgb + luma
uniform vec2 uTexel;
uniform float uSigma;
uniform float uHl2;
uniform float uHc2;
uniform int uUseL;
uniform int uUseC;
uniform float uDetail;
// Loop bounds are uniforms (always 3 and 1) on purpose: with constant bounds
// the Direct3D compiler behind ANGLE unrolls all 441 taps and takes ~5 s to
// compile the shader, freezing the UI on first use.
uniform int uR;
uniform int uPr;
${COMMON}
void main() {
  vec4 cp[9];
  int k = 0;
  for (int py = -uPr; py <= uPr; py++)
    for (int px = -uPr; px <= uPr; px++)
      cp[k++] = texture(uP, vUv + vec2(px, py) * uTexel);
  vec3 orig = texture(uImage, vUv).rgb;
  float noise2 = 2.0 * uSigma * uSigma;
  float wl = 0.0, wc = 0.0;
  vec3 accL = vec3(0.0), accC = vec3(0.0);
  for (int oy = -uR; oy <= uR; oy++) {
    for (int ox = -uR; ox <= uR; ox++) {
      vec2 o = vec2(ox, oy) * uTexel;
      float dl = 0.0, dc = 0.0;
      int j = 0;
      for (int py = -uPr; py <= uPr; py++) {
        for (int px = -uPr; px <= uPr; px++) {
          vec4 q = texture(uP, vUv + o + vec2(px, py) * uTexel);
          vec4 d = cp[j++] - q;
          dl += d.a * d.a;
          dc += dot(d.rgb, d.rgb);
        }
      }
      vec3 s = texture(uImage, vUv + o).rgb;
      if (uUseL == 1) {
        float w = exp(-max(dl / 9.0 - noise2, 0.0) / uHl2);
        wl += w; accL += w * s;
      }
      if (uUseC == 1) {
        float w = exp(-max(dc / 27.0 - noise2, 0.0) / uHc2);
        wc += w; accC += w * s;
      }
    }
  }
  vec3 rgbL = uUseL == 1 ? accL / max(wl, 1e-12) : orig;
  vec3 rgbC = uUseC == 1 ? accC / max(wc, 1e-12) : orig;
  // combine(): luma from rgbL, chroma from rgbC, soft-threshold detail restore
  float yl = max(lumaProxy(rgbL), 0.0);
  float yc = max(lumaProxy(rgbC), 1e-6);
  float yo = max(lumaProxy(orig), 0.0);
  float rs = sqrt(yo) - sqrt(yl);
  // Twin of denoise.rs soft_threshold: nothing at the noise floor comes back,
  // anything well clear of it comes back whole. A straight ramp scored a
  // noise-sized residual half marks, which restored a quarter of the noise.
  float tt = clamp((abs(rs) / max(uSigma, 1e-6) - 1.0) / (2.5 - 1.0), 0.0, 1.0);
  float kk = uDetail * tt * tt * (3.0 - 2.0 * tt);
  float yf = max(yl + kk * (yo - yl), 0.0);
  outColor = vec4(rgbC * (yf / yc), 1.0);
}`;

/** 2x2 box downsample of an RGB image (half-res denoise scale). */
export const DOWN2_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel; // source texel
void main() {
  vec3 acc = vec3(0.0);
  acc += texture(uSrc, vUv + vec2(-0.5, -0.5) * uTexel).rgb;
  acc += texture(uSrc, vUv + vec2( 0.5, -0.5) * uTexel).rgb;
  acc += texture(uSrc, vUv + vec2(-0.5,  0.5) * uTexel).rgb;
  acc += texture(uSrc, vUv + vec2( 0.5,  0.5) * uTexel).rgb;
  outColor = vec4(acc * 0.25, 1.0);
}`;

/** out = d1 + up(d2) - up(down(d1)): swap in the half-res denoised low frequencies. */
export const COMBINE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uD1;
uniform sampler2D uD2;   // half res, LINEAR
uniform sampler2D uD1s;  // half res, LINEAR
void main() {
  vec3 c = texture(uD1, vUv).rgb + texture(uD2, vUv).rgb - texture(uD1s, vUv).rgb;
  outColor = vec4(max(c, 0.0), 1.0);
}`;

export const LOGLUMA_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
${COMMON}
void main() {
  outColor = vec4(log2(max(lumaProxy(texture(uSrc, vUv).rgb), 1e-5)), 0.0, 0.0, 1.0);
}`;

/** Dark channel min(r, g, b) clamped to 0..1: the haze veil input. Twin of detail.rs dark_channel. */
export const DARK_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  outColor = vec4(clamp(min(c.r, min(c.g, c.b)), 0.0, 1.0), 0.0, 0.0, 1.0);
}`;

/** Separable Gaussian, one direction per pass. */
export const BLUR_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uStep;   // texel * direction
uniform float uSigma;
uniform int uRadius;
void main() {
  float acc = 0.0, wsum = 0.0;
  for (int i = -uRadius; i <= uRadius; i++) {
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    acc += w * texture(uSrc, vUv + float(i) * uStep).r;
    wsum += w;
  }
  outColor = vec4(acc / wsum, 0.0, 0.0, 1.0);
}`;

/** 4x4 box downsample of a single-channel map. */
export const DOWNSAMPLE_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel; // source texel
void main() {
  float acc = 0.0;
  for (int dy = 0; dy < 4; dy++)
    for (int dx = 0; dx < 4; dx++)
      acc += texture(uSrc, vUv + (vec2(dx, dy) - 1.5) * uTexel).r;
  outColor = vec4(acc / 16.0, 0.0, 0.0, 1.0);
}`;

/** Maximum number of masks the develop shader evaluates per pixel. */
export const MAX_MASKS = 8;
/** Floats per mask in uMaskAdj (same order as pipeline.rs Tone::add). */
export const MASK_ADJ_STRIDE = 12;

/** Mask kinds as the shader sees them (see mask.ts maskKindCode). */
/** uMaskMode values: an ordinary mask, or one that cuts out of the mask above. */
export const MASK_MODE_ADD = 0;
export const MASK_MODE_SUBTRACT = 1;

export const MASK_KIND_RASTER = 0;
export const MASK_KIND_LUMINANCE = 1;
export const MASK_KIND_LINEAR = 2;
export const MASK_KIND_RADIAL = 3;

export const DEVELOP_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
precision highp sampler2DArray;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uImage;   // denoised linear DWG
uniform sampler2D uLut;     // R32F 256x4: master, r, g, b
uniform sampler2D uLg;      // log2 luma
uniform sampler2D uB1;      // blur sigma ~1
uniform sampler2D uB2;      // blur sigma ~4
uniform sampler2D uB3;      // blur sigma ~2% long edge (quarter res)
uniform sampler2D uDark;    // blurred dark channel (quarter res), haze veil
uniform sampler2D uLumaG;   // globally developed picture (for luminance masks)
uniform sampler2DArray uMasks; // brush and subject mask rasters, one layer each
uniform sampler3D uLook;    // creative look-up table (.cube)
uniform int uUseMaps;
uniform vec2 uSize;         // image size in px
// global tone
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTemp;
uniform float uTint;
uniform float uSaturation;
uniform float uTexture;
uniform float uClarity;
uniform float uDehaze;
// global only
uniform float uVibrance;
uniform float uBaseContrast;
uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];
uniform vec3 uTintS;
uniform vec3 uTintM;
uniform vec3 uTintH;
uniform float uBalance;
uniform int uGradingOn;
// picture profile: monochrome
uniform int uMono;
uniform vec3 uMonoMix;
// creative look
uniform int uLookOn;
uniform float uLookAmount;
uniform float uLookSize;
uniform vec3 uLookMin;
uniform vec3 uLookMax;
uniform int uLookLog;       // 0 display-referred, else a camera log encoding
uniform mat3 uLookMat;      // linear DWG -> camera gamut
// double exposure, twin of blend.rs
uniform sampler2D uBlend;   // the second picture, linear DWG
uniform int uBlendOn;
uniform int uBlendMode;     // blend::MODE_*, 0 = expose (scene-referred)
uniform float uBlendAlpha;  // opacity, 0..1
uniform float uBlendEv;
uniform int uBlendInvert;
uniform int uBlendFlip;
uniform vec2 uBlendC;       // centre of the overlay, in frame pixels
uniform vec2 uBlendDen;     // size of the overlay, in frame pixels
uniform vec2 uBlendRot;     // cos, sin of its rotation
// film grain, twin of grain.rs
uniform float uGrainAmount;
uniform float uGrainSize;
uniform float uGrainColour;
// lens vignetting correction (scene-referred gain), twin of geometry.rs
uniform int uVigOn;
uniform vec3 uVigK;
uniform float uVigAmount;
uniform float uMv;
uniform float uMvStart;
uniform float uRmax;
uniform float uHs;
uniform float uCs;
// masks
uniform int uNumMasks;
uniform int uUseLumaG;
uniform int uShowMask;        // index of the mask to paint red, or -1
uniform int uMaskKind[8];     // 0 raster, 1 luminance, 2 linear, 3 radial
uniform int uMaskMode[8];     // 0 add, 1 subtract (cuts out of the mask above)
uniform int uMaskInvert[8];
uniform float uMaskAmount[8]; // 0..1
uniform vec4 uMaskP0[8];      // linear: ax ay dx dy (px); radial: cx cy rx ry (px); lum: lo hi feather; raster: slot
uniform vec4 uMaskP1[8];      // radial: cos sin feather
uniform float uMaskAdj[96];   // 12 per mask: exposure contrast highlights shadows whites blacks temp tint sat texture clarity dehaze

${COMMON}
const float CENTERS[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 275.0, 310.0);
const float LOG_MID = -2.473931188;
// DaVinci Wide Gamut -> linear sRGB (column-major for GLSL)
const mat3 DWG_TO_SRGB = mat3(
  1.898614899, -0.168948786, -0.121539161,
 -0.792176183,  1.488975754, -0.315675853,
 -0.106438716, -0.320026968,  1.437215014);
// linear sRGB -> DaVinci Wide Gamut (column-major for GLSL)
const mat3 SRGB_TO_DWG = mat3(
  0.562767456, 0.077754635, 0.064669200,
  0.323516589, 0.749577346, 0.191998692,
  0.113715955, 0.172668019, 0.743332108);

struct Tone {
  float exposure, contrast, highlights, shadows, whites, blacks, temp, tint, saturation, texture, clarity, dehaze;
};

float srgbEnc(float x) {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
float srgbDec(float x) {
  return x <= 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4);
}
float smooth01(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
float shoulder(float x) {
  const float K = 0.8;
  return x <= K ? x : K + (1.0 - K) * (1.0 - exp(-(x - K) / (1.0 - K)));
}
float softclip(float x) { return 1.5 * tanh(x / 1.5); }
float toneLog(float l, Tone t) {
  float ws = smooth01(-l / 5.0);
  float wh = smooth01(l / 3.0);
  float wb = smooth01((-l - 0.5) / 3.5);
  float ww = smooth01((l - 1.0) / 3.0);
  l += t.shadows * 1.5 * ws;
  l += t.highlights * 1.5 * wh;
  l += t.blacks * 1.5 * wb;
  l += t.whites * 1.5 * ww;
  l *= 1.0 + t.contrast * 0.6;
  return l;
}
// Twin of pipeline.rs dehaze()
vec3 dehaze(vec3 c, float veil, float k) {
  if (k > 0.0) {
    float t = max(1.0 - 0.85 * k * clamp(veil, 0.0, 1.0), 0.2);
    return max((c - (1.0 - t)) / t, 0.0);
  }
  float t = 1.0 + 0.5 * k;
  return c * t + 0.6 * (1.0 - t);
}
float baseCurve(float x, float k) {
  return clamp(x + k * 0.5 * x * (1.0 - x) * (x - 0.5) * 4.0, 0.0, 1.0);
}
float lut(int row, float x) {
  float p = clamp(x, 0.0, 1.0) * 255.0;
  int i = int(floor(p));
  float f = p - float(i);
  float a = texelFetch(uLut, ivec2(i, row), 0).r;
  float b = texelFetch(uLut, ivec2(min(i + 1, 255), row), 0).r;
  return mix(a, b, f);
}
vec3 gamutCompress(vec3 s) {
  float y = max(dot(s, LUMA_709), 1e-6);
  float m = min(s.r, min(s.g, s.b));
  float d = (y - m) / y;
  const float T = 0.75;
  if (d <= T) return s;
  float d2 = T + (1.0 - T) * (1.0 - exp(-(d - T) / (1.0 - T)));
  return y + (s - y) * (d2 / d);
}
vec3 rgb2hsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float s = mx > 1e-6 ? d / mx : 0.0;
  float h = 0.0;
  if (d >= 1e-6) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0) / 6.0;
    else if (mx == c.g) h = ((c.b - c.r) / d + 2.0) / 6.0;
    else h = ((c.r - c.g) / d + 4.0) / 6.0;
  }
  return vec3(h, s, mx);
}
vec3 hsv2rgb(vec3 h) {
  float hh = mod(h.x, 1.0) * 6.0;
  float i = floor(hh);
  float f = hh - i;
  float v = h.z;
  float p = v * (1.0 - h.y);
  float q = v * (1.0 - h.y * f);
  float t = v * (1.0 - h.y * (1.0 - f));
  int ii = int(i);
  if (ii == 0) return vec3(v, t, p);
  if (ii == 1) return vec3(q, v, p);
  if (ii == 2) return vec3(p, v, t);
  if (ii == 3) return vec3(p, q, v);
  if (ii == 4) return vec3(t, p, v);
  return vec3(v, p, q);
}

// Twin of geometry.rs Warp::vignette_gain
float vignetteGain(vec2 p) {
  vec2 d = (p - uSize * 0.5) / uHs;
  float r2 = dot(d, d);
  float g = 1.0;
  if (uVigK != vec3(0.0)) {
    float rc2 = r2 * uCs * uCs;
    float f = 1.0 + uVigK.x * rc2 + uVigK.y * rc2 * rc2 + uVigK.z * rc2 * rc2 * rc2;
    g *= 1.0 + uVigAmount * (1.0 / clamp(f, 0.05, 20.0) - 1.0);
  }
  if (uMv != 0.0) {
    g *= 1.0 + uMv * smooth01((sqrt(r2) - uMvStart) / max(uRmax - uMvStart, 1e-3));
  }
  return max(g, 0.0);
}

// Step 5 on its own: linear DWG light to a gamma-encoded sRGB picture.
// Twin of pipeline.rs display_encode(); the second picture of a double
// exposure goes through the same transform, so the two meet in one space.
vec3 displayEncode(vec3 c) {
  vec3 s = max(gamutCompress(DWG_TO_SRGB * c), 0.0);
  s = clamp(vec3(shoulder(s.r), shoulder(s.g), shoulder(s.b)), 0.0, 1.0);
  return vec3(srgbEnc(s.r), srgbEnc(s.g), srgbEnc(s.b));
}

// ---- double exposure, twin of blend.rs ----

// Negative of a linear colour, taken in a display encoding so it looks like a
// photographic negative rather than a near-black frame.
vec3 invertLinear(vec3 c) {
  vec3 s = clamp(DWG_TO_SRGB * c, 0.0, 1.0);
  vec3 d = vec3(1.0) - vec3(srgbEnc(s.r), srgbEnc(s.g), srgbEnc(s.b));
  return SRGB_TO_DWG * vec3(srgbDec(d.r), srgbDec(d.g), srgbDec(d.b));
}

// The second picture under this pixel: linear DWG light in rgb, the alpha it
// contributes in a. Twin of blend::Source::sample.
vec4 blendSample() {
  const float EDGE = 0.002;
  vec2 d = vUv * uSize - uBlendC;
  float u = ( d.x * uBlendRot.x + d.y * uBlendRot.y) / uBlendDen.x + 0.5;
  float v = (-d.x * uBlendRot.y + d.y * uBlendRot.x) / uBlendDen.y + 0.5;
  if (uBlendFlip == 1) u = 1.0 - u;
  float cov = smooth01(min(min(u, 1.0 - u), min(v, 1.0 - v)) / EDGE);
  if (cov <= 0.0) return vec4(0.0);
  vec3 c = texture(uBlend, vec2(u, v)).rgb * exp2(uBlendEv);
  if (uBlendInvert == 1) c = invertLinear(c);
  return vec4(c, cov * uBlendAlpha);
}

// W3C compositing soft light, the same curve Photoshop uses.
float softLight(float b, float o) {
  if (o <= 0.5) return b - (1.0 - 2.0 * o) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(max(b, 0.0));
  return b + (2.0 * o - 1.0) * (d - b);
}

// The display-referred layer blends. Twin of blend::mix_display.
vec3 blendMode(vec3 b, vec3 o, int mode, float a) {
  vec3 m;
  if (mode == 2) m = 1.0 - (1.0 - b) * (1.0 - o);
  else if (mode == 3) m = b * o;
  else if (mode == 4) m = mix(2.0 * b * o, 1.0 - 2.0 * (1.0 - b) * (1.0 - o), step(0.5, b));
  else if (mode == 5) m = vec3(softLight(b.r, o.r), softLight(b.g, o.g), softLight(b.b, o.b));
  else if (mode == 6) m = max(b, o);
  else if (mode == 7) m = min(b, o);
  else if (mode == 8) m = abs(b - o);
  else m = o;
  return clamp(mix(b, m, a), 0.0, 1.0);
}

${ENCODE_LOG_GLSL}

// Trilinear .cube sampling. Twin of Lut3d::sample in lut3d.rs: the half-texel
// scale and offset make the lattice endpoints land exactly on 0 and 1.
vec3 sampleLook(vec3 c) {
  vec3 t = clamp((c - uLookMin) / max(uLookMax - uLookMin, vec3(1e-6)), 0.0, 1.0);
  vec3 uvw = t * ((uLookSize - 1.0) / uLookSize) + 0.5 / uLookSize;
  return clamp(texture(uLook, uvw).rgb, 0.0, 1.0);
}

vec3 developPixel(vec3 rgb, Tone t) {
  if (uVigOn == 1) rgb *= vignetteGain(vUv * uSize);
  // 1. white balance
  vec3 c = rgb * vec3(1.0 + 0.4 * t.temp, 1.0 - 0.25 * t.tint, 1.0 - 0.4 * t.temp);
  // 2. exposure
  float ev = exp2(t.exposure);
  c = max(c * ev, 0.0);
  // 2a. double exposure, the scene-referred way: the second picture is added
  // as light before the tone mapping, so where the two overlap the highlights
  // roll off together exactly as they would in camera
  vec4 bl = uBlendOn == 1 ? blendSample() : vec4(0.0);
  if (uBlendMode == 0) c += bl.rgb * bl.a;
  if (uUseMaps == 1) {
    // 2b. dehaze
    if (t.dehaze != 0.0) c = dehaze(c, texture(uDark, vUv).r * ev, t.dehaze);
    // 3. local contrast
    if (t.texture != 0.0 || t.clarity != 0.0) {
      float lg = texture(uLg, vUv).r;
      float b1 = texture(uB1, vUv).r;
      float b2 = texture(uB2, vUv).r;
      float b3 = texture(uB3, vUv).r;
      float dist = abs(lg + t.exposure - LOG_MID);
      float wmid = 1.0 - smooth01((dist - 1.5) / 3.0);
      float dt = t.texture * 1.5 * (b1 - b2);
      float dc = t.clarity * 1.2 * wmid * softclip(b1 - b3);
      c *= exp2(dt + dc);
    }
  }
  // 4. tone in log-luminance
  float y = max(lumaProxy(c), 1e-6);
  float l = log2(y / 0.18);
  float y2 = 0.18 * exp2(toneLog(l, t));
  c *= y2 / y;
  // 5. display transform
  vec3 g = displayEncode(c);
  // 6. profile base curve
  g = vec3(baseCurve(g.r, uBaseContrast), baseCurve(g.g, uBaseContrast), baseCurve(g.b, uBaseContrast));
  // 6a. a look built for camera log footage replaces the display render
  if (uLookOn == 1 && uLookLog != 0) g = mix(g, sampleLook(encodeLog(uLookLog, uLookMat * c)), uLookAmount);
  // 6b. point curves
  g = vec3(lut(1, lut(0, g.r)), lut(2, lut(0, g.g)), lut(3, lut(0, g.b)));
  // 6c. a display-referred look on the finished picture
  if (uLookOn == 1 && uLookLog == 0) g = mix(g, sampleLook(g), uLookAmount);
  // 6d. double exposure, the layer way: the familiar display-referred blend
  // modes on the finished picture. Everything below still applies to both.
  if (uBlendMode != 0 && bl.a > 0.0) g = blendMode(g, displayEncode(bl.rgb), uBlendMode, bl.a);
  // 7. vibrance / saturation
  float mx = max(g.r, max(g.g, g.b));
  float mn = min(g.r, min(g.g, g.b));
  float sat0 = mx > 1e-5 ? (mx - mn) / mx : 0.0;
  float lum = dot(g, LUMA_709);
  float amt = max(1.0 + t.saturation + uVibrance * (1.0 - sat0), 0.0);
  g = clamp(lum + (g - lum) * amt, 0.0, 1.0);
  // 7b. colour grading (split toning) by tonal range
  if (uGradingOn == 1) {
    float lb = clamp(dot(g, LUMA_709) + 0.35 * uBalance, 0.0, 1.0);
    float ws = 1.0 - smooth01(lb / 0.5);
    float wh = smooth01((lb - 0.5) / 0.5);
    float wm = max(1.0 - ws - wh, 0.0);
    g = clamp(g + ws * uTintS + wm * uTintM + wh * uTintH, 0.0, 1.0);
  }
  // 7c. picture profile: monochrome conversion
  if (uMono == 1) {
    float y = clamp(dot(g, uMonoMix), 0.0, 1.0);
    return vec3(y);
  }
  // 8. HSL bands
  vec3 hsv = rgb2hsv(g);
  float hdeg = hsv.x * 360.0;
  float dh = 0.0, ds = 0.0, dl = 0.0, wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    float d = abs(hdeg - CENTERS[i]);
    d = min(d, 360.0 - d);
    float w = max(1.0 - d / 40.0, 0.0);
    dh += w * uHslHue[i];
    ds += w * uHslSat[i];
    dl += w * uHslLum[i];
    wsum += w;
  }
  if (wsum > 0.0) { dh /= wsum; ds /= wsum; dl /= wsum; }
  float sv = hsv.y;
  hsv.x = mod(hsv.x + dh * (30.0 / 360.0) * sv, 1.0);
  hsv.y = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
  hsv.z = clamp(hsv.z * (1.0 + dl * 0.5 * sv), 0.0, 1.0);
  return hsv2rgb(hsv);
}

float maskRaster(int slot, vec2 uv) {
  return texture(uMasks, vec3(uv, float(slot))).r;
}


// Twin of mask.rs Prepared::weight. Pixel centres: uv * size == x + 0.5.
float maskWeight(int i, vec2 uv, float luma) {
  int kind = uMaskKind[i];
  vec4 p0 = uMaskP0[i];
  vec4 p1 = uMaskP1[i];
  float raw;
  if (kind == 2) {
    vec2 p = uv * uSize;
    float len2 = dot(p0.zw, p0.zw);
    raw = len2 < 1e-6 ? 1.0 : 1.0 - smooth01(dot(p - p0.xy, p0.zw) / len2);
  } else if (kind == 3) {
    vec2 d = uv * uSize - p0.xy;
    float lx = d.x * p1.x + d.y * p1.y;
    float ly = -d.x * p1.y + d.y * p1.x;
    float e = length(vec2(lx / p0.z, ly / p0.w));
    float f = max(p1.z, 0.01);
    raw = 1.0 - smooth01((e - (1.0 - f)) / f);
  } else if (kind == 1) {
    float f = max(p0.z, 0.005);
    raw = clamp(smooth01((luma - (p0.x - f)) / f) * (1.0 - smooth01((luma - p0.y) / f)), 0.0, 1.0);
  } else {
    raw = maskRaster(int(p0.x + 0.5), uv);
  }
  float v = uMaskInvert[i] == 1 ? 1.0 - raw : raw;
  return v * uMaskAmount[i];
}

Tone globalTone() {
  Tone t;
  t.exposure = uExposure; t.contrast = uContrast; t.highlights = uHighlights; t.shadows = uShadows;
  t.whites = uWhites; t.blacks = uBlacks; t.temp = uTemp; t.tint = uTint; t.saturation = uSaturation;
  t.texture = uTexture; t.clarity = uClarity; t.dehaze = uDehaze;
  return t;
}

// Twin of pipeline.rs Tone::add (deltas are raw slider units, exposure in EV)
Tone addMask(Tone t, int i, float w) {
  if (w <= 0.0) return t;
  float k = w / 100.0;
  int b = i * 12;
  t.exposure += uMaskAdj[b] * w;
  t.contrast += uMaskAdj[b + 1] * k;
  t.highlights += uMaskAdj[b + 2] * k;
  t.shadows += uMaskAdj[b + 3] * k;
  t.whites += uMaskAdj[b + 4] * k;
  t.blacks += uMaskAdj[b + 5] * k;
  t.temp += uMaskAdj[b + 6] * k;
  t.tint += uMaskAdj[b + 7] * k;
  t.saturation += uMaskAdj[b + 8] * k;
  t.texture += uMaskAdj[b + 9] * k;
  t.clarity += uMaskAdj[b + 10] * k;
  t.dehaze += uMaskAdj[b + 11] * k;
  return t;
}

Tone finishTone(Tone t) {
  t.exposure = clamp(t.exposure, -10.0, 10.0);
  t.contrast = clamp(t.contrast, -1.0, 1.0);
  t.highlights = clamp(t.highlights, -1.0, 1.0);
  t.shadows = clamp(t.shadows, -1.0, 1.0);
  t.whites = clamp(t.whites, -1.0, 1.0);
  t.blacks = clamp(t.blacks, -1.0, 1.0);
  t.temp = clamp(t.temp, -1.0, 1.0);
  t.tint = clamp(t.tint, -1.0, 1.0);
  t.saturation = clamp(t.saturation, -1.0, 1.0);
  t.texture = clamp(t.texture, -1.0, 1.0);
  t.clarity = clamp(t.clarity, -1.0, 1.0);
  t.dehaze = clamp(t.dehaze, -1.0, 1.0);
  return t;
}

// Film grain. Twin of grain.rs: an integer hash of the position rather than a
// random number, so the grain lands in the same places on both pipelines, and
// measured against a fixed reference size, so it is the same size relative to
// the picture in a preview and in a full-resolution export.
const float GRAIN_REF = 3000.0;

uint grainHash(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

float grainHash01(int ix, int iy, uint seed) {
  uint x = uint(ix + 8192);
  uint y = uint(iy + 8192);
  uint h = grainHash((x * 0x9e3779b9u) ^ grainHash(y + seed));
  return float(h >> 8u) / 16777216.0;
}

float grainNoise(float x, float y, uint seed) {
  float x0 = floor(x);
  float y0 = floor(y);
  float fx = smooth01(x - x0);
  float fy = smooth01(y - y0);
  int ix = int(x0);
  int iy = int(y0);
  float a = mix(grainHash01(ix, iy, seed), grainHash01(ix + 1, iy, seed), fx);
  float b = mix(grainHash01(ix, iy + 1, seed), grainHash01(ix + 1, iy + 1, seed), fx);
  return mix(a, b, fy);
}

float grainAt(vec2 uv, float longEdge, uint channel) {
  float cell = 1.0 + clamp(uGrainSize / 100.0, 0.0, 1.0) * 7.0;
  float s = GRAIN_REF / cell;
  float x = uv.x * s * max(longEdge / GRAIN_REF, 0.0001);
  float y = uv.y * s;
  float coarse = grainNoise(x, y, 11u + channel * 101u);
  float fine = grainNoise(x * 2.17, y * 2.17, 977u + channel * 101u);
  return (coarse * 0.65 + fine * 0.35) * 2.0 - 1.0;
}

vec3 applyGrain(vec3 c, vec2 uv) {
  float k = clamp(uGrainAmount / 100.0, 0.0, 1.0) * 0.28;
  if (k <= 0.0) return c;
  float aspect = uSize.x / max(uSize.y, 1.0);
  float longEdge = aspect >= 1.0 ? GRAIN_REF * aspect : GRAIN_REF;
  float y = dot(c, LUMA_709);
  // film shows its grain in the midtones and shadows, not in paper white
  float weight = clamp(4.0 * y * (1.0 - y), 0.0, 1.0) * 0.85 + 0.15;
  vec3 n = vec3(grainAt(uv, longEdge, 0u));
  float cc = clamp(uGrainColour / 100.0, 0.0, 1.0);
  if (cc > 0.0) {
    vec3 per = vec3(grainAt(uv, longEdge, 1u), grainAt(uv, longEdge, 2u), grainAt(uv, longEdge, 3u));
    n = mix(n, per, cc);
  }
  // a gain rather than an offset, so grain does not tint the picture
  return clamp(c * (1.0 + n * k * weight), 0.0, 1.0);
}

void main() {
  vec3 rgb = texture(uImage, vUv).rgb;
  Tone t = globalTone();
  float show = 0.0;
  if (uNumMasks > 0) {
    float luma = uUseLumaG == 1 ? dot(texture(uLumaG, vUv).rgb, LUMA_709) : 0.0;
    // weights first: a subtract mask takes its share out of the mask above it
    // before any adjustment is applied (twin of mask.rs Prepared::weight)
    float wv[8] = float[8](0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    int head = -1;
    for (int i = 0; i < 8; i++) {
      if (i >= uNumMasks) break;
      float w = maskWeight(i, vUv, luma);
      if (uMaskMode[i] == 1) {
        if (head >= 0) wv[head] *= 1.0 - w;
        // a subtract mask being edited still shows its own area
        if (i == uShowMask) show = w;
      } else {
        head = i;
        wv[i] = w;
      }
    }
    for (int i = 0; i < 8; i++) {
      if (i >= uNumMasks) break;
      if (uMaskMode[i] == 1) continue;
      if (i == uShowMask) show = wv[i];
      t = addMask(t, i, wv[i]);
    }
    t = finishTone(t);
  }
  vec3 c = applyGrain(developPixel(rgb, t), vUv);
  if (uShowMask >= 0) c = mix(c, vec3(1.0, 0.12, 0.12), 0.6 * show);
  outColor = vec4(c, 1.0);
}`;

/** Mirror power window on the developed image. Twin of pipeline.rs MirrorGeom. */
/**
 * Cross-screen ("starburst") filter, in three passes so the cost of up to six
 * directions x 24 samples lands on a quarter-resolution map instead of the
 * whole picture. Twin of star.rs.
 *
 * 1. STAR_HI: which parts of the picture are highlights, and in what colour.
 * 2. STAR_STREAK: smear those highlights along the star's lines.
 * 3. STAR_ADD: screen the streaks back over the picture.
 */
export const STAR_SAMPLES = 24;

export const STAR_HI_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;       // the developed picture, mipmapped
uniform float uThreshold;     // 0..1 luma
${COMMON}
void main() {
  // mip level 2 is the 4x4 box average star.rs builds by hand
  vec3 c = textureLod(uTex, vUv, 2.0).rgb;
  float y = dot(c, LUMA_709);
  float t = clamp((y - uThreshold) / max(1.0 - uThreshold, 1e-3), 0.0, 1.0);
  float k = t * t;
  // keep the highlight's own colour: a tungsten lamp stars warm
  vec3 h = (y > 1e-4 ? c / y : vec3(1.0)) * k;
  outColor = vec4(h, 1.0);
}`;

export const STAR_STREAK_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uHi;
uniform vec2 uQSize;     // size of the highlight map, in its own pixels
uniform float uLenQ;     // streak half-length, in those pixels
uniform float uFade;     // exponent of the (1 - t) falloff
uniform float uDisp;     // how far red and blue are pulled apart
uniform int uLines;      // 1..6
uniform float uAngle;    // radians
const int STAR_SAMPLES = 24;
const float STAR_PI = 3.14159265358979;
void main() {
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int l = 0; l < 6; l++) {
    if (l >= uLines) break;
    float th = uAngle + STAR_PI * float(l) / float(uLines);
    vec2 dir = vec2(cos(th), sin(th));
    for (int i = 1; i <= STAR_SAMPLES; i++) {
      float t = float(i) / float(STAR_SAMPLES);
      // the base is held off zero because a driver that computes pow as
      // exp2(y * log2(x)) returns NaN for pow(0, y), and one NaN poisons the
      // whole sum - the streaks then vanish completely
      float w = pow(max(1.0 - t, 1e-6), uFade);
      vec2 o = dir * (t * uLenQ) / uQSize;
      // the red end of the spectrum is bent further than the blue
      vec2 r = o * (1.0 + uDisp);
      vec2 b = o * (1.0 - uDisp);
      vec3 fwd = vec3(texture(uHi, vUv + r).r, texture(uHi, vUv + o).g, texture(uHi, vUv + b).b);
      vec3 bwd = vec3(texture(uHi, vUv - r).r, texture(uHi, vUv - o).g, texture(uHi, vUv - b).b);
      acc += (fwd + bwd) * w;
      wsum += 2.0 * w;
    }
  }
  outColor = vec4(wsum > 0.0 ? acc / wsum : vec3(0.0), 1.0);
}`;

export const STAR_ADD_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform sampler2D uStreak;
uniform float uGain;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  vec3 s = clamp(texture(uStreak, vUv).rgb * uGain, 0.0, 1.0);
  // screen: the star brightens what is under it without pushing it past white
  vec3 r = 1.0 - (1.0 - clamp(c, 0.0, 1.0)) * (1.0 - s);
  // and leaves the picture strictly alone where there is no star
  outColor = vec4(mix(c, r, step(1e-7, s)), 1.0);
}`;

export const MIRROR_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uSize;     // image size in px
uniform vec2 uCenter;   // px
uniform vec2 uRadii;    // px
uniform vec2 uCosSin;   // window rotation
uniform vec2 uDir;      // tail direction (unit)
uniform vec2 uLine;     // point on the mirror line
uniform float uTail;    // px
uniform float uFeather; // 0..1
uniform float uOpacity; // 0..1
float smooth01(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
float window(vec2 p) {
  vec2 d = p - uCenter;
  float lx = d.x * uCosSin.x + d.y * uCosSin.y;
  float ly = -d.x * uCosSin.y + d.y * uCosSin.x;
  float e = length(vec2(lx / uRadii.x, ly / uRadii.y));
  float f = max(uFeather, 0.01);
  return 1.0 - smooth01((e - (1.0 - f)) / f);
}
void main() {
  vec2 p = vUv * uSize;
  vec3 c = texture(uTex, vUv).rgb;
  float t = dot(p - uLine, uDir);
  if (t > 0.0) {
    vec2 q = p - 2.0 * t * uDir;
    float win = window(q);
    float fade = 1.0 - smooth01(t / uTail);
    float a = uOpacity * win * fade;
    if (a > 0.0) {
      vec3 s = texture(uTex, q / uSize).rgb;
      c = mix(c, s, a);
    }
  }
  outColor = vec4(c, 1.0);
}`;

/** Composite an RGBA watermark over the developed image. Twin of pipeline.rs watermark_pass. */
export const WATERMARK_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform sampler2D uWm;
uniform vec2 uSize;    // image px
uniform vec4 uRect;    // x0, y0, w, h in image px
uniform float uOpacity;
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  vec2 p = vUv * uSize;
  vec2 uv = (p - uRect.xy) / uRect.zw;
  if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
    vec4 s = texture(uWm, uv);
    c = mix(c, s.rgb, s.a * uOpacity);
  }
  outColor = vec4(c, 1.0);
}`;

/**
 * Display pass: perspective transform + lens distortion + chromatic
 * aberration, then output sharpening. `vUv` arrives already carrying the crop
 * offset and straighten rotation (uUvMat), so `vUv * uSize` is the canvas
 * point that geometry.rs feeds to `Warp::map_rgb`.
 */
export const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform vec2 uSize;
uniform float uSharpen;
uniform vec3 uOutside;   // colour for texels outside the image (straighten corners)
// warp, twin of geometry.rs Warp
uniform int uWarpOn;
uniform int uTransformOn;
uniform float uHs;
uniform vec2 uOfs;
uniform float uInvScale;
uniform vec2 uAspect;
uniform vec2 uCosSinT;
uniform vec2 uPersp;
uniform int uDistModel;
uniform vec3 uDist;
uniform float uDistAmount;
uniform float uCs;
uniform float uKm;
uniform vec2 uTca;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float distortRadius(float r) {
  float rd = r;
  if (uDistModel != 0) {
    float rc = r * uCs;
    float f;
    if (uDistModel == 1) f = rc * (uDist.x * rc * rc * rc + uDist.y * rc * rc + uDist.z * rc + 1.0 - uDist.x - uDist.y - uDist.z);
    else if (uDistModel == 2) f = rc * (1.0 - uDist.x + uDist.x * rc * rc);
    else f = rc * (1.0 + uDist.x * rc * rc + uDist.y * rc * rc * rc * rc);
    rd = r + uDistAmount * (f / uCs - r);
  }
  if (uKm != 0.0) rd *= 1.0 + uKm * rd * rd;
  return rd;
}

vec2 mapNorm(vec2 p) {
  vec2 q = (p - uSize * 0.5) / uHs;
  if (uTransformOn == 1) {
    q = (q - uOfs) * uInvScale / uAspect;
    vec2 r = vec2(uCosSinT.x * q.x - uCosSinT.y * q.y, uCosSinT.y * q.x + uCosSinT.x * q.y);
    q = r / max(1.0 + dot(uPersp, r), 0.05);
  }
  float r = length(q);
  if (r > 1e-6) q *= distortRadius(r) / r;
  return q;
}

vec2 toUv(vec2 q, float k) { return (uSize * 0.5 + q * k * uHs) / uSize; }

float sharpLuma(vec2 uv) { return dot(texture(uTex, uv).rgb, LUMA); }

void main() {
  vec2 uv = vUv;
  vec3 c;
  if (uWarpOn == 1) {
    vec2 q = mapNorm(vUv * uSize);
    uv = toUv(q, 1.0);
    vec2 uvR = toUv(q, uTca.x);
    vec2 uvB = toUv(q, uTca.y);
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
      outColor = vec4(uOutside, 1.0);
      return;
    }
    c = vec3(texture(uTex, uvR).r, texture(uTex, uv).g, texture(uTex, uvB).b);
  } else {
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) {
      outColor = vec4(uOutside, 1.0);
      return;
    }
    c = texture(uTex, uv).rgb;
  }
  if (uSharpen > 0.0) {
    float b = 0.0;
    b += sharpLuma(uv + uTexel * vec2(-1.0, -1.0)) * 1.0;
    b += sharpLuma(uv + uTexel * vec2( 0.0, -1.0)) * 2.0;
    b += sharpLuma(uv + uTexel * vec2( 1.0, -1.0)) * 1.0;
    b += sharpLuma(uv + uTexel * vec2(-1.0,  0.0)) * 2.0;
    b += dot(c, LUMA) * 4.0;
    b += sharpLuma(uv + uTexel * vec2( 1.0,  0.0)) * 2.0;
    b += sharpLuma(uv + uTexel * vec2(-1.0,  1.0)) * 1.0;
    b += sharpLuma(uv + uTexel * vec2( 0.0,  1.0)) * 2.0;
    b += sharpLuma(uv + uTexel * vec2( 1.0,  1.0)) * 1.0;
    b /= 16.0;
    float sy = dot(c, LUMA);
    float sd = (sy - b) * uSharpen;
    // a gain, not an offset: brightness moves, hue and saturation do not
    c *= clamp((sy + sd) / max(sy, 1e-4), 0.0, 4.0);
  }
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
