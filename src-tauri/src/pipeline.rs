//! The develop pipeline. This file is the CPU twin of `src/gl/shaders.ts`.
//! Any change to the math here MUST be mirrored in the GLSL and vice versa,
//! otherwise the exported file will not match what the user saw on screen.
//!
//! Stage order (scene-referred first, display-referred last, as Resolve does):
//!   linear DWG -> [denoise] -> WB -> exposure -> local contrast (texture,
//!   clarity) -> tone (log2 around 0.18) -> DWG->sRGB -> gamut compression ->
//!   highlight shoulder -> sRGB OETF -> base curve -> point curves ->
//!   vibrance/saturation -> HSL -> [sharpen on output]

use crate::color::{dot3, mul3, DWG_TO_SRGB, LUMA_709, LUMA_PROXY};
use crate::detail::{sample_q, DetailMaps};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HslParams {
    pub hue: [f32; 8],
    pub saturation: [f32; 8],
    pub luminance: [f32; 8],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Curves {
    pub master: Vec<[f32; 2]>,
    pub red: Vec<[f32; 2]>,
    pub green: Vec<[f32; 2]>,
    pub blue: Vec<[f32; 2]>,
}

/// User-facing slider values. Most are -100..100, exposure is EV.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditParams {
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub temperature: f32,
    pub tint: f32,
    pub vibrance: f32,
    pub saturation: f32,
    /// 0 = linear profile, 1 = full "standard" base curve
    pub base_contrast: f32,
    /// 0..150
    pub sharpen: f32,
    /// clockwise rotation in degrees: 0, 90, 180 or 270
    #[serde(default)]
    pub rotation: u32,
    /// -100..100 mid-frequency local contrast (structure)
    #[serde(default)]
    pub texture: f32,
    /// -100..100 large-radius midtone local contrast (Resolve "midtone detail")
    #[serde(default)]
    pub clarity: f32,
    /// 0..100 luminance noise reduction
    #[serde(default)]
    pub denoise_luma: f32,
    /// 0..100 colour noise reduction
    #[serde(default = "default_denoise_chroma")]
    pub denoise_chroma: f32,
    /// 0..100 detail restoration for the denoiser
    #[serde(default = "default_denoise_detail")]
    pub denoise_detail: f32,
    #[serde(default)]
    pub grading: Grading,
    #[serde(default)]
    pub mirror: Mirror,
    #[serde(default)]
    pub watermark: Watermark,
    #[serde(default)]
    pub crop: Crop,
    pub hsl: HslParams,
    pub curves: Curves,
}

/// Split toning / colour grading: a luminance-neutral tint per tonal range.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Grading {
    /// hues in degrees 0..360, saturations 0..100
    pub shadow_hue: f32,
    pub shadow_sat: f32,
    pub mid_hue: f32,
    pub mid_sat: f32,
    pub high_hue: f32,
    pub high_sat: f32,
    /// -100..100, positive pushes the highlight tint down into the midtones
    pub balance: f32,
}

impl Default for Grading {
    fn default() -> Self {
        Self {
            shadow_hue: 220.0,
            shadow_sat: 0.0,
            mid_hue: 40.0,
            mid_sat: 0.0,
            high_hue: 45.0,
            high_sat: 0.0,
            balance: 0.0,
        }
    }
}

/// Mirror "power window": the content of an ellipse is reflected across the
/// line tangent to the window's far side (along `direction`) and blended in
/// with an opacity that fades with distance, like a faded reflection tail.
/// Geometry is in normalised image coordinates: center as fractions of the
/// image width/height, sizes as fractions of the long edge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Mirror {
    pub enabled: bool,
    pub cx: f32,
    pub cy: f32,
    pub rx: f32,
    pub ry: f32,
    /// window rotation, degrees
    pub rotation: f32,
    /// edge softness 0..100
    pub feather: f32,
    /// tail direction, degrees (0 = right, 90 = down)
    pub direction: f32,
    /// gap between window edge and mirror line, fraction of long edge
    pub offset: f32,
    /// tail length, fraction of long edge
    pub length: f32,
    /// 0..100
    pub opacity: f32,
}

