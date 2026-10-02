//! Local-contrast support maps (texture / clarity), CPU twin of the
//! `LOGLUMA_FRAG` + `BLUR_FRAG` passes.
//!
//! From the (denoised) linear image we build a log2 luma map and three
//! Gaussian blurs of it:
//!   b1: sigma ~1px   (skips sensor noise)
//!   b2: sigma ~4px   (texture band = b1 - b2, mid frequencies)
//!   b3: sigma ~2% of the long edge, computed at quarter resolution
//!        (clarity band = b1 - b3, "midtone detail" in Resolve terms)
//! Radii scale with image size so preview and export match.

use crate::color::luma_proxy;
use rayon::prelude::*;

pub struct DetailMaps {
    pub width: usize,
    pub height: usize,
    pub lg: Vec<f32>,
    pub b1: Vec<f32>,
    pub b2: Vec<f32>,
    /// quarter resolution
    pub b3: Vec<f32>,
    /// quarter resolution: min(r, g, b) of the source blurred with the b3
    /// radius, the haze "veil" estimate used by dehaze
    pub dark: Vec<f32>,
    pub qw: usize,
    pub qh: usize,
}

/// Dark channel (min of r, g, b), clamped to 0..1.
pub fn dark_channel(rgb: &[f32]) -> Vec<f32> {
    rgb.par_chunks_exact(3)
        .map(|p| p[0].min(p[1]).min(p[2]).clamp(0.0, 1.0))
        .collect()
}

pub const REF_LONG_EDGE: f32 = 2560.0;

pub fn sigmas(width: usize, height: usize) -> (f32, f32, f32) {
    let long = width.max(height) as f32;
    let s = long / REF_LONG_EDGE;
    (1.0 * s, 4.0 * s, (0.02 * long).max(8.0))
}

pub fn log_luma(rgb: &[f32]) -> Vec<f32> {
    rgb.par_chunks_exact(3)
        .map(|p| luma_proxy([p[0], p[1], p[2]]).max(1e-5).log2())
        .collect()
}

fn kernel(sigma: f32) -> Vec<f32> {
    let r = (3.0 * sigma).ceil().max(1.0) as i32;
    let mut k: Vec<f32> = (-r..=r)
        .map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp())
        .collect();
    let s: f32 = k.iter().sum();
    for v in k.iter_mut() {
        *v /= s;
    }
    k
}

/// Separable Gaussian blur of a single-channel image.
pub fn gaussian(src: &[f32], width: usize, height: usize, sigma: f32) -> Vec<f32> {
    let k = kernel(sigma);
    let r = (k.len() / 2) as isize;
    let mut tmp = vec![0.0f32; src.len()];
    tmp.par_chunks_mut(width)
        .zip(src.par_chunks(width))
        .for_each(|(dst, row)| {
            for x in 0..width {
                let mut acc = 0.0;
                for (i, w) in k.iter().enumerate() {
                    let sx = (x as isize + i as isize - r).clamp(0, width as isize - 1) as usize;
                    acc += w * row[sx];
                }
                dst[x] = acc;
            }
        });
    let mut out = vec![0.0f32; src.len()];
    out.par_chunks_mut(width).enumerate().for_each(|(y, dst)| {
        for (i, w) in k.iter().enumerate() {
            let sy = (y as isize + i as isize - r).clamp(0, height as isize - 1) as usize;
            let row = &tmp[sy * width..(sy + 1) * width];
            for x in 0..width {
                dst[x] += w * row[x];
            }
        }
    });
    out
}

/// 4x4 box downsample of a single-channel image.
pub fn downsample4(src: &[f32], width: usize, height: usize) -> (Vec<f32>, usize, usize) {
    let qw = (width / 4).max(1);
    let qh = (height / 4).max(1);
    let mut out = vec![0.0f32; qw * qh];
    out.par_chunks_mut(qw).enumerate().for_each(|(qy, row)| {
        for qx in 0..qw {
            let mut acc = 0.0;
            let mut n = 0.0;
            for dy in 0..4 {
                let y = (qy * 4 + dy).min(height - 1);
                for dx in 0..4 {
                    let x = (qx * 4 + dx).min(width - 1);
                    acc += src[y * width + x];
                    n += 1.0;
                }
            }
            row[qx] = acc / n;
        }
    });
    (out, qw, qh)
}

/// Bilinear sample of the quarter-res map at full-res pixel (x, y).
#[inline]
pub fn sample_q(map: &[f32], qw: usize, qh: usize, x: usize, y: usize) -> f32 {
    let fx = ((x as f32 + 0.5) / 4.0 - 0.5).max(0.0);
    let fy = ((y as f32 + 0.5) / 4.0 - 0.5).max(0.0);
    let x0 = (fx.floor() as usize).min(qw - 1);
    let y0 = (fy.floor() as usize).min(qh - 1);
    let x1 = (x0 + 1).min(qw - 1);
    let y1 = (y0 + 1).min(qh - 1);
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let a = map[y0 * qw + x0] * (1.0 - tx) + map[y0 * qw + x1] * tx;
    let b = map[y1 * qw + x0] * (1.0 - tx) + map[y1 * qw + x1] * tx;
    a * (1.0 - ty) + b * ty
}

pub fn build(rgb: &[f32], width: usize, height: usize) -> DetailMaps {
    let (s1, s2, s3) = sigmas(width, height);
    let lg = log_luma(rgb);
    let b1 = gaussian(&lg, width, height, s1);
    let b2 = gaussian(&lg, width, height, s2);
    let (q, qw, qh) = downsample4(&lg, width, height);
    let b3 = gaussian(&q, qw, qh, s3 / 4.0);
    let dk = dark_channel(rgb);
    let (dq, _, _) = downsample4(&dk, width, height);
    let dark = gaussian(&dq, qw, qh, s3 / 4.0);
    DetailMaps {
        width,
        height,
        lg,
        b1,
        b2,
        b3,
        dark,
        qw,
        qh,
    }
}
