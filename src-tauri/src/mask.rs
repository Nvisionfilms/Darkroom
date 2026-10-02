//! Masks for local adjustments ("overlays"). CPU twin of `src/mask.ts` and of
//! the mask code in `DEVELOP_FRAG`.
//!
//! A mask is a 0..1 weight per pixel. The weights of every enabled mask scale
//! that mask's adjustment deltas, which are added to the global sliders before
//! the per-pixel develop runs (see `pipeline::develop_buffer`).
//!
//! A mask in "subtract" mode carries no adjustments of its own. It cuts its
//! area out of the mask above it in the stack, so a subject selection can be
//! narrowed - "the person, but not their face" - without inverting anything
//! else. Each one multiplies its head mask's weight by (1 - its own), so
//! several subtractions compose and soft edges stay soft.
//!
//! Geometry is stored in normalised image coordinates (fractions of the image
//! width/height; radii and brush sizes as fractions of the long edge) so the
//! same sidecar drives the preview and the full-resolution export.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// Per-mask adjustment deltas, same units as the global sliders.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MaskAdjust {
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub temperature: f32,
    pub tint: f32,
    pub saturation: f32,
    pub texture: f32,
    pub clarity: f32,
    pub dehaze: f32,
}

impl MaskAdjust {
    pub fn is_zero(&self) -> bool {
        self.exposure == 0.0
            && self.contrast == 0.0
            && self.highlights == 0.0
            && self.shadows == 0.0
            && self.whites == 0.0
            && self.blacks == 0.0
            && self.temperature == 0.0
            && self.tint == 0.0
            && self.saturation == 0.0
            && self.texture == 0.0
            && self.clarity == 0.0
            && self.dehaze == 0.0
    }
}

/// One brush stroke: polyline in normalised coords, size as a fraction of the
/// long edge, feather/flow 0..100. `erase` removes paint instead of adding.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Stroke {
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub size: f32,
    pub feather: f32,
    pub flow: f32,
    pub erase: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Mask {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub invert: bool,
    /// "linear" | "radial" | "brush" | "luminance" | "subject"
    pub kind: String,
    /// "add" (its own adjustments) or "subtract" (cuts out of the mask above)
    pub mode: String,
    /// 0..100 overall strength
    pub amount: f32,
    // linear gradient: full effect at (x0, y0), none beyond (x1, y1)
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    // radial: centre, radii (fraction of long edge), rotation deg, feather 0..100
    pub cx: f32,
    pub cy: f32,
    pub rx: f32,
    pub ry: f32,
    pub rotation: f32,
    pub feather: f32,
    // brush
    pub strokes: Vec<Stroke>,
    // luminance range on the globally developed image, 0..1, feather 0..1
    pub lum_lo: f32,
    pub lum_hi: f32,
    pub lum_feather: f32,
    /// subject: PNG data URL (grayscale) of the detected subject, any resolution
    pub raster: Option<String>,
    pub adjust: MaskAdjust,
}

impl Default for Mask {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            enabled: true,
            invert: false,
            kind: "linear".into(),
            mode: "add".into(),
            amount: 100.0,
            x0: 0.5,
            y0: 0.0,
            x1: 0.5,
            y1: 0.5,
            cx: 0.5,
            cy: 0.5,
            rx: 0.3,
            ry: 0.2,
            rotation: 0.0,
            feather: 50.0,
            strokes: Vec::new(),
            lum_lo: 0.0,
            lum_hi: 0.35,
            lum_feather: 0.15,
            raster: None,
            adjust: MaskAdjust::default(),
        }
    }
}

impl Mask {
    /// A mask that changes nothing can be skipped entirely. A subtract mask is
    /// judged by `cuts` instead: it has no adjustments to look at.
    pub fn is_active(&self) -> bool {
        self.enabled && self.amount > 0.0 && !self.adjust.is_zero()
    }

    /// Does this mask cut area out of the one above it rather than carry its
    /// own adjustments? Sidecars written before subtract masks existed have no
    /// `mode` at all, which reads as an ordinary mask.
    pub fn subtracts(&self) -> bool {
        self.mode == "subtract"
    }

    /// A subtract mask worth evaluating.
    pub fn cuts(&self) -> bool {
        self.subtracts() && self.enabled && self.amount > 0.0
    }
}