impl Default for Mirror {
    fn default() -> Self {
        Self {
            enabled: false,
            cx: 0.5,
            cy: 0.45,
            rx: 0.18,
            ry: 0.22,
            rotation: 0.0,
            feather: 30.0,
            direction: 90.0,
            offset: 0.0,
            length: 0.35,
            opacity: 70.0,
        }
    }
}

/// Image watermark: centre as fractions of the photo size, width as a
/// fraction of the photo's long edge, opacity 0..100. `path` empty = none.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Watermark {
    pub enabled: bool,
    pub path: String,
    pub x: f32,
    pub y: f32,
    pub size: f32,
    pub opacity: f32,
}

impl Default for Watermark {
    fn default() -> Self {
        Self {
            enabled: false,
            path: String::new(),
            x: 0.85,
            y: 0.92,
            size: 0.2,
            opacity: 80.0,
        }
    }
}

/// Decoded watermark overlay, RGBA8 in sRGB, straight (non-premultiplied) alpha.
pub struct WatermarkImage {
    pub width: usize,
    pub height: usize,
    pub rgba: Vec<u8>,
}

impl WatermarkImage {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        use anyhow::Context;
        let img = image::ImageReader::open(path)
            .with_context(|| format!("open {}", path.display()))?
            .with_guessed_format()?
            .decode()
            .context("decode watermark")?
            .into_rgba8();
        let (w, h) = (img.width() as usize, img.height() as usize);
        anyhow::ensure!(w > 0 && h > 0, "empty watermark image");
        Ok(Self {
            width: w,
            height: h,
            rgba: img.into_raw(),
        })
    }

    /// Bilinear sample at (u, v) in 0..1, returns gamma-encoded rgb + alpha.
    #[inline]
    fn sample(&self, u: f32, v: f32) -> [f32; 4] {
        let fx = (u * self.width as f32 - 0.5).clamp(0.0, self.width as f32 - 1.0);
        let fy = (v * self.height as f32 - 0.5).clamp(0.0, self.height as f32 - 1.0);
        let x0 = fx.floor() as usize;
        let y0 = fy.floor() as usize;
        let x1 = (x0 + 1).min(self.width - 1);
        let y1 = (y0 + 1).min(self.height - 1);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let px = |x: usize, y: usize, c: usize| self.rgba[(y * self.width + x) * 4 + c] as f32 / 255.0;
        let mut o = [0.0f32; 4];
        for c in 0..4 {
            let a = px(x0, y0, c) * (1.0 - tx) + px(x1, y0, c) * tx;
            let b = px(x0, y1, c) * (1.0 - tx) + px(x1, y1, c) * tx;
            o[c] = a * (1.0 - ty) + b * ty;
        }
        o
    }
}

/// Composite the watermark onto a developed (display-space) buffer.
/// Twin of `WATERMARK_FRAG`.
pub fn watermark_pass(img: &mut [f32], width: usize, height: usize, w: &Watermark, wm: &WatermarkImage) {
    if !w.enabled || w.opacity <= 0.0 {
        return;
    }
    let long = width.max(height) as f32;
    let dw = (w.size * long).max(1.0);
    let dh = dw * wm.height as f32 / wm.width as f32;
    let x0 = w.x * width as f32 - dw / 2.0;
    let y0 = w.y * height as f32 - dh / 2.0;
    let opacity = (w.opacity / 100.0).clamp(0.0, 1.0);
    let ys = (y0.floor().max(0.0)) as usize;
    let ye = ((y0 + dh).ceil().min(height as f32)) as usize;
    let xs = (x0.floor().max(0.0)) as usize;
    let xe = ((x0 + dw).ceil().min(width as f32)) as usize;
    if ys >= ye || xs >= xe {
        return;
    }
    img.par_chunks_mut(width * 3)
        .enumerate()
        .skip(ys)
        .take(ye - ys)
        .for_each(|(y, row)| {
            let v = (y as f32 + 0.5 - y0) / dh;
            if !(0.0..1.0).contains(&v) {
                return;
            }
            for x in xs..xe {
                let u = (x as f32 + 0.5 - x0) / dw;
                if !(0.0..1.0).contains(&u) {
                    continue;
                }
                let s = wm.sample(u, v);
                let a = s[3] * opacity;
                if a <= 0.0 {
                    continue;
                }
                let p = &mut row[x * 3..x * 3 + 3];
                for c in 0..3 {
                    p[c] = p[c] + (s[c] - p[c]) * a;
                }
            }
        });
}

