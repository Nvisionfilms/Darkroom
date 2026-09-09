//! Geometry: lens corrections and the perspective transform, resolved into
//! one resampling step together with crop/straighten. CPU twin of the warp
//! in `PRESENT_FRAG` and of `src/geometry.ts`.
//!
//! Coordinates are normalised the lensfun/hugin way: the origin is the image
//! centre and r = 1 is half of the image diagonal. The mapping goes from
//! the *output* canvas to the *source* (inverse mapping), which is what a
//! resampler needs:
//!
//!   canvas px -> straighten -> transform (offset, scale, aspect, rotate,
//!   perspective) -> lens distortion (undistorted -> distorted radius) ->
//!   chromatic aberration (per-channel radial scale) -> source px

use serde::{Deserialize, Serialize};

/// Perspective / geometry sliders, Lightroom-style, all -100..100 except rotate (deg).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Transform {
    pub vertical: f32,
    pub horizontal: f32,
    pub rotate: f32,
    /// -100..100, 0 = 100 %
    pub scale: f32,
    pub aspect: f32,
    pub x: f32,
    pub y: f32,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            vertical: 0.0,
            horizontal: 0.0,
            rotate: 0.0,
            scale: 0.0,
            aspect: 0.0,
            x: 0.0,
            y: 0.0,
        }
    }
}

impl Transform {
    pub fn is_identity(&self) -> bool {
        self.vertical == 0.0
            && self.horizontal == 0.0
            && self.rotate == 0.0
            && self.scale == 0.0
            && self.aspect == 0.0
            && self.x == 0.0
            && self.y == 0.0
    }
}

/// Lens correction settings. `profile` uses the calibration looked up for
/// the photo (see lensdb.rs); the manual sliders add to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Lens {
    pub profile: bool,
    /// 0..100 how much of the profile's distortion correction to apply
    pub distortion_amount: f32,
    /// 0..100 how much of the profile's vignetting correction to apply
    pub vignette_amount: f32,
    /// apply the profile's chromatic aberration correction
    pub ca: bool,
    /// -100..100 manual barrel (+) / pincushion (-) correction
    pub manual_distortion: f32,
    /// -100..100 manual corner brightening (+) / darkening (-)
    pub manual_vignette: f32,
    /// 0..100 where the manual vignette starts
    pub manual_vignette_mid: f32,
    /// -100..100 manual red/cyan fringe
    pub manual_ca_r: f32,
    /// -100..100 manual blue/yellow fringe
    pub manual_ca_b: f32,
}

impl Default for Lens {
    fn default() -> Self {
        Self {
            profile: true,
            distortion_amount: 100.0,
            vignette_amount: 100.0,
            ca: true,
            manual_distortion: 0.0,
            manual_vignette: 0.0,
            manual_vignette_mid: 50.0,
            manual_ca_r: 0.0,
            manual_ca_b: 0.0,
        }
    }
}

/// Calibration resolved for one photo from the lens database, in the
/// database's own normalised coordinates (see `crop_scale`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LensProfile {
    pub name: String,
    /// 0 none, 1 ptlens (a, b, c), 2 poly3 (k1), 3 poly5 (k1, k2)
    pub dist_model: u8,
    pub dist: [f32; 3],
    /// "pa" vignetting model k1..k3 (I = I0 (1 + k1 r² + k2 r⁴ + k3 r⁶)); all zero = none
    pub vig: [f32; 3],
    /// linear TCA: red / blue radial scale, 1.0 = none
    pub tca: [f32; 2],
    /// r_calibration = r_camera * crop_scale (calibration crop / camera crop)
    pub crop_scale: f32,
}

impl LensProfile {
    pub fn has_distortion(&self) -> bool {
        self.dist_model != 0
    }
    pub fn has_vignetting(&self) -> bool {
        self.vig != [0.0; 3]
    }
    pub fn has_tca(&self) -> bool {
        self.tca[0] != 0.0 && self.tca[1] != 0.0 && (self.tca[0] != 1.0 || self.tca[1] != 1.0)
    }
}

pub const PERSPECTIVE_K: f32 = 0.9;
pub const MANUAL_DISTORTION_K: f32 = 0.8;
pub const MANUAL_CA_K: f32 = 0.005;

