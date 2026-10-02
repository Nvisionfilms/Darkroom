//! Cross-screen ("starburst") lens filter.
//!
//! A real cross-screen filter is a sheet of glass with fine grooves ruled
//! across it. Light from a small bright source is diffracted along the grooves,
//! so every highlight grows a star: one line of light per groove direction,
//! brightest at the source and fading out, and spread into colour at the far
//! end because the diffraction angle depends on wavelength.
//!
//! That is what this does, and nothing more: the highlights already in the
//! picture are smeared along a few directions and added back. No light is
//! invented and nothing is generated - a frame with no highlights above the
//! threshold comes out untouched.
//!
//! The work happens on a quarter-resolution highlight map. Streaks are smooth
//! and wide, so they survive that perfectly well, and it keeps the cost of 12
//! directions x 24 samples off the full-resolution image.
//!
//! Twin of the star block in `src/gl/shaders.ts`.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::color::LUMA_709;

/// Samples taken along each half-line. Fixed so the GPU can unroll it and so
/// both pipelines land on the same numbers.
pub const SAMPLES: usize = 24;

/// Longest streak, as a fraction of the long edge at `length` = 100.
pub const MAX_LENGTH: f32 = 0.25;

/// Streak brightness at `amount` = 100.
pub const MAX_GAIN: f32 = 8.0;

/// How far dispersion pulls red and blue apart, as a fraction of the offset.
pub const MAX_DISPERSION: f32 = 0.08;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Star {
    pub enabled: bool,
    /// 0..100 streak brightness
    pub amount: f32,
    /// points on the star: 4 is the classic cross-screen, up to 12
    pub points: u32,
    /// 0..100 streak length, as a share of `MAX_LENGTH` of the long edge
    pub length: f32,
    /// rotation of the whole star, degrees
    pub angle: f32,
    /// 0..100 how bright a pixel has to be before it stars at all
    pub threshold: f32,
    /// 0..100 how quickly the streak fades along its length
    pub falloff: f32,
    /// 0..100 rainbow spread towards the ends of the streaks
    pub dispersion: f32,
}

impl Default for Star {
    fn default() -> Self {
        Self {
            enabled: false,
            amount: 60.0,
            points: 4,
            length: 35.0,
            angle: 0.0,
            threshold: 75.0,
            falloff: 40.0,
            dispersion: 25.0,
        }
    }
}

impl Star {
    pub fn is_active(&self) -> bool {
        self.enabled && self.amount > 0.0 && self.length > 0.0
    }

    /// Lines of light. A star has two points per groove direction.
    pub fn lines(&self) -> usize {
        (self.points.clamp(2, 12) as usize / 2).max(1)
    }

    pub fn gain(&self) -> f32 {
        (self.amount / 100.0).clamp(0.0, 1.0) * MAX_GAIN
    }

    /// Streak half-length in pixels on an image whose long edge is `long`.
    pub fn len_px(&self, long: f32) -> f32 {
        (self.length / 100.0).clamp(0.0, 1.0) * MAX_LENGTH * long
    }

    /// Exponent of the (1 - t) fade. Low falloff = long even streak, high
    /// falloff = a short sharp spike.
    pub fn fade_exp(&self) -> f32 {
        0.5 + (self.falloff / 100.0).clamp(0.0, 1.0) * 3.5
    }

    pub fn dispersion01(&self) -> f32 {
        (self.dispersion / 100.0).clamp(0.0, 1.0) * MAX_DISPERSION
    }
}

/// How much of a developed pixel is "highlight", and in what colour. Squared so
/// the brightest parts of the picture dominate the way diffraction does.
#[inline]
pub fn highlight(rgb: [f32; 3], threshold: f32) -> [f32; 3] {
    let y = rgb[0] * LUMA_709[0] + rgb[1] * LUMA_709[1] + rgb[2] * LUMA_709[2];
    let t = ((y - threshold) / (1.0 - threshold).max(1e-3)).clamp(0.0, 1.0);
    if t <= 0.0 {
        return [0.0; 3];
    }
    let k = t * t;
    // keep the highlight's own colour: a tungsten lamp stars warm
    if y > 1e-4 {
        [rgb[0] / y * k, rgb[1] / y * k, rgb[2] / y * k]
    } else {
        [k, k, k]
    }
}