/// Crop + straighten. The image is first rotated by `angle` degrees about its
/// centre (the "straightened canvas", same size as the source), then the
/// rectangle (x, y, w, h), given as fractions of the source width/height in
/// that canvas, is kept. Applied after mirror/watermark, before 90° rotation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Crop {
    pub enabled: bool,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// straighten angle in degrees, clockwise positive
    pub angle: f32,
}

impl Default for Crop {
    fn default() -> Self {
        Self {
            enabled: false,
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
            angle: 0.0,
        }
    }
}

impl Crop {
    pub fn is_identity(&self) -> bool {
        !self.enabled || (self.angle == 0.0 && self.x <= 0.0 && self.y <= 0.0 && self.w >= 1.0 && self.h >= 1.0)
    }
}

/// Apply crop + straighten to a developed buffer. Returns (data, width, height).
/// Twin of the `uUvMat` path in the present shader.
pub fn crop_pass(img: &[f32], width: usize, height: usize, c: &Crop) -> (Vec<f32>, usize, usize) {
    if c.is_identity() {
        return (img.to_vec(), width, height);
    }
    let (wf, hf) = (width as f32, height as f32);
    let ow = ((c.w.clamp(0.01, 1.0) * wf).round() as usize).max(1);
    let oh = ((c.h.clamp(0.01, 1.0) * hf).round() as usize).max(1);
    let x0 = c.x.clamp(0.0, 1.0) * wf;
    let y0 = c.y.clamp(0.0, 1.0) * hf;
    let (cx, cy) = (wf / 2.0, hf / 2.0);
    let a = c.angle.to_radians();
    let (ca, sa) = (a.cos(), a.sin());
    let mut out = vec![0.0f32; ow * oh * 3];
    out.par_chunks_mut(ow * 3).enumerate().for_each(|(oy, row)| {
        let sy = y0 + oy as f32 + 0.5 - cy;
        for ox in 0..ow {
            let sx = x0 + ox as f32 + 0.5 - cx;
            // straightened canvas -> source: rotate about the centre
            let px = cx + ca * sx - sa * sy;
            let py = cy + sa * sx + ca * sy;
            if px < 0.0 || py < 0.0 || px >= wf || py >= hf {
                continue; // outside the source: black
            }
            let s = bilinear(img, width, height, px - 0.5, py - 0.5);
            row[ox * 3..ox * 3 + 3].copy_from_slice(&s);
        }
    });
    (out, ow, oh)
}

fn default_denoise_chroma() -> f32 {
    25.0
}
fn default_denoise_detail() -> f32 {
    50.0
}

impl Default for EditParams {
    fn default() -> Self {
        let line = vec![[0.0, 0.0], [1.0, 1.0]];
        Self {
            exposure: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            temperature: 0.0,
            tint: 0.0,
            vibrance: 0.0,
            saturation: 0.0,
            base_contrast: 1.0,
            sharpen: 25.0,
            rotation: 0,
            texture: 0.0,
            clarity: 0.0,
            denoise_luma: 0.0,
            denoise_chroma: default_denoise_chroma(),
            denoise_detail: default_denoise_detail(),
            grading: Grading::default(),
            mirror: Mirror::default(),
            watermark: Watermark::default(),
            crop: Crop::default(),
            hsl: HslParams {
                hue: [0.0; 8],
                saturation: [0.0; 8],
                luminance: [0.0; 8],
            },
            curves: Curves {
                master: line.clone(),
                red: line.clone(),
                green: line.clone(),
                blue: line,
            },
        }
    }
}

