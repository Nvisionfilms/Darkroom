//! Film grain.
//!
//! Grain has to land in exactly the same places in the preview and in the
//! export, so it cannot come from a random number generator: it is a hash of
//! the pixel's position, which gives the same answer every time and on both
//! pipelines. The hash is 32-bit integer arithmetic, which Rust and GLSL
//! compute identically.
//!
//! The position is measured against a fixed reference size rather than the
//! pixel grid, so the grain is the same size relative to the picture whether
//! it is being drawn into a 2560-pixel preview or a 6000-pixel export.
//!
//! Twin of the grain block in `src/gl/shaders.ts`.

use serde::{Deserialize, Serialize};

/// Grain is measured against a picture this many pixels on its long edge.
pub const REFERENCE: f32 = 3000.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grain {
    /// 0..100, how strongly the grain shows
    pub amount: f32,
    /// 0..100, how coarse the clumps are
    pub size: f32,
    /// 0..100, how much the grain tints as well as darkens
    pub colour: f32,
}

impl Default for Grain {
    fn default() -> Self {
        Self {
            amount: 0.0,
            size: 40.0,
            colour: 0.0,
        }
    }
}

impl Grain {
    pub fn is_active(&self) -> bool {
        self.amount > 0.0
    }
}

/// Lowbias32 integer hash: good scatter, and the same answer in GLSL.
#[inline]
pub fn hash(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

#[inline]
fn hash01(ix: i32, iy: i32, seed: u32) -> f32 {
    // shifted well clear of zero so neither axis is ever negative
    let x = (ix + 8192) as u32;
    let y = (iy + 8192) as u32;
    let h = hash(x.wrapping_mul(0x9e37_79b9) ^ hash(y.wrapping_add(seed)));
    (h >> 8) as f32 / 16_777_216.0
}

#[inline]
fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// Value noise in 0..1: hashed lattice points, smoothly blended between.
#[inline]
pub fn value_noise(x: f32, y: f32, seed: u32) -> f32 {
    let x0 = x.floor();
    let y0 = y.floor();
    let fx = smooth(x - x0);
    let fy = smooth(y - y0);
    let ix = x0 as i32;
    let iy = y0 as i32;
    let n00 = hash01(ix, iy, seed);
    let n10 = hash01(ix + 1, iy, seed);
    let n01 = hash01(ix, iy + 1, seed);
    let n11 = hash01(ix + 1, iy + 1, seed);
    let a = n00 + (n10 - n00) * fx;
    let b = n01 + (n11 - n01) * fx;
    a + (b - a) * fy
}

/// Two octaves, so the clumps have some structure rather than reading as a
/// single soft blur.
#[inline]
pub fn grain_at(u: f32, v: f32, long_edge: f32, g: &Grain, channel: u32) -> f32 {
    let cell = 1.0 + (g.size / 100.0).clamp(0.0, 1.0) * 7.0;
    let s = REFERENCE / cell;
    let x = u * s * (long_edge / REFERENCE).max(0.0001);
    let y = v * s;
    let coarse = value_noise(x, y, 11 + channel * 101);
    let fine = value_noise(x * 2.17, y * 2.17, 977 + channel * 101);
    // centred on zero, so grain darkens as often as it brightens
    (coarse * 0.65 + fine * 0.35) * 2.0 - 1.0
}

/// Grain over a developed pixel. `u` and `v` are its position in the picture,
/// 0..1; `aspect` is width over height.
#[inline]
pub fn apply(rgb: [f32; 3], u: f32, v: f32, aspect: f32, g: &Grain) -> [f32; 3] {
    let k = (g.amount / 100.0).clamp(0.0, 1.0) * 0.28;
    if k <= 0.0 {
        return rgb;
    }
    let long_edge = if aspect >= 1.0 {
        REFERENCE * aspect
    } else {
        REFERENCE
    };
    let y = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    // film shows its grain in the midtones and shadows, not in paper white
    let weight = (4.0 * y * (1.0 - y)).clamp(0.0, 1.0) * 0.85 + 0.15;
    let mono = grain_at(u, v, long_edge, g, 0);
    let c = (g.colour / 100.0).clamp(0.0, 1.0);
    let mut out = [0.0f32; 3];
    for i in 0..3 {
        // a gain rather than an offset, so grain does not tint the picture
        // unless the colour slider asks for it
        let n = if c > 0.0 {
            let per = grain_at(u, v, long_edge, g, i as u32 + 1);
            mono + (per - mono) * c
        } else {
            mono
        };
        out[i] = (rgb[i] * (1.0 + n * k * weight)).clamp(0.0, 1.0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hash_is_the_published_one() {
        // Pinned so the GLSL twin can be checked against the same numbers,
        // and so nobody changes the hash without noticing that every photo's
        // grain pattern would move.
        assert_eq!(hash(0), 0);
        assert_eq!(hash(1), 1_753_845_952);
        assert_eq!(hash(2), 3_507_691_905);
        assert_ne!(hash(2), hash(3));
    }

    #[test]
    fn noise_stays_in_range_and_repeats_exactly() {
        let mut lo = 1.0f32;
        let mut hi = 0.0f32;
        for i in 0..5000 {
            let x = i as f32 * 0.37;
            let y = i as f32 * 0.11;
            let n = value_noise(x, y, 11);
            assert_eq!(
                n,
                value_noise(x, y, 11),
                "the same place must give the same grain"
            );
            lo = lo.min(n);
            hi = hi.max(n);
        }
        assert!(lo >= 0.0 && hi <= 1.0, "noise left 0..1: {lo}..{hi}");
        assert!(
            lo < 0.1 && hi > 0.9,
            "noise barely used its range: {lo}..{hi}"
        );
    }

    #[test]
    fn zero_amount_leaves_the_pixel_alone() {
        let g = Grain::default();
        let p = [0.3, 0.4, 0.5];
        assert_eq!(apply(p, 0.5, 0.5, 1.5, &g), p);
    }

    #[test]
    fn grain_moves_brightness_without_tinting() {
        let g = Grain {
            amount: 100.0,
            size: 40.0,
            colour: 0.0,
        };
        let p = [0.6, 0.3, 0.15];
        let mut moved = 0;
        for i in 0..200 {
            let u = i as f32 / 200.0;
            let out = apply(p, u, 0.5, 1.5, &g);
            if (out[0] - p[0]).abs() > 1e-4 {
                moved += 1;
            }
            // a gain keeps the ratios: hue and saturation must not drift
            let r0 = p[0] / p[1];
            let r1 = out[0] / out[1];
            assert!(
                (r1 - r0).abs() / r0 < 1e-3,
                "grain tinted the pixel: {r0} -> {r1}"
            );
        }
        assert!(moved > 150, "grain hardly did anything ({moved}/200)");
    }

    #[test]
    fn the_colour_slider_lets_the_channels_differ() {
        let g = Grain {
            amount: 100.0,
            size: 40.0,
            colour: 100.0,
        };
        let p = [0.5, 0.5, 0.5];
        let mut split = false;
        for i in 0..200 {
            let out = apply(p, i as f32 / 200.0, 0.5, 1.5, &g);
            if (out[0] - out[2]).abs() > 1e-3 {
                split = true;
                break;
            }
        }
        assert!(split, "colour grain never separated the channels");
    }

    #[test]
    fn size_changes_how_coarse_the_clumps_are() {
        let fine = Grain {
            amount: 100.0,
            size: 0.0,
            colour: 0.0,
        };
        let coarse = Grain {
            amount: 100.0,
            size: 100.0,
            colour: 0.0,
        };
        // neighbouring pixels differ more with fine grain than with coarse
        let step = 1.0 / 3000.0;
        let diff = |g: &Grain| {
            let mut d = 0.0f32;
            for i in 0..400 {
                let u = i as f32 * step;
                d += (grain_at(u, 0.5, 3000.0, g, 0) - grain_at(u + step, 0.5, 3000.0, g, 0)).abs();
            }
            d
        };
        assert!(
            diff(&fine) > diff(&coarse) * 2.0,
            "size did not change the clump size"
        );
    }
}