#[inline]
pub fn smooth01(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Luminance-range weight, shared with the shader: 1 inside [lo, hi],
/// feathered to 0 outside.
#[inline]
pub fn lum_weight(y: f32, lo: f32, hi: f32, feather: f32) -> f32 {
    let f = feather.max(0.005);
    let a = smooth01((y - (lo - f)) / f);
    let b = 1.0 - smooth01((y - hi) / f);
    (a * b).clamp(0.0, 1.0)
}

/// Linear gradient weight for a pixel centre (px, py) in image pixels.
#[inline]
pub fn linear_weight(m: &Mask, px: f32, py: f32, w: f32, h: f32) -> f32 {
    let ax = m.x0 * w;
    let ay = m.y0 * h;
    let dx = m.x1 * w - ax;
    let dy = m.y1 * h - ay;
    let len2 = dx * dx + dy * dy;
    if len2 < 1e-6 {
        return 1.0;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    1.0 - smooth01(t)
}

/// Radial (elliptical) weight: 1 inside, feathered edge, 0 outside.
#[inline]
pub fn radial_weight(m: &Mask, px: f32, py: f32, w: f32, h: f32) -> f32 {
    let long = w.max(h);
    let rx = (m.rx * long).max(1.0);
    let ry = (m.ry * long).max(1.0);
    let (s, c) = m.rotation.to_radians().sin_cos();
    let dx = px - m.cx * w;
    let dy = py - m.cy * h;
    let lx = dx * c + dy * s;
    let ly = -dx * s + dy * c;
    let e = ((lx / rx) * (lx / rx) + (ly / ry) * (ly / ry)).sqrt();
    let f = (m.feather / 100.0).clamp(0.01, 1.0);
    1.0 - smooth01((e - (1.0 - f)) / f)
}

/// Rasterise brush strokes at `w` x `h` (row-major, 0..1). Stamps are placed
/// along each polyline at a quarter of the brush radius, with the same math
/// as the interactive painter.
pub fn brush_raster(strokes: &[Stroke], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; w * h];
    let long = w.max(h) as f32;
    for s in strokes {
        let r = (s.size * long * 0.5).max(0.5);
        let hard = 1.0 - (s.feather / 100.0).clamp(0.0, 1.0);
        let flow = (s.flow / 100.0).clamp(0.0, 1.0);
        let spacing = (r * 0.25).max(0.5);
        let n = s.x.len().min(s.y.len());
        if n == 0 {
            continue;
        }
        let mut stamp = |cx: f32, cy: f32| {
            let x_lo = ((cx - r).floor().max(0.0)) as usize;
            let x_hi = ((cx + r).ceil().min(w as f32 - 1.0)) as usize;
            let y_lo = ((cy - r).floor().max(0.0)) as usize;
            let y_hi = ((cy + r).ceil().min(h as f32 - 1.0)) as usize;
            if x_lo > x_hi || y_lo > y_hi {
                return;
            }
            for y in y_lo..=y_hi {
                let dy = y as f32 + 0.5 - cy;
                for x in x_lo..=x_hi {
                    let dx = x as f32 + 0.5 - cx;
                    let d = (dx * dx + dy * dy).sqrt() / r;
                    if d >= 1.0 {
                        continue;
                    }
                    let soft = (1.0 - hard).max(0.01);
                    let v = flow * (1.0 - smooth01((d - hard) / soft));
                    let p = &mut out[y * w + x];
                    if s.erase {
                        *p *= 1.0 - v;
                    } else {
                        *p += v * (1.0 - *p);
                    }
                }
            }
        };
        let px = |i: usize| (s.x[i] * w as f32, s.y[i] * h as f32);
        let (mut lx, mut ly) = px(0);
        stamp(lx, ly);
        let mut carry = 0.0f32;
        for i in 1..n {
            let (nx, ny) = px(i);
            let seg = ((nx - lx).powi(2) + (ny - ly).powi(2)).sqrt();
            if seg <= 0.0 {
                continue;
            }
            let mut t = spacing - carry;
            while t <= seg {
                let k = t / seg;
                stamp(lx + (nx - lx) * k, ly + (ny - ly) * k);
                t += spacing;
            }
            carry = seg - (t - spacing);
            lx = nx;
            ly = ny;
        }
    }
    out
}

/// Decode a subject raster (PNG data URL or raw base64 PNG) to a grayscale 0..1 map.
pub fn decode_raster(data_url: &str) -> Option<(Vec<f32>, usize, usize)> {
    use base64::Engine;
    let b64 = data_url
        .rsplit_once(',')
        .map(|(_, b)| b)
        .unwrap_or(data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .ok()?;
    let img = image::load_from_memory(&bytes).ok()?.into_luma8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w == 0 || h == 0 {
        return None;
    }
    Some((
        img.into_raw()
            .into_iter()
            .map(|v| v as f32 / 255.0)
            .collect(),
        w,
        h,
    ))
}

/// Prepare one mask by id, together with its subtractions, whatever its
/// adjustments are. A mask used only as a shape - the one Motion Trails
/// streaks from - usually has none at all, so `is_active` would reject it.
pub fn prepare_named<'a>(masks: &'a [Mask], id: &str, w: usize, h: usize) -> Option<Prepared<'a>> {
    let (m, subs) = groups(masks)
        .into_iter()
        .find(|(m, _)| m.id == id && m.enabled && m.amount > 0.0)?;
    let mut p = build(m, w, h);
    p.subs = subs.into_iter().map(|s| build(s, w, h)).collect();
    Some(p)
}