/// Normalised uniforms, identical to what the GLSL receives.
pub struct Uniforms {
    exposure: f32,
    contrast: f32,
    highlights: f32,
    shadows: f32,
    whites: f32,
    blacks: f32,
    temp: f32,
    tint: f32,
    vibrance: f32,
    saturation: f32,
    base_contrast: f32,
    texture: f32,
    clarity: f32,
    hsl_hue: [f32; 8],
    hsl_sat: [f32; 8],
    hsl_lum: [f32; 8],
    /// luminance-neutral RGB offsets for shadows / midtones / highlights
    tint_s: [f32; 3],
    tint_m: [f32; 3],
    tint_h: [f32; 3],
    balance: f32,
    grading_on: bool,
}

/// Tint offset for a hue/saturation pair: hue colour minus its luminance,
/// scaled so 100% saturation is a strong but usable tint. Shared with the shader.
pub fn tint_offset(hue_deg: f32, sat: f32) -> [f32; 3] {
    let c = hsv2rgb([hue_deg / 360.0, 1.0, 1.0]);
    let l = dot3(c, LUMA_709);
    let k = (sat / 100.0).clamp(0.0, 1.0) * 0.3;
    [(c[0] - l) * k, (c[1] - l) * k, (c[2] - l) * k]
}

impl Uniforms {
    pub fn from_params(p: &EditParams) -> Self {
        let n = |v: f32| (v / 100.0).clamp(-1.0, 1.0);
        let n8 = |a: &[f32; 8]| {
            let mut o = [0.0f32; 8];
            for i in 0..8 {
                o[i] = n(a[i]);
            }
            o
        };
        Self {
            exposure: p.exposure.clamp(-10.0, 10.0),
            contrast: n(p.contrast),
            highlights: n(p.highlights),
            shadows: n(p.shadows),
            whites: n(p.whites),
            blacks: n(p.blacks),
            temp: n(p.temperature),
            tint: n(p.tint),
            vibrance: n(p.vibrance),
            saturation: n(p.saturation),
            base_contrast: p.base_contrast.clamp(0.0, 1.0),
            texture: n(p.texture),
            clarity: n(p.clarity),
            hsl_hue: n8(&p.hsl.hue),
            hsl_sat: n8(&p.hsl.saturation),
            hsl_lum: n8(&p.hsl.luminance),
            tint_s: tint_offset(p.grading.shadow_hue, p.grading.shadow_sat),
            tint_m: tint_offset(p.grading.mid_hue, p.grading.mid_sat),
            tint_h: tint_offset(p.grading.high_hue, p.grading.high_sat),
            balance: n(p.grading.balance),
            grading_on: p.grading.shadow_sat > 0.0 || p.grading.mid_sat > 0.0 || p.grading.high_sat > 0.0,
        }
    }
}

const HSL_CENTERS: [f32; 8] = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 275.0, 310.0];
const LOG_MID: f32 = -2.473931188; // log2(0.18)