/// Quarter-resolution highlight map: a 4x4 box average of the picture, turned
/// into highlights. The GPU reads mip level 2 of the same picture, which is the
/// same average.
fn highlight_map(
    img: &[f32],
    width: usize,
    height: usize,
    threshold: f32,
) -> (Vec<f32>, usize, usize) {
    let qw = (width / 4).max(1);
    let qh = (height / 4).max(1);
    let mut out = vec![0.0f32; qw * qh * 3];
    out.par_chunks_mut(qw * 3)
        .enumerate()
        .for_each(|(qy, row)| {
            for qx in 0..qw {
                let mut sum = [0.0f32; 3];
                let mut n = 0.0f32;
                for dy in 0..4 {
                    let y = qy * 4 + dy;
                    if y >= height {
                        break;
                    }
                    for dx in 0..4 {
                        let x = qx * 4 + dx;
                        if x >= width {
                            break;
                        }
                        let i = (y * width + x) * 3;
                        sum[0] += img[i];
                        sum[1] += img[i + 1];
                        sum[2] += img[i + 2];
                        n += 1.0;
                    }
                }
                let avg = if n > 0.0 {
                    [sum[0] / n, sum[1] / n, sum[2] / n]
                } else {
                    [0.0; 3]
                };
                row[qx * 3..qx * 3 + 3].copy_from_slice(&highlight(avg, threshold));
            }
        });
    (out, qw, qh)
}

/// Bilinear sample of an interleaved RGB map, clamped at the edges. `x` and `y`
/// are in that map's own pixels.
#[inline]
fn sample(map: &[f32], w: usize, h: usize, x: f32, y: f32) -> [f32; 3] {
    let fx = x.clamp(0.0, w as f32 - 1.0);
    let fy = y.clamp(0.0, h as f32 - 1.0);
    let x0 = fx.floor() as usize;
    let y0 = fy.floor() as usize;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let mut o = [0.0f32; 3];
    for c in 0..3 {
        let a = map[(y0 * w + x0) * 3 + c] * (1.0 - tx) + map[(y0 * w + x1) * 3 + c] * tx;
        let b = map[(y1 * w + x0) * 3 + c] * (1.0 - tx) + map[(y1 * w + x1) * 3 + c] * tx;
        o[c] = a * (1.0 - ty) + b * ty;
    }
    o
}

/// The streak map, at the highlight map's own resolution. Each pixel collects
/// the highlights that lie along the star's lines through it.
fn streak_map(hi: &[f32], qw: usize, qh: usize, s: &Star, len_q: f32) -> Vec<f32> {
    let lines = s.lines();
    let exp = s.fade_exp();
    let disp = s.dispersion01();
    let a0 = s.angle.to_radians();
    let dirs: Vec<(f32, f32)> = (0..lines)
        .map(|l| {
            let th = a0 + std::f32::consts::PI * l as f32 / lines as f32;
            (th.cos(), th.sin())
        })
        .collect();

    let mut out = vec![0.0f32; qw * qh * 3];
    out.par_chunks_mut(qw * 3).enumerate().for_each(|(y, row)| {
        let py = y as f32 + 0.5;
        for x in 0..qw {
            let px = x as f32 + 0.5;
            let mut acc = [0.0f32; 3];
            let mut wsum = 0.0f32;
            for (dx, dy) in &dirs {
                for i in 1..=SAMPLES {
                    let t = i as f32 / SAMPLES as f32;
                    // held off zero to match the GLSL, which cannot use
                    // pow(0, y): a driver computing it as exp2(y * log2(x))
                    // returns NaN there and the whole sum goes with it
                    let w = (1.0 - t).max(1e-6).powf(exp);
                    let d = t * len_q;
                    // the red end of the spectrum is bent further than the blue
                    let (ox, oy) = (dx * d, dy * d);
                    let (rx, ry) = (ox * (1.0 + disp), oy * (1.0 + disp));
                    let (bx, by) = (ox * (1.0 - disp), oy * (1.0 - disp));
                    let fwd = [
                        sample(hi, qw, qh, px + rx, py + ry)[0],
                        sample(hi, qw, qh, px + ox, py + oy)[1],
                        sample(hi, qw, qh, px + bx, py + by)[2],
                    ];
                    let back = [
                        sample(hi, qw, qh, px - rx, py - ry)[0],
                        sample(hi, qw, qh, px - ox, py - oy)[1],
                        sample(hi, qw, qh, px - bx, py - by)[2],
                    ];
                    for c in 0..3 {
                        acc[c] += (fwd[c] + back[c]) * w;
                    }
                    wsum += 2.0 * w;
                }
            }
            let k = if wsum > 0.0 { 1.0 / wsum } else { 0.0 };
            for c in 0..3 {
                row[x * 3 + c] = acc[c] * k;
            }
        }
    });
    out
}

