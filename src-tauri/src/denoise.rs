//! Non-local-means denoiser, CPU twin of the `DENOISE_FRAG` shader.
//!
//! Design (borrowed from Resolve's spatial NR): luma and chroma are weighted
//! separately so colour speckle can be removed aggressively while luma detail
//! is protected, and a "detail" term restores large residuals (real edges)
//! that the smoother removed. Patch distances are measured in a square-root
//! domain so photon-shot noise is roughly uniform across the tonal range.
//!
//! Search window 7x7, patch 3x3. The CPU version uses the classic
//! per-offset + box-filter trick, so cost is O(pixels * 49) not O(pixels * 441).

use crate::color::{luma_proxy, LUMA_PROXY};
use rayon::prelude::*;

pub const SEARCH_RADIUS: i32 = 3;
const PATCH: usize = 9; // 3x3
const BAND_ROWS: usize = 64;

#[derive(Clone, Copy, Debug)]
pub struct NoiseParams {
    /// 0..1
    pub luma: f32,
    /// 0..1
    pub chroma: f32,
    /// 0..1, restores strong residuals
    pub detail: f32,
}

impl NoiseParams {
    pub fn from_sliders(luma: f32, chroma: f32, detail: f32) -> Self {
        Self {
            luma: (luma / 100.0).clamp(0.0, 1.0),
            chroma: (chroma / 100.0).clamp(0.0, 1.0),
            detail: (detail / 100.0).clamp(0.0, 1.0),
        }
    }
    pub fn is_noop(&self) -> bool {
        self.luma <= 0.0 && self.chroma <= 0.0
    }
}

/// Filter strengths as multiples of sigma. Shared with the shader.
#[inline]
pub fn h_luma(sigma: f32, amount: f32) -> f32 {
    sigma * (0.4 + 2.1 * amount)
}
#[inline]
pub fn h_chroma(sigma: f32, amount: f32) -> f32 {
    sigma * (0.4 + 2.6 * amount)
}

#[inline]
fn sqrt_luma(p: &[f32]) -> f32 {
    luma_proxy([p[0], p[1], p[2]]).max(0.0).sqrt()
}

/// Noise estimate on the sqrt-luma image: the 20th percentile of the standard
/// deviation of 8x8 blocks. Flat regions dominate the low percentiles, so real
/// texture does not inflate the estimate, and unlike Laplacian-based
/// estimators it sees the spatially correlated noise that demosaicing leaves
/// behind. Returns sigma in the sqrt domain (0..1 scale).
pub fn estimate_sigma(rgb: &[f32], width: usize, height: usize) -> f32 {
    const B: usize = 8;
    if width < B || height < B {
        return 0.0;
    }
    let py: Vec<f32> = rgb.par_chunks_exact(3).map(sqrt_luma).collect();
    let bw = width / B;
    let bh = height / B;
    let mut stds: Vec<f32> = (0..bh)
        .into_par_iter()
        .flat_map_iter(|by| {
            let py = &py;
            (0..bw).filter_map(move |bx| {
                let mut sum = 0.0f64;
                let mut sum2 = 0.0f64;
                for y in by * B..by * B + B {
                    for x in bx * B..bx * B + B {
                        let v = py[y * width + x] as f64;
                        sum += v;
                        sum2 += v * v;
                    }
                }
                let n = (B * B) as f64;
                let mean = sum / n;
                // skip clipped blacks / highlights where noise is not representative
                if mean < 0.03 || mean > 0.95 {
                    return None;
                }
                let var = (sum2 / n - mean * mean).max(0.0);
                Some(var.sqrt() as f32)
            })
        })
        .collect();
    if stds.is_empty() {
        return 0.0;
    }
    stds.sort_by(|a, b| a.partial_cmp(b).unwrap());
    stds[(stds.len() as f32 * 0.2) as usize]
}