#[inline]
fn srgb_enc(x: f32) -> f32 {
    if x <= 0.0031308 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

#[inline]
fn smooth01(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

#[inline]
fn shoulder(x: f32) -> f32 {
    const K: f32 = 0.8;
    if x <= K {
        x
    } else {
        K + (1.0 - K) * (1.0 - (-(x - K) / (1.0 - K)).exp())
    }
}

#[inline]
fn tone_log(l: f32, u: &Uniforms) -> f32 {
    let ws = smooth01(-l / 5.0);
    let wh = smooth01(l / 3.0);
    let wb = smooth01((-l - 2.0) / 5.0);
    let ww = smooth01((l - 1.0) / 3.0);
    let mut l = l;
    l += u.shadows * 1.5 * ws;
    l += u.highlights * 1.5 * wh;
    l += u.blacks * 1.5 * wb;
    l += u.whites * 1.5 * ww;
    l *= 1.0 + u.contrast * 0.6;
    l
}

#[inline]
fn base_curve(x: f32, k: f32) -> f32 {
    (x + k * 0.5 * x * (1.0 - x) * (x - 0.5) * 4.0).clamp(0.0, 1.0)
}

#[inline]
fn lut_lookup(lut: &[f32], row: usize, x: f32) -> f32 {
    let p = x.clamp(0.0, 1.0) * 255.0;
    let i = p.floor() as usize;
    let f = p - i as f32;
    let a = lut[row * 256 + i];
    let b = lut[row * 256 + (i + 1).min(255)];
    a + (b - a) * f
}

#[inline]
fn rgb2hsv(c: [f32; 3]) -> [f32; 3] {
    let mx = c[0].max(c[1]).max(c[2]);
    let mn = c[0].min(c[1]).min(c[2]);
    let d = mx - mn;
    let v = mx;
    let s = if mx > 1e-6 { d / mx } else { 0.0 };
    let h = if d < 1e-6 {
        0.0
    } else if mx == c[0] {
        ((c[1] - c[2]) / d).rem_euclid(6.0) / 6.0
    } else if mx == c[1] {
        ((c[2] - c[0]) / d + 2.0) / 6.0
    } else {
        ((c[0] - c[1]) / d + 4.0) / 6.0
    };
    [h, s, v]
}

#[inline]
fn hsv2rgb(h: [f32; 3]) -> [f32; 3] {
    let (hh, s, v) = (h[0].rem_euclid(1.0) * 6.0, h[1], h[2]);
    let i = hh.floor();
    let f = hh - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match i as i32 {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

/// Soft limiter for local-contrast deltas (in EV) so halos stay bounded.
#[inline]
fn softclip(x: f32) -> f32 {
    1.5 * (x / 1.5).tanh()
}

/// Hue-preserving gamut compression toward luminance: colours whose minimum
/// channel would go negative in sRGB are pulled toward their luminance with a
/// soft knee, instead of being hard clipped (cf. Resolve's saturation mapping).
#[inline]
fn gamut_compress(s: [f32; 3]) -> [f32; 3] {
    let y = dot3(s, LUMA_709).max(1e-6);
    let m = s[0].min(s[1]).min(s[2]);
    let d = (y - m) / y; // 1.0 = exactly at the gamut boundary
    const T: f32 = 0.75;
    if d <= T {
        return s;
    }
    let d2 = T + (1.0 - T) * (1.0 - (-(d - T) / (1.0 - T)).exp());
    let k = d2 / d;
    [y + (s[0] - y) * k, y + (s[1] - y) * k, y + (s[2] - y) * k]
}

/// Local-contrast inputs for one pixel: log2 luma and its three blurs.
#[derive(Clone, Copy)]
pub struct LocalMaps {
    pub lg: f32,
    pub b1: f32,
    pub b2: f32,
    pub b3: f32,
}

/// Develop one linear DWG pixel into a gamma-encoded sRGB display pixel in 0..1.
/// Mirrors `developPixel` in the shader.
#[inline]
pub fn develop_pixel(rgb: [f32; 3], maps: Option<LocalMaps>, u: &Uniforms, lut: &[f32]) -> [f32; 3] {
    // 1. white balance
    let mut c = [
        rgb[0] * (1.0 + 0.4 * u.temp),
        rgb[1] * (1.0 - 0.25 * u.tint),
        rgb[2] * (1.0 - 0.4 * u.temp),
    ];
    // 2. exposure
    let ev = 2f32.powf(u.exposure);
    for v in c.iter_mut() {
        *v = (*v * ev).max(0.0);
    }
    // 3. local contrast
    if let Some(m) = maps {
        if u.texture != 0.0 || u.clarity != 0.0 {
            let dist = (m.lg + u.exposure - LOG_MID).abs();
            let wmid = 1.0 - smooth01((dist - 1.5) / 3.0);
            let dt = u.texture * 1.5 * (m.b1 - m.b2);
            let dc = u.clarity * 1.2 * wmid * softclip(m.b1 - m.b3);
            let g = 2f32.powf(dt + dc);
            for v in c.iter_mut() {
                *v *= g;
            }
        }
    }
    // 4. tone in log-luminance (proxy luma, always positive)
    let y = dot3(c, LUMA_PROXY).max(1e-6);
    let l = (y / 0.18).log2();
    let y2 = 0.18 * 2f32.powf(tone_log(l, u));
    let ratio = y2 / y;
    for v in c.iter_mut() {
        *v *= ratio;
    }
    // 5. display transform: DWG -> linear sRGB, gamut compress, shoulder, encode
    let s = gamut_compress(mul3(&DWG_TO_SRGB, c));
    let mut g = [
        srgb_enc(shoulder(s[0].max(0.0)).clamp(0.0, 1.0)),
        srgb_enc(shoulder(s[1].max(0.0)).clamp(0.0, 1.0)),
        srgb_enc(shoulder(s[2].max(0.0)).clamp(0.0, 1.0)),
    ];
    // 6. profile base curve + point curves
    for v in g.iter_mut() {
        *v = base_curve(*v, u.base_contrast);
    }
    g = [
        lut_lookup(lut, 1, lut_lookup(lut, 0, g[0])),
        lut_lookup(lut, 2, lut_lookup(lut, 0, g[1])),
        lut_lookup(lut, 3, lut_lookup(lut, 0, g[2])),
    ];
    // 7. vibrance / saturation
    let mx = g[0].max(g[1]).max(g[2]);
    let mn = g[0].min(g[1]).min(g[2]);
    let sat0 = if mx > 1e-5 { (mx - mn) / mx } else { 0.0 };
    let lum = dot3(g, LUMA_709);
    let amt = (1.0 + u.saturation + u.vibrance * (1.0 - sat0)).max(0.0);
    for v in g.iter_mut() {
        *v = (lum + (*v - lum) * amt).clamp(0.0, 1.0);
    }
    // 7b. colour grading (split toning) by tonal range
    if u.grading_on {
        let lb = (dot3(g, LUMA_709) + 0.35 * u.balance).clamp(0.0, 1.0);
        let ws = 1.0 - smooth01(lb / 0.5);
        let wh = smooth01((lb - 0.5) / 0.5);
        let wm = (1.0 - ws - wh).max(0.0);
        for c in 0..3 {
            g[c] = (g[c] + ws * u.tint_s[c] + wm * u.tint_m[c] + wh * u.tint_h[c]).clamp(0.0, 1.0);
        }
    }
    // 8. HSL bands
    let mut hsv = rgb2hsv(g);
    let hdeg = hsv[0] * 360.0;
    let (mut dh, mut ds, mut dl, mut wsum) = (0.0f32, 0.0f32, 0.0f32, 0.0f32);
    for i in 0..8 {
        let mut d = (hdeg - HSL_CENTERS[i]).abs();
        d = d.min(360.0 - d);
        let w = (1.0 - d / 40.0).max(0.0);
        dh += w * u.hsl_hue[i];
        ds += w * u.hsl_sat[i];
        dl += w * u.hsl_lum[i];
        wsum += w;
    }
    if wsum > 0.0 {
        dh /= wsum;
        ds /= wsum;
        dl /= wsum;
    }
    let sv = hsv[1];
    hsv[0] = (hsv[0] + dh * (30.0 / 360.0) * sv).rem_euclid(1.0);
    hsv[1] = (hsv[1] * (1.0 + ds)).clamp(0.0, 1.0);
    hsv[2] = (hsv[2] * (1.0 + dl * 0.5 * sv)).clamp(0.0, 1.0);
    hsv2rgb(hsv)
}

/// Develop a whole interleaved-RGB f32 buffer in parallel. Output is
/// gamma-encoded 0..1 interleaved RGB. `maps` may be None when texture and
/// clarity are both zero.
pub fn develop_buffer(
    src: &[f32],
    width: usize,
    maps: Option<&DetailMaps>,
    params: &EditParams,
    lut: &[f32],
) -> Vec<f32> {
    let u = Uniforms::from_params(params);
    let row_len = width * 3;
    let mut out = vec![0.0f32; src.len()];
    out.par_chunks_mut(row_len)
        .zip(src.par_chunks(row_len))
        .enumerate()
        .for_each(|(y, (dst, s))| {
            for (x, (d, p)) in dst.chunks_exact_mut(3).zip(s.chunks_exact(3)).enumerate() {
                let m = maps.map(|m| {
                    let i = y * width + x;
                    LocalMaps {
                        lg: m.lg[i],
                        b1: m.b1[i],
                        b2: m.b2[i],
                        b3: sample_q(&m.b3, m.qw, m.qh, x, y),
                    }
                });
                let o = develop_pixel([p[0], p[1], p[2]], m, &u, lut);
                d[0] = o[0];
                d[1] = o[1];
                d[2] = o[2];
            }
        });
    out
}

/// Luma unsharp mask with a 3x3 binomial blur, matching the shader's second pass.
/// `amount` is the 0..150 slider value.
pub fn sharpen(img: &mut [f32], width: usize, height: usize, amount: f32) {
    let k = (amount / 100.0).clamp(0.0, 1.5);
    if k <= 0.0 || width < 3 || height < 3 {
        return;
    }
    let mut luma = vec![0.0f32; width * height];
    luma.par_iter_mut().enumerate().for_each(|(i, l)| {
        let p = &img[i * 3..i * 3 + 3];
        *l = p[0] * LUMA_709[0] + p[1] * LUMA_709[1] + p[2] * LUMA_709[2];
    });
    let mut tmp = vec![0.0f32; width * height];
    tmp.par_chunks_mut(width)
        .zip(luma.par_chunks(width))
        .for_each(|(t, l)| {
            for x in 0..width {
                let a = l[x.saturating_sub(1)];
                let b = l[x];
                let c = l[(x + 1).min(width - 1)];
                t[x] = (a + 2.0 * b + c) * 0.25;
            }
        });
    img.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
        let y0 = y.saturating_sub(1);
        let y2 = (y + 1).min(height - 1);
        for x in 0..width {
            let blur = (tmp[y0 * width + x] + 2.0 * tmp[y * width + x] + tmp[y2 * width + x]) * 0.25;
            let delta = (luma[y * width + x] - blur) * k;
            let p = &mut row[x * 3..x * 3 + 3];
            p[0] = (p[0] + delta).clamp(0.0, 1.0);
            p[1] = (p[1] + delta).clamp(0.0, 1.0);
            p[2] = (p[2] + delta).clamp(0.0, 1.0);
        }
    });
}

/// Resolved mirror geometry in pixels. Shared derivation with `MIRROR_FRAG`.
pub struct MirrorGeom {
    pub cx: f32,
    pub cy: f32,
    pub rx: f32,
    pub ry: f32,
    pub cos_r: f32,
    pub sin_r: f32,
    pub dx: f32,
    pub dy: f32,
    /// point on the mirror line
    pub lx: f32,
    pub ly: f32,
    pub tail: f32,
    pub feather: f32,
    pub opacity: f32,
}

impl MirrorGeom {
    pub fn new(m: &Mirror, width: usize, height: usize) -> Self {
        let long = width.max(height) as f32;
        let (cx, cy) = (m.cx * width as f32, m.cy * height as f32);
        let rx = (m.rx * long).max(1.0);
        let ry = (m.ry * long).max(1.0);
        let rot = m.rotation.to_radians();
        let dir = m.direction.to_radians();
        let (dx, dy) = (dir.cos(), dir.sin());
        // support of the rotated ellipse along d
        let phi = dir - rot;
        let rd = ((rx * phi.cos()).powi(2) + (ry * phi.sin()).powi(2)).sqrt();
        let gap = rd + m.offset.max(0.0) * long;
        Self {
            cx,
            cy,
            rx,
            ry,
            cos_r: rot.cos(),
            sin_r: rot.sin(),
            dx,
            dy,
            lx: cx + dx * gap,
            ly: cy + dy * gap,
            tail: (m.length * long).max(1.0),
            feather: (m.feather / 100.0).clamp(0.0, 1.0),
            opacity: (m.opacity / 100.0).clamp(0.0, 1.0),
        }
    }

    /// 1 inside the window, 0 outside, feathered edge.
    #[inline]
    pub fn window(&self, x: f32, y: f32) -> f32 {
        let px = x - self.cx;
        let py = y - self.cy;
        let lx = px * self.cos_r + py * self.sin_r;
        let ly = -px * self.sin_r + py * self.cos_r;
        let e = ((lx / self.rx).powi(2) + (ly / self.ry).powi(2)).sqrt();
        let f = self.feather.max(0.01);
        1.0 - smooth01((e - (1.0 - f)) / f)
    }

    /// Blend factor and mirrored source position for output pixel (x, y).
    #[inline]
    pub fn sample(&self, x: f32, y: f32) -> Option<(f32, f32, f32)> {
        let t = (x - self.lx) * self.dx + (y - self.ly) * self.dy;
        if t <= 0.0 {
            return None;
        }
        let qx = x - 2.0 * t * self.dx;
        let qy = y - 2.0 * t * self.dy;
        let win = self.window(qx, qy);
        if win <= 0.0 {
            return None;
        }
        let fade = 1.0 - smooth01(t / self.tail);
        let a = self.opacity * win * fade;
        if a <= 0.0 {
            None
        } else {
            Some((a, qx, qy))
        }
    }
}

#[inline]
fn bilinear(img: &[f32], width: usize, height: usize, x: f32, y: f32) -> [f32; 3] {
    let fx = x.clamp(0.0, width as f32 - 1.0);
    let fy = y.clamp(0.0, height as f32 - 1.0);
    let x0 = fx.floor() as usize;
    let y0 = fy.floor() as usize;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let mut o = [0.0f32; 3];
    for c in 0..3 {
        let a = img[(y0 * width + x0) * 3 + c] * (1.0 - tx) + img[(y0 * width + x1) * 3 + c] * tx;
        let b = img[(y1 * width + x0) * 3 + c] * (1.0 - tx) + img[(y1 * width + x1) * 3 + c] * tx;
        o[c] = a * (1.0 - ty) + b * ty;
    }
    o
}

/// Apply the mirror window to a developed (display-space) buffer.
pub fn mirror_pass(img: &[f32], width: usize, height: usize, m: &Mirror) -> Vec<f32> {
    if !m.enabled || m.opacity <= 0.0 {
        return img.to_vec();
    }
    let g = MirrorGeom::new(m, width, height);
    let mut out = img.to_vec();
    out.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
        for x in 0..width {
            if let Some((a, qx, qy)) = g.sample(x as f32 + 0.5, y as f32 + 0.5) {
                let s = bilinear(img, width, height, qx - 0.5, qy - 0.5);
                for c in 0..3 {
                    let v = row[x * 3 + c];
                    row[x * 3 + c] = v + (s[c] - v) * a;
                }
            }
        }
    });
    out
}

