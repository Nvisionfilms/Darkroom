// GPU twin of src-tauri/src/pipeline.rs, denoise.rs and detail.rs.
// Keep the math identical to the Rust code.

export const VERTEX = `#version 300 es
in vec2 aPos;
uniform mat3 uTransform;
out vec2 vUv;
void main() {
  vUv = aPos;
  vec3 p = uTransform * vec3(aPos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const COMMON = `
const vec3 LUMA_PROXY = vec3(0.2627, 0.6780, 0.0593);
const vec3 LUMA_709 = vec3(0.2126, 0.7152, 0.0722);
float lumaProxy(vec3 c) { return dot(c, LUMA_PROXY); }
`;

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
  float kk = uDetail * min(abs(rs) / (2.0 * uSigma), 1.0);
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

export const DEVELOP_FRAG = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uImage;   // denoised linear DWG
uniform sampler2D uLut;     // R32F 256x4: master, r, g, b
uniform sampler2D uLg;      // log2 luma
uniform sampler2D uB1;      // blur sigma ~1
uniform sampler2D uB2;      // blur sigma ~4
uniform sampler2D uB3;      // blur sigma ~2% long edge (quarter res)
uniform int uUseMaps;
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTemp;
uniform float uTint;
uniform float uVibrance;
uniform float uSaturation;
uniform float uBaseContrast;
uniform float uTexture;
uniform float uClarity;
uniform float uHslHue[8];
uniform float uHslSat[8];
uniform float uHslLum[8];
uniform vec3 uTintS;
uniform vec3 uTintM;
uniform vec3 uTintH;
uniform float uBalance;
uniform int uGradingOn;

${COMMON}
const float CENTERS[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 275.0, 310.0);
const float LOG_MID = -2.473931188;
// DaVinci Wide Gamut -> linear sRGB (column-major for GLSL)
const mat3 DWG_TO_SRGB = mat3(
  1.898614899, -0.168948786, -0.121539161,
 -0.792176183,  1.488975754, -0.315675853,
 -0.106438716, -0.320026968,  1.437215014);

float srgbEnc(float x) {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055;
}
float smooth01(float x) { x = clamp(x, 0.0, 1.0); return x * x * (3.0 - 2.0 * x); }
float shoulder(float x) {
  const float K = 0.8;
  return x <= K ? x : K + (1.0 - K) * (1.0 - exp(-(x - K) / (1.0 - K)));
}
float softclip(float x) { return 1.5 * tanh(x / 1.5); }
float toneLog(float l) {
  float ws = smooth01(-l / 5.0);
  float wh = smooth01(l / 3.0);
  float wb = smooth01((-l - 2.0) / 5.0);
  float ww = smooth01((l - 1.0) / 3.0);
  l += uShadows * 1.5 * ws;
  l += uHighlights * 1.5 * wh;
  l += uBlacks * 1.5 * wb;
  l += uWhites * 1.5 * ww;
  l *= 1.0 + uContrast * 0.6;
  return l;
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

vec3 developPixel(vec3 rgb) {
  // 1. white balance
  vec3 c = rgb * vec3(1.0 + 0.4 * uTemp, 1.0 - 0.25 * uTint, 1.0 - 0.4 * uTemp);
  // 2. exposure
  c = max(c * exp2(uExposure), 0.0);
  // 3. local contrast
  if (uUseMaps == 1 && (uTexture != 0.0 || uClarity != 0.0)) {
    float lg = texture(uLg, vUv).r;
    float b1 = texture(uB1, vUv).r;
    float b2 = texture(uB2, vUv).r;
    float b3 = texture(uB3, vUv).r;
    float dist = abs(lg + uExposure - LOG_MID);
    float wmid = 1.0 - smooth01((dist - 1.5) / 3.0);
    float dt = uTexture * 1.5 * (b1 - b2);
    float dc = uClarity * 1.2 * wmid * softclip(b1 - b3);
    c *= exp2(dt + dc);
  }
  // 4. tone in log-luminance
  float y = max(lumaProxy(c), 1e-6);
  float l = log2(y / 0.18);
  float y2 = 0.18 * exp2(toneLog(l));
  c *= y2 / y;
  // 5. display transform
  vec3 s = gamutCompress(DWG_TO_SRGB * c);
  s = max(s, 0.0);
  s = clamp(vec3(shoulder(s.r), shoulder(s.g), shoulder(s.b)), 0.0, 1.0);
  vec3 g = vec3(srgbEnc(s.r), srgbEnc(s.g), srgbEnc(s.b));
  // 6. profile base curve + point curves
  g = vec3(baseCurve(g.r, uBaseContrast), baseCurve(g.g, uBaseContrast), baseCurve(g.b, uBaseContrast));
  g = vec3(lut(1, lut(0, g.r)), lut(2, lut(0, g.g)), lut(3, lut(0, g.b)));
  // 7. vibrance / saturation
  float mx = max(g.r, max(g.g, g.b));
  float mn = min(g.r, min(g.g, g.b));
  float sat0 = mx > 1e-5 ? (mx - mn) / mx : 0.0;
  float lum = dot(g, LUMA_709);
  float amt = max(1.0 + uSaturation + uVibrance * (1.0 - sat0), 0.0);
  g = clamp(lum + (g - lum) * amt, 0.0, 1.0);
  // 7b. colour grading (split toning) by tonal range
  if (uGradingOn == 1) {
    float lb = clamp(dot(g, LUMA_709) + 0.35 * uBalance, 0.0, 1.0);
    float ws = 1.0 - smooth01(lb / 0.5);
    float wh = smooth01((lb - 0.5) / 0.5);
    float wm = max(1.0 - ws - wh, 0.0);
    g = clamp(g + ws * uTintS + wm * uTintM + wh * uTintH, 0.0, 1.0);
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

void main() {
  vec3 rgb = texture(uImage, vUv).rgb;
  outColor = vec4(developPixel(rgb), 1.0);
}`;

/** Mirror power window on the developed image. Twin of pipeline.rs MirrorGeom. */
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

export const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uSharpen;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  if (uSharpen > 0.0) {
    float b = 0.0;
    b += dot(texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb, LUMA) * 1.0;
    b += dot(texture(uTex, vUv + uTexel * vec2( 0.0, -1.0)).rgb, LUMA) * 2.0;
    b += dot(texture(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb, LUMA) * 1.0;
    b += dot(texture(uTex, vUv + uTexel * vec2(-1.0,  0.0)).rgb, LUMA) * 2.0;
    b += dot(c, LUMA) * 4.0;
    b += dot(texture(uTex, vUv + uTexel * vec2( 1.0,  0.0)).rgb, LUMA) * 2.0;
    b += dot(texture(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb, LUMA) * 1.0;
    b += dot(texture(uTex, vUv + uTexel * vec2( 0.0,  1.0)).rgb, LUMA) * 2.0;
    b += dot(texture(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb, LUMA) * 1.0;
    b /= 16.0;
    c += (dot(c, LUMA) - b) * uSharpen;
  }
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;