/// Denoise an interleaved linear RGB buffer. Returns a new buffer.
pub fn nlm(rgb: &[f32], width: usize, height: usize, sigma: f32, p: &NoiseParams) -> Vec<f32> {
    if p.is_noop() || sigma <= 0.0 || width < 8 || height < 8 {
        return rgb.to_vec();
    }
    let r = SEARCH_RADIUS;
    let halo = (r + 1) as usize;
    // sqrt-domain per-channel and luma
    let sq: Vec<[f32; 4]> = rgb
        .par_chunks_exact(3)
        .map(|px| {
            let c = [px[0].max(0.0).sqrt(), px[1].max(0.0).sqrt(), px[2].max(0.0).sqrt()];
            [c[0], c[1], c[2], sqrt_luma(px)]
        })
        .collect();

    let hl2 = h_luma(sigma, p.luma).powi(2);
    let hc2 = h_chroma(sigma, p.chroma).powi(2);
    let noise2 = 2.0 * sigma * sigma;
    let use_l = p.luma > 0.0;
    let use_c = p.chroma > 0.0;

    let mut out = vec![0.0f32; rgb.len()];
    let bands: Vec<(usize, usize)> = (0..height)
        .step_by(BAND_ROWS)
        .map(|y0| (y0, (y0 + BAND_ROWS).min(height)))
        .collect();

    out.par_chunks_mut(BAND_ROWS * width * 3)
        .zip(bands.par_iter())
        .for_each(|(out_band, &(y0, y1))| {
            let rows = y1 - y0;
            // rows we need distances for: y0-1 .. y1+1 (box filter halo)
            let dy0 = y0 as isize - 1;
            let drows = rows + 2;
            let mut dl = vec![0.0f32; drows * width];
            let mut dc = vec![0.0f32; drows * width];
            let mut bl = vec![0.0f32; drows * width];
            let mut bc = vec![0.0f32; drows * width];
            // accumulators
            let mut wl_sum = vec![0.0f32; rows * width];
            let mut wc_sum = vec![0.0f32; rows * width];
            let mut acc_l = vec![0.0f32; rows * width * 3];
            let mut acc_c = vec![0.0f32; rows * width * 3];

            let clampy = |y: isize| y.clamp(0, height as isize - 1) as usize;
            let clampx = |x: isize| x.clamp(0, width as isize - 1) as usize;
            let _ = halo;

            for oy in -r..=r {
                for ox in -r..=r {
                    // per-pixel squared differences on the halo'd rows
                    for ry in 0..drows {
                        let y = dy0 + ry as isize;
                        let sy = clampy(y);
                        let ty = clampy(y + oy as isize);
                        for x in 0..width {
                            let a = sq[sy * width + x];
                            let b = sq[ty * width + clampx(x as isize + ox as isize)];
                            let d3 = (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2);
                            dl[ry * width + x] = (a[3] - b[3]).powi(2);
                            dc[ry * width + x] = d3;
                        }
                    }
                    // horizontal box3
                    for ry in 0..drows {
                        let row_l = &dl[ry * width..(ry + 1) * width];
                        let row_c = &dc[ry * width..(ry + 1) * width];
                        for x in 0..width {
                            let xm = x.saturating_sub(1);
                            let xp = (x + 1).min(width - 1);
                            bl[ry * width + x] = row_l[xm] + row_l[x] + row_l[xp];
                            bc[ry * width + x] = row_c[xm] + row_c[x] + row_c[xp];
                        }
                    }
                    // vertical box3 + weights + accumulate
                    for ry in 0..rows {
                        let y = y0 + ry;
                        let ty = clampy(y as isize + oy as isize);
                        let (r0, r1, r2) = (ry, ry + 1, ry + 2); // in drows coords (y-1, y, y+1)
                        for x in 0..width {
                            let tx = clampx(x as isize + ox as isize);
                            let s = (ty * width + tx) * 3;
                            let px = &rgb[s..s + 3];
                            let i = ry * width + x;
                            if use_l {
                                let d = (bl[r0 * width + x] + bl[r1 * width + x] + bl[r2 * width + x]) / PATCH as f32;
                                let w = (-((d - noise2).max(0.0)) / hl2).exp();
                                wl_sum[i] += w;
                                acc_l[i * 3] += w * px[0];
                                acc_l[i * 3 + 1] += w * px[1];
                                acc_l[i * 3 + 2] += w * px[2];
                            }
                            if use_c {
                                let d = (bc[r0 * width + x] + bc[r1 * width + x] + bc[r2 * width + x]) / (3.0 * PATCH as f32);
                                let w = (-((d - noise2).max(0.0)) / hc2).exp();
                                wc_sum[i] += w;
                                acc_c[i * 3] += w * px[0];
                                acc_c[i * 3 + 1] += w * px[1];
                                acc_c[i * 3 + 2] += w * px[2];
                            }
                        }
                    }
                }
            }

            // combine
            for ry in 0..rows {
                let y = y0 + ry;
                for x in 0..width {
                    let i = ry * width + x;
                    let s = (y * width + x) * 3;
                    let orig = [rgb[s], rgb[s + 1], rgb[s + 2]];
                    let rgb_l = if use_l {
                        let w = wl_sum[i].max(1e-12);
                        [acc_l[i * 3] / w, acc_l[i * 3 + 1] / w, acc_l[i * 3 + 2] / w]
                    } else {
                        orig
                    };
                    let rgb_c = if use_c {
                        let w = wc_sum[i].max(1e-12);
                        [acc_c[i * 3] / w, acc_c[i * 3 + 1] / w, acc_c[i * 3 + 2] / w]
                    } else {
                        orig
                    };
                    let o = combine(orig, rgb_l, rgb_c, sigma, p.detail);
                    out_band[i * 3] = o[0];
                    out_band[i * 3 + 1] = o[1];
                    out_band[i * 3 + 2] = o[2];
                }
            }
        });
    out
}