/// Add the star to a developed (display-space, 0..1) buffer.
pub fn apply(img: &[f32], width: usize, height: usize, s: &Star) -> Vec<f32> {
    if !s.is_active() || width < 4 || height < 4 {
        return img.to_vec();
    }
    let threshold = (s.threshold / 100.0).clamp(0.0, 0.999);
    let (hi, qw, qh) = highlight_map(img, width, height, threshold);
    let long = width.max(height) as f32;
    let len_q = s.len_px(long) / 4.0;
    if len_q < 0.25 {
        return img.to_vec();
    }
    let streak = streak_map(&hi, qw, qh, s, len_q);
    let gain = s.gain();

    let mut out = img.to_vec();
    out.par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            let qy = (y as f32 + 0.5) / 4.0 - 0.5;
            for x in 0..width {
                let qx = (x as f32 + 0.5) / 4.0 - 0.5;
                let st = sample(&streak, qw, qh, qx, qy);
                for c in 0..3 {
                    let v = (st[c] * gain).clamp(0.0, 1.0);
                    // left strictly alone where there is no star, so a frame with
                    // no highlights comes back bit for bit
                    if v <= 0.0 {
                        continue;
                    }
                    // screen: the star brightens what is under it without ever
                    // pushing it past white
                    let d = row[x * 3 + c].clamp(0.0, 1.0);
                    row[x * 3 + c] = 1.0 - (1.0 - d) * (1.0 - v);
                }
            }
        });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 96;
    const H: usize = 64;

    /// Black frame with a bright square in the middle.
    fn blob() -> Vec<f32> {
        let mut img = vec![0.0f32; W * H * 3];
        for y in 26..38 {
            for x in 42..54 {
                for c in 0..3 {
                    img[(y * W + x) * 3 + c] = 1.0;
                }
            }
        }
        img
    }

    fn at(v: &[f32], x: usize, y: usize) -> f32 {
        v[(y * W + x) * 3 + 1]
    }

    fn cross() -> Star {
        Star {
            enabled: true,
            amount: 100.0,
            points: 4,
            length: 100.0,
            angle: 0.0,
            threshold: 50.0,
            falloff: 20.0,
            dispersion: 0.0,
        }
    }

    #[test]
    fn a_disabled_filter_changes_nothing() {
        let img = blob();
        assert_eq!(apply(&img, W, H, &Star::default()), img);
        let off = Star {
            enabled: true,
            amount: 0.0,
            ..cross()
        };
        assert_eq!(apply(&img, W, H, &off), img);
    }

    #[test]
    fn a_four_point_star_runs_along_its_own_axes() {
        let img = blob();
        let out = apply(&img, W, H, &cross());
        // along the horizontal arm, clear of the blob
        let arm = at(&out, 64, 32);
        // the same distance away but off both arms
        let gap = at(&out, 64, 20);
        assert!(arm > 0.02, "the horizontal arm is missing: {arm}");
        assert!(
            arm > gap * 4.0,
            "the star is not directional: arm {arm} vs gap {gap}"
        );
        // and the vertical arm is there too
        let up = at(&out, 48, 14);
        assert!(up > 0.02, "the vertical arm is missing: {up}");
    }

    #[test]
    fn rotating_the_star_moves_its_arms() {
        let img = blob();
        let flat = apply(&img, W, H, &cross());
        let tilted = apply(
            &img,
            W,
            H,
            &Star {
                angle: 45.0,
                ..cross()
            },
        );
        // a point up and to the right of the blob is on the tilted arm, not the flat one
        let p = (64, 16);
        assert!(
            at(&tilted, p.0, p.1) > at(&flat, p.0, p.1) * 2.0 + 0.01,
            "rotation did not move the arms: {} vs {}",
            at(&tilted, p.0, p.1),
            at(&flat, p.0, p.1)
        );
    }

    #[test]
    fn nothing_bright_enough_means_no_star() {
        // a mid-grey frame under a high threshold has no highlights to smear
        let img = vec![0.4f32; W * H * 3];
        let s = Star {
            threshold: 90.0,
            ..cross()
        };
        assert_eq!(apply(&img, W, H, &s), img);
    }

    #[test]
    fn dispersion_colours_the_ends_of_the_arms() {
        let img = blob();
        let plain = apply(&img, W, H, &cross());
        let rainbow = apply(
            &img,
            W,
            H,
            &Star {
                dispersion: 100.0,
                ..cross()
            },
        );
        // the widest red/blue separation anywhere along the right-hand arm
        let split = |v: &[f32]| {
            let mut m = 0.0f32;
            for x in 54..W {
                let i = (32 * W + x) * 3;
                m = m.max((v[i] - v[i + 2]).abs());
            }
            m
        };
        // a neutral blob stays neutral without dispersion, and separates with it
        assert!(
            split(&plain) < 1e-5,
            "the plain star tinted: {}",
            split(&plain)
        );
        assert!(
            split(&rainbow) > 0.005,
            "dispersion did nothing: {}",
            split(&rainbow)
        );
    }

    #[test]
    fn the_star_is_the_same_every_render() {
        let img = blob();
        let s = cross();
        assert_eq!(apply(&img, W, H, &s), apply(&img, W, H, &s));
    }
}
