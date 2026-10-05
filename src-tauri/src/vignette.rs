//! Vignette: darken or lighten the picture towards its corners.
//!
//! It is measured against the cropped frame, not the original, for the same
//! reason the watermark is: it belongs to the picture you end up with. Crop in
//! and the vignette follows the new edges rather than staying where the corners
//! used to be.
//!
//! The shape is the ellipse inscribed in that frame, so it fits a portrait and
//! a landscape alike without being told which it is.
//!
//! Twin of the vignette block in `src/gl/shaders.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Vignette {
    pub enabled: bool,
    /// -100 darkens the corners, +100 lightens them towards white
    pub amount: f32,
    /// 0..100: how far out it starts, as a share of the way to the corner
    pub midpoint: f32,
    /// 0..100 how gradually it comes on
    pub feather: f32,
    /// 0..100
    pub opacity: f32,
}

impl Default for Vignette {
    fn default() -> Self {
        Self {
            enabled: false,
            amount: -35.0,
            midpoint: 50.0,
            feather: 50.0,
            opacity: 100.0,
        }
    }
}

impl Vignette {
    pub fn is_active(&self) -> bool {
        self.enabled && self.amount != 0.0 && self.opacity > 0.0
    }
}

/// Narrowest and widest the ramp can be, as a share of the way to the corner.
pub const FEATHER_MIN: f32 = 0.04;
pub const FEATHER_MAX: f32 = 0.60;

/// How strongly the corners are touched at a point, 0 at the middle and 1 at
/// the far corner. `u` and `v` are the place in the frame, 0..1.
#[inline]
pub fn falloff(u: f32, v: f32, vg: &Vignette) -> f32 {
    // the ellipse inscribed in the frame: 0 in the middle, 1 at every corner
    let dx = (u - 0.5) * 2.0;
    let dy = (v - 0.5) * 2.0;
    let r = (dx * dx + dy * dy).sqrt() / std::f32::consts::SQRT_2;
    let mid = (vg.midpoint / 100.0).clamp(0.0, 1.0);
    let half = FEATHER_MIN + (vg.feather / 100.0).clamp(0.0, 1.0) * (FEATHER_MAX - FEATHER_MIN);
    let t = ((r - (mid - half)) / (2.0 * half)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The vignette over one developed pixel, display-referred 0..1.
#[inline]
pub fn apply_pixel(rgb: [f32; 3], u: f32, v: f32, vg: &Vignette) -> [f32; 3] {
    let k = (vg.amount / 100.0).clamp(-1.0, 1.0) * (vg.opacity / 100.0).clamp(0.0, 1.0);
    if k == 0.0 {
        return rgb;
    }
    let f = falloff(u, v, vg) * k;
    let mut out = rgb;
    for c in 0..3 {
        // towards black one way and towards white the other, so neither end
        // can overshoot however far the slider is pushed
        out[c] = if f < 0.0 {
            (rgb[c] * (1.0 + f)).clamp(0.0, 1.0)
        } else {
            (rgb[c] + (1.0 - rgb[c]) * f).clamp(0.0, 1.0)
        };
    }
    out
}

/// Apply to a whole developed frame in place.
pub fn apply(img: &mut [f32], width: usize, height: usize, vg: &Vignette) {
    if !vg.is_active() || width == 0 || height == 0 {
        return;
    }
    use rayon::prelude::*;
    img.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
        let v = (y as f32 + 0.5) / height as f32;
        for x in 0..width {
            let u = (x as f32 + 0.5) / width as f32;
            let p = [row[x * 3], row[x * 3 + 1], row[x * 3 + 2]];
            let o = apply_pixel(p, u, v, vg);
            row[x * 3..x * 3 + 3].copy_from_slice(&o);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 120;
    const H: usize = 80;

    fn flat() -> Vec<f32> {
        vec![0.5f32; W * H * 3]
    }

    fn at(v: &[f32], x: usize, y: usize) -> f32 {
        v[(y * W + x) * 3 + 1]
    }

    fn dark() -> Vignette {
        Vignette {
            enabled: true,
            amount: -100.0,
            midpoint: 50.0,
            feather: 50.0,
            opacity: 100.0,
        }
    }

    #[test]
    fn the_middle_is_left_alone_and_the_corners_are_not() {
        let mut v = flat();
        apply(&mut v, W, H, &dark());
        let centre = at(&v, W / 2, H / 2);
        assert!((centre - 0.5).abs() < 1e-4, "the middle was darkened: {centre}");
        for (x, y) in [(1usize, 1usize), (W - 2, 1), (1, H - 2), (W - 2, H - 2)] {
            assert!(at(&v, x, y) < 0.2, "the corner at ({x}, {y}) was not darkened: {}", at(&v, x, y));
        }
    }

    /// Left is dark and right is white, as the slider reads.
    #[test]
    fn the_sign_decides_which_way_the_corners_go() {
        let mut d = flat();
        apply(&mut d, W, H, &dark());
        let mut l = flat();
        apply(&mut l, W, H, &Vignette { amount: 100.0, ..dark() });
        assert!(at(&d, 1, 1) < 0.5, "a negative amount should darken");
        assert!(at(&l, 1, 1) > 0.5, "a positive amount should lighten");
        // and neither end can overshoot
        for v in d.iter().chain(l.iter()) {
            assert!((0.0..=1.0).contains(v), "the vignette left 0..1: {v}");
        }
    }

    /// It belongs to the frame it is applied to, whatever shape that frame is.
    #[test]
    fn it_fits_the_frame_it_is_given() {
        // the same settings on a wide frame and a tall one must darken the
        // corners of each by the same amount - the shape follows the frame
        let mut wide = vec![0.5f32; 160 * 90 * 3];
        apply(&mut wide, 160, 90, &dark());
        let mut tall = vec![0.5f32; 90 * 160 * 3];
        apply(&mut tall, 90, 160, &dark());
        let wc = wide[(1 * 160 + 1) * 3 + 1];
        let tc = tall[(1 * 90 + 1) * 3 + 1];
        assert!((wc - tc).abs() < 0.02, "the corners differ by frame shape: {wc} against {tc}");
    }

    #[test]
    fn midpoint_decides_how_far_in_it_reaches() {
        let mut near = flat();
        apply(&mut near, W, H, &Vignette { midpoint: 10.0, ..dark() });
        let mut far = flat();
        apply(&mut far, W, H, &Vignette { midpoint: 90.0, ..dark() });
        // a third of the way out from the middle
        let (x, y) = (W / 2 + W / 6, H / 2);
        assert!(at(&near, x, y) < at(&far, x, y) - 0.1, "midpoint did not move the edge of it");
    }

    #[test]
    fn switched_off_it_changes_nothing() {
        let before = flat();
        let mut v = before.clone();
        apply(&mut v, W, H, &Vignette { enabled: false, ..dark() });
        assert_eq!(v, before);
        let mut z = before.clone();
        apply(&mut z, W, H, &Vignette { amount: 0.0, ..dark() });
        assert_eq!(z, before);
    }
}