/// Ratio between the noise sigma of a 2x-downsampled image and the original.
/// White noise would give 0.5; demosaiced sensor noise is spatially correlated
/// so it decays more slowly. Shared with the shader.
pub const HALF_RES_SIGMA: f32 = 0.7;

/// 2x2 box downsample of interleaved RGB.
pub fn downsample2(rgb: &[f32], width: usize, height: usize) -> (Vec<f32>, usize, usize) {
    let hw = (width / 2).max(1);
    let hh = (height / 2).max(1);
    let mut out = vec![0.0f32; hw * hh * 3];
    out.par_chunks_mut(hw * 3).enumerate().for_each(|(hy, row)| {
        for hx in 0..hw {
            let mut acc = [0.0f32; 3];
            for dy in 0..2 {
                let y = (hy * 2 + dy).min(height - 1);
                for dx in 0..2 {
                    let x = (hx * 2 + dx).min(width - 1);
                    let s = (y * width + x) * 3;
                    acc[0] += rgb[s];
                    acc[1] += rgb[s + 1];
                    acc[2] += rgb[s + 2];
                }
            }
            row[hx * 3] = acc[0] * 0.25;
            row[hx * 3 + 1] = acc[1] * 0.25;
            row[hx * 3 + 2] = acc[2] * 0.25;
        }
    });
    (out, hw, hh)
}

/// Bilinear sample of a half-res RGB image at full-res pixel (x, y).
#[inline]
fn sample_half(img: &[f32], hw: usize, hh: usize, x: usize, y: usize) -> [f32; 3] {
    let fx = ((x as f32 + 0.5) / 2.0 - 0.5).max(0.0);
    let fy = ((y as f32 + 0.5) / 2.0 - 0.5).max(0.0);
    let x0 = (fx.floor() as usize).min(hw - 1);
    let y0 = (fy.floor() as usize).min(hh - 1);
    let x1 = (x0 + 1).min(hw - 1);
    let y1 = (y0 + 1).min(hh - 1);
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let mut o = [0.0f32; 3];
    for c in 0..3 {
        let a = img[(y0 * hw + x0) * 3 + c] * (1.0 - tx) + img[(y0 * hw + x1) * 3 + c] * tx;
        let b = img[(y1 * hw + x0) * 3 + c] * (1.0 - tx) + img[(y1 * hw + x1) * 3 + c] * tx;
        o[c] = a * (1.0 - ty) + b * ty;
    }
    o
}

/// Two-scale NLM: full-resolution NLM removes fine grain, a second NLM at half
/// resolution removes the low-frequency blotches a 7x7 window cannot see, and
/// its low frequencies replace those of the full-res result:
///   out = d1 + up(nlm(down(src))) - up(down(d1))
pub fn denoise_image(rgb: &[f32], width: usize, height: usize, sigma: f32, p: &NoiseParams) -> Vec<f32> {
    if p.is_noop() || sigma <= 0.0 || width < 16 || height < 16 {
        return rgb.to_vec();
    }
    let d1 = nlm(rgb, width, height, sigma, p);
    let (small, hw, hh) = downsample2(rgb, width, height);
    let d2 = nlm(&small, hw, hh, sigma * HALF_RES_SIGMA, p);
    let (d1s, _, _) = downsample2(&d1, width, height);
    let mut out = d1;
    out.par_chunks_mut(width * 3).enumerate().for_each(|(y, row)| {
        for x in 0..width {
            let a = sample_half(&d2, hw, hh, x, y);
            let b = sample_half(&d1s, hw, hh, x, y);
            for c in 0..3 {
                row[x * 3 + c] = (row[x * 3 + c] + a[c] - b[c]).max(0.0);
            }
        }
    });
    out
}

/// Luma from the luma-weighted average, chroma from the chroma-weighted
/// average, then soft-threshold detail restoration. Shared with the shader.
#[inline]
pub fn combine(orig: [f32; 3], rgb_l: [f32; 3], rgb_c: [f32; 3], sigma: f32, detail: f32) -> [f32; 3] {
    let yl = luma_proxy(rgb_l).max(0.0);
    let yc = luma_proxy(rgb_c).max(1e-6);
    let yo = luma_proxy(orig).max(0.0);
    // detail restoration in the sqrt domain: big residuals are edges, keep them
    let r_sqrt = yo.sqrt() - yl.sqrt();
    let k = detail * (r_sqrt.abs() / (2.0 * sigma)).min(1.0);
    let y_final = (yl + k * (yo - yl)).max(0.0);
    let scale = y_final / yc;
    [rgb_c[0] * scale, rgb_c[1] * scale, rgb_c[2] * scale]
}

#[allow(dead_code)]
fn _keep(_: [f32; 3]) -> f32 {
    LUMA_PROXY[0]
}