/// The weight of one named mask over a whole `w` x `h` frame, 0..1 per pixel.
/// `luma` is the developed luminance, needed only by luminance masks; pass an
/// empty slice when there is none.
pub fn weight_map(masks: &[Mask], id: &str, w: usize, h: usize, luma: &[f32]) -> Option<Vec<f32>> {
    let p = prepare_named(masks, id, w, h)?;
    let mut out = vec![0.0f32; w * h];
    out.par_chunks_mut(w).enumerate().for_each(|(y, row)| {
        for (x, v) in row.iter_mut().enumerate() {
            let l = luma.get(y * w + x).copied().unwrap_or(0.0);
            *v = p.weight(x as f32 + 0.5, y as f32 + 0.5, l);
        }
    });
    Some(out)
}

/// Bilinear sample of a raster of size (rw, rh) at normalised (u, v).
#[inline]
pub fn sample_norm(r: &[f32], rw: usize, rh: usize, u: f32, v: f32) -> f32 {
    let fx = (u * rw as f32 - 0.5).clamp(0.0, rw as f32 - 1.0);
    let fy = (v * rh as f32 - 0.5).clamp(0.0, rh as f32 - 1.0);
    let x0 = fx.floor() as usize;
    let y0 = fy.floor() as usize;
    let x1 = (x0 + 1).min(rw - 1);
    let y1 = (y0 + 1).min(rh - 1);
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let a = r[y0 * rw + x0] * (1.0 - tx) + r[y0 * rw + x1] * tx;
    let b = r[y1 * rw + x0] * (1.0 - tx) + r[y1 * rw + x1] * tx;
    a * (1.0 - ty) + b * ty
}

/// A mask ready for per-pixel evaluation at a given output size.
pub struct Prepared<'a> {
    pub mask: &'a Mask,
    /// raster (brush / subject) at (rw, rh); None for analytic or luminance masks
    raster: Option<(Vec<f32>, usize, usize)>,
    w: f32,
    h: f32,
    /// masks that cut their area out of this one
    subs: Vec<Prepared<'a>>,
}

impl<'a> Prepared<'a> {
    pub fn needs_luma(&self) -> bool {
        self.mask.kind == "luminance" || self.subs.iter().any(|s| s.needs_luma())
    }

    /// Weight for the pixel centre (px, py); `luma` is the globally developed
    /// luminance (0..1) for luminance masks and ignored otherwise.
    #[inline]
    pub fn weight(&self, px: f32, py: f32, luma: f32) -> f32 {
        let m = self.mask;
        let raw = match m.kind.as_str() {
            "linear" => linear_weight(m, px, py, self.w, self.h),
            "radial" => radial_weight(m, px, py, self.w, self.h),
            "luminance" => lum_weight(luma, m.lum_lo, m.lum_hi, m.lum_feather),
            _ => match &self.raster {
                Some((r, rw, rh)) => sample_norm(r, *rw, *rh, px / self.w, py / self.h),
                None => 0.0,
            },
        };
        let v = if m.invert { 1.0 - raw } else { raw };
        let mut v = v * (m.amount / 100.0).clamp(0.0, 1.0);
        // each subtract mask takes its own share of what is left
        for s in &self.subs {
            if v <= 0.0 {
                break;
            }
            v *= 1.0 - s.weight(px, py, luma);
        }
        v
    }
}

/// Resolution used for rasterised masks on export: enough for soft edges,
/// small enough to stay cheap.
const RASTER_MAX_EDGE: usize = 2048;

fn build<'a>(m: &'a Mask, w: usize, h: usize) -> Prepared<'a> {
    let raster = match m.kind.as_str() {
        "brush" => {
            let scale = (RASTER_MAX_EDGE as f32 / w.max(h) as f32).min(1.0);
            let rw = ((w as f32 * scale).round() as usize).max(1);
            let rh = ((h as f32 * scale).round() as usize).max(1);
            Some((brush_raster(&m.strokes, rw, rh), rw, rh))
        }
        "subject" => m.raster.as_deref().and_then(decode_raster),
        _ => None,
    };
    Prepared {
        mask: m,
        raster,
        w: w as f32,
        h: h as f32,
        subs: Vec::new(),
    }
}

/// Each ordinary mask with the subtractions that belong to it. Grouping
/// happens before anything is rasterised, so a group whose head is dropped is
/// dropped whole and a subtraction never slides up onto an earlier mask.
fn groups<'a>(masks: &'a [Mask]) -> Vec<(&'a Mask, Vec<&'a Mask>)> {
    let mut groups: Vec<(&'a Mask, Vec<&'a Mask>)> = Vec::new();
    for m in masks {
        if m.subtracts() {
            // a subtraction with nothing above it has nothing to cut
            if let Some(g) = groups.last_mut() {
                if m.cuts() {
                    g.1.push(m);
                }
            }
        } else {
            groups.push((m, Vec::new()));
        }
    }
    groups
}

/// Prepare every active mask for an image of `w` x `h` pixels.
pub fn prepare<'a>(masks: &'a [Mask], w: usize, h: usize) -> Vec<Prepared<'a>> {
    groups(masks)
        .into_par_iter()
        .filter(|(m, _)| m.is_active())
        .map(|(m, subs)| {
            let mut p = build(m, w, h);
            p.subs = subs.into_iter().map(|s| build(s, w, h)).collect();
            p
        })
        .collect()
}