/// Rotate an interleaved RGB f32 buffer clockwise by 0/90/180/270 degrees.
/// Returns (data, width, height).
pub fn rotate(img: &[f32], width: usize, height: usize, degrees: u32) -> (Vec<f32>, usize, usize) {
    let deg = degrees % 360;
    if deg == 0 {
        return (img.to_vec(), width, height);
    }
    let (ow, oh) = if deg == 180 { (width, height) } else { (height, width) };
    let mut out = vec![0.0f32; img.len()];
    out.par_chunks_mut(ow * 3).enumerate().for_each(|(oy, row)| {
        for ox in 0..ow {
            let (sx, sy) = match deg {
                90 => (oy, height - 1 - ox),
                180 => (width - 1 - ox, height - 1 - oy),
                _ => (width - 1 - oy, ox),
            };
            let s = (sy * width + sx) * 3;
            row[ox * 3..ox * 3 + 3].copy_from_slice(&img[s..s + 3]);
        }
    });
    (out, ow, oh)
}

/// Identity LUT (4 rows x 256), used when the caller does not supply one.
pub fn identity_lut() -> Vec<f32> {
    let mut v = Vec::with_capacity(1024);
    for _ in 0..4 {
        for i in 0..256 {
            v.push(i as f32 / 255.0);
        }
    }
    v
}