#[inline]
fn smooth01(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Everything the per-pixel warp needs, in pixel / normalised units.
#[derive(Debug, Clone)]
pub struct Warp {
    pub w: f32,
    pub h: f32,
    pub cx: f32,
    pub cy: f32,
    /// half the image diagonal (r = 1)
    pub hs: f32,
    // transform
    pub ox: f32,
    pub oy: f32,
    pub inv_scale: f32,
    pub ax: f32,
    pub ay: f32,
    pub cos_r: f32,
    pub sin_r: f32,
    pub ph: f32,
    pub pv: f32,
    pub transform_on: bool,
    // distortion
    pub dist_model: u8,
    pub dist: [f32; 3],
    pub dist_amount: f32,
    pub cs: f32,
    pub km: f32,
    pub tca_r: f32,
    pub tca_b: f32,
    // vignetting
    pub vig: [f32; 3],
    pub vig_amount: f32,
    pub mv: f32,
    pub mv_start: f32,
    pub rmax: f32,
}

impl Warp {
    pub fn new(t: &Transform, l: &Lens, profile: Option<&LensProfile>, w: usize, h: usize) -> Self {
        let (wf, hf) = (w as f32, h as f32);
        // lensfun calibrations are normalised so that r = 1 at half the image
        // diagonal; using half the short side instead makes the vignetting
        // polynomial diverge past the frame edges.
        let hs = ((wf * wf + hf * hf).sqrt() / 2.0).max(1.0);
        let rot = t.rotate.to_radians();
        let a = t.aspect / 100.0;
        let use_prof = l.profile && profile.is_some();
        let p = profile.cloned().unwrap_or_default();
        let dist_on = use_prof && p.has_distortion() && l.distortion_amount > 0.0;
        let tca_on = use_prof && l.ca && p.has_tca();
        let vig_on = use_prof && p.has_vignetting() && l.vignette_amount > 0.0;
        let cs = if use_prof && p.crop_scale > 0.0 { p.crop_scale } else { 1.0 };
        Self {
            w: wf,
            h: hf,
            cx: wf / 2.0,
            cy: hf / 2.0,
            hs,
            ox: t.x / 100.0 * (wf / (2.0 * hs)),
            oy: t.y / 100.0 * (hf / (2.0 * hs)),
            inv_scale: 1.0 / (1.0 + t.scale / 100.0).max(0.2),
            ax: (0.4 * a).exp(),
            ay: (-0.4 * a).exp(),
            cos_r: rot.cos(),
            sin_r: rot.sin(),
            ph: t.horizontal / 100.0 * PERSPECTIVE_K,
            pv: -t.vertical / 100.0 * PERSPECTIVE_K,
            transform_on: !t.is_identity(),
            dist_model: if dist_on { p.dist_model } else { 0 },
            dist: p.dist,
            dist_amount: (l.distortion_amount / 100.0).clamp(0.0, 1.0),
            cs,
            km: l.manual_distortion / 100.0 * MANUAL_DISTORTION_K,
            tca_r: (if tca_on { p.tca[0] } else { 1.0 }) * (1.0 + l.manual_ca_r / 100.0 * MANUAL_CA_K),
            tca_b: (if tca_on { p.tca[1] } else { 1.0 }) * (1.0 + l.manual_ca_b / 100.0 * MANUAL_CA_K),
            vig: if vig_on { p.vig } else { [0.0; 3] },
            vig_amount: (l.vignette_amount / 100.0).clamp(0.0, 1.0),
            mv: l.manual_vignette / 100.0,
            mv_start: (l.manual_vignette_mid / 100.0).clamp(0.0, 1.0),
            rmax: ((wf / (2.0 * hs)).powi(2) + (hf / (2.0 * hs)).powi(2)).sqrt(),
        }
    }

    /// True when the resampling step can be skipped entirely.
    pub fn is_identity(&self) -> bool {
        !self.transform_on && self.dist_model == 0 && self.km == 0.0 && self.tca_r == 1.0 && self.tca_b == 1.0
    }

    pub fn has_vignette(&self) -> bool {
        self.vig != [0.0; 3] || self.mv != 0.0
    }

    /// Distorted radius for an undistorted radius (camera-normalised units).
    #[inline]
    pub fn distort_radius(&self, r: f32) -> f32 {
        let mut rd = r;
        if self.dist_model != 0 {
            let rc = r * self.cs;
            let [a, b, c] = self.dist;
            let f = match self.dist_model {
                1 => rc * (a * rc * rc * rc + b * rc * rc + c * rc + 1.0 - a - b - c),
                2 => rc * (1.0 - a + a * rc * rc),
                _ => rc * (1.0 + a * rc * rc + b * rc * rc * rc * rc),
            };
            rd = r + self.dist_amount * (f / self.cs - r);
        }
        if self.km != 0.0 {
            rd *= 1.0 + self.km * rd * rd;
        }
        rd
    }

    /// Canvas pixel centre -> source position (green channel) in normalised units.
    #[inline]
    pub fn map_norm(&self, x: f32, y: f32) -> (f32, f32) {
        let mut px = (x - self.cx) / self.hs;
        let mut py = (y - self.cy) / self.hs;
        if self.transform_on {
            px -= self.ox;
            py -= self.oy;
            px *= self.inv_scale;
            py *= self.inv_scale;
            px /= self.ax;
            py /= self.ay;
            let (rx, ry) = (self.cos_r * px - self.sin_r * py, self.sin_r * px + self.cos_r * py);
            let wq = (1.0 + self.ph * rx + self.pv * ry).max(0.05);
            px = rx / wq;
            py = ry / wq;
        }
        let r = (px * px + py * py).sqrt();
        if r > 1e-6 {
            let k = self.distort_radius(r) / r;
            px *= k;
            py *= k;
        }
        (px, py)
    }

    /// Canvas pixel centre -> source pixel positions for r, g, b.
    #[inline]
    pub fn map_rgb(&self, x: f32, y: f32) -> [(f32, f32); 3] {
        let (px, py) = self.map_norm(x, y);
        let to_px = |k: f32| (self.cx + px * k * self.hs, self.cy + py * k * self.hs);
        [to_px(self.tca_r), to_px(1.0), to_px(self.tca_b)]
    }

    /// Brightness gain at a *source* pixel centre (vignetting correction).
    #[inline]
    pub fn vignette_gain(&self, x: f32, y: f32) -> f32 {
        let dx = (x - self.cx) / self.hs;
        let dy = (y - self.cy) / self.hs;
        let r2 = dx * dx + dy * dy;
        let mut g = 1.0;
        if self.vig != [0.0; 3] {
            let rc2 = r2 * self.cs * self.cs;
            let [k1, k2, k3] = self.vig;
            let f = 1.0 + k1 * rc2 + k2 * rc2 * rc2 + k3 * rc2 * rc2 * rc2;
            let corr = 1.0 / f.clamp(0.05, 20.0);
            g *= 1.0 + self.vig_amount * (corr - 1.0);
        }
        if self.mv != 0.0 {
            let r = r2.sqrt();
            g *= 1.0 + self.mv * smooth01((r - self.mv_start) / (self.rmax - self.mv_start).max(1e-3));
        }
        g.max(0.0)
    }
}

#[inline]
fn sample_channel(img: &[f32], width: usize, height: usize, x: f32, y: f32, c: usize) -> Option<f32> {
    let (wf, hf) = (width as f32, height as f32);
    if x < 0.0 || y < 0.0 || x >= wf || y >= hf {
        return None;
    }
    let fx = (x - 0.5).clamp(0.0, wf - 1.0);
    let fy = (y - 0.5).clamp(0.0, hf - 1.0);
    let x0 = fx.floor() as usize;
    let y0 = fy.floor() as usize;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let p = |xx: usize, yy: usize| img[(yy * width + xx) * 3 + c];
    let a = p(x0, y0) * (1.0 - tx) + p(x1, y0) * tx;
    let b = p(x0, y1) * (1.0 - tx) + p(x1, y1) * tx;
    Some(a * (1.0 - ty) + b * ty)
}

/// Crop + straighten + transform + lens distortion/CA in one resample of a
/// developed (display-space) buffer. Returns (data, width, height).
/// Replaces `pipeline::crop_pass`; pixels that fall outside the source are black.
pub fn geometry_pass(
    img: &[f32],
    width: usize,
    height: usize,
    crop: &crate::pipeline::Crop,
    warp: &Warp,
) -> (Vec<f32>, usize, usize) {
    use rayon::prelude::*;
    if crop.is_identity() && warp.is_identity() {
        return (img.to_vec(), width, height);
    }
    let (wf, hf) = (width as f32, height as f32);
    let (ow, oh, x0, y0, ang) = if crop.is_identity() {
        (width, height, 0.0, 0.0, 0.0)
    } else {
        (
            ((crop.w.clamp(0.01, 1.0) * wf).round() as usize).max(1),
            ((crop.h.clamp(0.01, 1.0) * hf).round() as usize).max(1),
            crop.x.clamp(0.0, 1.0) * wf,
            crop.y.clamp(0.0, 1.0) * hf,
            crop.angle.to_radians(),
        )
    };
    let (cx, cy) = (wf / 2.0, hf / 2.0);
    let (ca, sa) = (ang.cos(), ang.sin());
    let mut out = vec![0.0f32; ow * oh * 3];
    out.par_chunks_mut(ow * 3).enumerate().for_each(|(oy, row)| {
        let sy = y0 + oy as f32 + 0.5 - cy;
        for ox in 0..ow {
            let sx = x0 + ox as f32 + 0.5 - cx;
            // straightened canvas -> canvas (rotate about the centre)
            let px = cx + ca * sx - sa * sy;
            let py = cy + sa * sx + ca * sy;
            let pos = warp.map_rgb(px, py);
            for c in 0..3 {
                if let Some(v) = sample_channel(img, width, height, pos[c].0, pos[c].1, c) {
                    row[ox * 3 + c] = v;
                }
            }
        }
    });
    (out, ow, oh)
}

/// Forward mapping (source -> canvas) by numeric inversion; used by tests
/// and mirrored in TypeScript for the on-screen handles.
pub fn source_to_canvas(warp: &Warp, sx: f32, sy: f32) -> (f32, f32) {
    // undo TCA is not needed for the green channel; undo distortion by Newton on r
    let mut px = (sx - warp.cx) / warp.hs;
    let mut py = (sy - warp.cy) / warp.hs;
    let rd = (px * px + py * py).sqrt();
    if rd > 1e-6 {
        let mut r = rd;
        for _ in 0..8 {
            let f = warp.distort_radius(r) - rd;
            let d = (warp.distort_radius(r + 1e-3) - warp.distort_radius(r - 1e-3)) / 2e-3;
            if d.abs() < 1e-6 {
                break;
            }
            r -= f / d;
        }
        let k = r / rd;
        px *= k;
        py *= k;
    }
    if warp.transform_on {
        // invert perspective: p' = p / (1 + ph px + pv py)  =>  p = p' / (1 - ph p'x - pv p'y)
        let den = (1.0 - warp.ph * px - warp.pv * py).max(0.05);
        px /= den;
        py /= den;
        let (rx, ry) = (warp.cos_r * px + warp.sin_r * py, -warp.sin_r * px + warp.cos_r * py);
        px = rx * warp.ax / warp.inv_scale + warp.ox;
        py = ry * warp.ay / warp.inv_scale + warp.oy;
    }
    (warp.cx + px * warp.hs, warp.cy + py * warp.hs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let t = Transform {
            vertical: 40.0,
            horizontal: -20.0,
            rotate: 5.0,
            scale: 10.0,
            aspect: 15.0,
            x: 5.0,
            y: -3.0,
        };
        let l = Lens {
            manual_distortion: 30.0,
            ..Default::default()
        };
        let w = Warp::new(&t, &l, None, 600, 400);
        for &(x, y) in &[(300.0, 200.0), (100.0, 50.0), (550.0, 380.0)] {
            let (px, py) = w.map_norm(x, y);
            let (sx, sy) = (w.cx + px * w.hs, w.cy + py * w.hs);
            let (bx, by) = source_to_canvas(&w, sx, sy);
            assert!((bx - x).abs() < 0.05 && (by - y).abs() < 0.05, "{x},{y} -> {bx},{by}");
        }
    }
}
