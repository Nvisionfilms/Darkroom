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
    /// How fast noise rises into the shadows; 0 treats the picture as evenly noisy
    pub shadow: f32,
}

impl NoiseParams {
    pub fn from_sliders(luma: f32, chroma: f32, detail: f32) -> Self {
        Self {
            luma: (luma / 100.0).clamp(0.0, 1.0),
            chroma: (chroma / 100.0).clamp(0.0, 1.0),
            detail: (detail / 100.0).clamp(0.0, 1.0),
            shadow: 0.0,
        }
    }
    pub fn is_noop(&self) -> bool {
        self.luma <= 0.0 && self.chroma <= 0.0
    }

    /// How much noisier the shadows are than the rest, from `estimate_shadow`.
    pub fn with_shadow(mut self, k: f32) -> Self {
        self.shadow = k.clamp(0.0, SHADOW_MAX_K);
        self
    }
}

/// How much of a residual counts as real detail rather than noise: nothing at
/// the noise floor, all of it by DETAIL_EDGE sigmas. Shared with the shader.
pub const DETAIL_FLOOR: f32 = 1.0;
pub const DETAIL_EDGE: f32 = 2.5;

#[inline]
pub fn soft_threshold(residual: f32, sigma: f32) -> f32 {
    let t = ((residual / sigma.max(1e-6) - DETAIL_FLOOR) / (DETAIL_EDGE - DETAIL_FLOOR)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Filter strengths as multiples of sigma. Shared with the shader.
///
/// Measured on a noisy card: at the old top end the sliders removed 62% of the
/// noise at full travel, and the top half of the travel was worth only ten
/// points of that - 50 gave 52%, 100 gave 62% - which is why they felt like
/// they were doing nothing. The filter itself saturates near 91%, and the hard
/// edge in the card survives every setting intact, so the strength was simply
/// left too low. These take full travel to about 85% with the same edge.
/// The filter saturates long before the slider runs out, so the travel is
/// squared: without it almost the whole effect landed in the first quarter and
/// everything above was flat. Measured, 25/50/75/100 now remove roughly
/// 22/60/68/70 per cent instead of 60/68/69/70.
pub const RESPONSE: f32 = 2.0;

#[inline]
pub fn h_luma(sigma: f32, amount: f32) -> f32 {
    sigma * (0.4 + 4.0 * amount.powf(RESPONSE))
}
#[inline]
pub fn h_chroma(sigma: f32, amount: f32) -> f32 {
    // colour speckle can be crushed harder than luminance without it showing
    sigma * (0.4 + 5.2 * amount.powf(RESPONSE))
}

#[inline]
fn sqrt_luma(p: &[f32]) -> f32 {
    luma_proxy([p[0], p[1], p[2]]).max(0.0).sqrt()
}

/// Darkest brightness, in the sqrt domain, the shadow model trusts.
pub const SHADOW_FLOOR: f32 = 0.05;
/// How many times larger the noise level is allowed to be than the baseline,
/// squared. Past this the picture is mostly black and not worth chasing.
pub const SHADOW_MAX: f32 = 9.0;
/// The steepest rise `estimate_shadow` will report.
pub const SHADOW_MAX_K: f32 = 60.0;

/// How much larger the noise VARIANCE is, relative to the baseline, at a pixel
/// whose sqrt-luma is `s`. Twin of noiseFactor in the shader.
///
/// A sensor has two kinds of noise. Shot noise grows with the square root of the
/// signal and is flat once the picture is put in the sqrt domain; read noise is
/// constant in light, which in the sqrt domain grows towards black as 1/s^2. At
/// high ISO the second dominates the shadows, which is exactly where a RAW file
/// is worst. Taking one noise level for the whole picture - the quietest blocks,
/// found in the mid tones - left the shadows looking different to the filter
/// from how noise looks, so it hardly averaged them at all.
#[inline]
pub fn noise_factor(s: f32, k: f32) -> f32 {
    let s = s.max(SHADOW_FLOOR);
    (1.0 + k / (s * s)).min(SHADOW_MAX)
}

/// Estimate `k` for `noise_factor` from the picture itself.
///
/// Every 8x8 block gives a (brightness, variance) pair. Blocks are binned by
/// brightness, the quietest fifth of each bin is kept (texture only ever adds
/// variance, so the low end is the noise), and variance = a + b / s^2 is fitted
/// across the bins. Returns b / a, or 0 when there is not enough range to tell.
pub fn estimate_shadow(rgb: &[f32], width: usize, height: usize) -> f32 {
    const B: usize = 8;
    const BINS: usize = 10;
    if width < B * 4 || height < B * 4 {
        return 0.0;
    }
    let py: Vec<f32> = rgb.par_chunks_exact(3).map(sqrt_luma).collect();
    let (bw, bh) = (width / B, height / B);
    let blocks: Vec<(f32, f32)> = (0..bh)
        .into_par_iter()
        .flat_map_iter(|by| {
            let py = &py;
            (0..bw).filter_map(move |bx| {
                let (mut sum, mut sum2, mut su, mut sv) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
                for y in by * B..by * B + B {
                    for x in bx * B..bx * B + B {
                        let v = py[y * width + x] as f64;
                        // position within the block, centred so the two slopes
                        // can be read off independently
                        let u = (x - bx * B) as f64 - 3.5;
                        let w = (y - by * B) as f64 - 3.5;
                        sum += v;
                        sum2 += v * v;
                        su += u * v;
                        sv += w * v;
                    }
                }
                let n = (B * B) as f64;
                let mean = sum / n;
                if mean < 0.06 || mean > 0.95 {
                    return None;
                }
                // The variance left once the block's own slope is taken out. A
                // smooth ramp - a sky, a vignette, a gradient across a wall - is
                // not noise, and left in it made the shadows of every graduated
                // picture look noisier than they were. Sum of squared centred
                // positions across an 8x8 block is 336 along each axis.
                let plane = (su * su + sv * sv) / 336.0;
                Some((mean as f32, ((sum2 - sum * sum / n - plane) / n).max(0.0) as f32))
            })
        })
        .collect();
    let (lo, hi) = (0.06f32.ln(), 0.95f32.ln());
    let mut bins: Vec<Vec<(f32, f32)>> = vec![Vec::new(); BINS];
    for (m, v) in blocks {
        let t = ((m.ln() - lo) / (hi - lo)).clamp(0.0, 0.9999);
        bins[(t * BINS as f32) as usize].push((m, v));
    }
    // one (1/s^2, variance, weight) point per bin that has enough blocks
    let mut pts: Vec<(f64, f64, f64)> = Vec::new();
    for mut b in bins {
        if b.len() < 6 {
            continue;
        }
        b.sort_by(|x, y| x.1.partial_cmp(&y.1).unwrap());
        let quiet = &b[..(b.len() / 5).max(2)];
        let m = quiet.iter().map(|q| q.0 as f64).sum::<f64>() / quiet.len() as f64;
        let v = quiet.iter().map(|q| q.1 as f64).sum::<f64>() / quiet.len() as f64;
        pts.push((1.0 / (m * m), v, b.len() as f64));
    }
    if pts.len() < 3 {
        return 0.0;
    }
    // weighted least squares for v = a + b x
    let sw: f64 = pts.iter().map(|p| p.2).sum();
    let mx = pts.iter().map(|p| p.0 * p.2).sum::<f64>() / sw;
    let mv = pts.iter().map(|p| p.1 * p.2).sum::<f64>() / sw;
    let sxx: f64 = pts.iter().map(|p| p.2 * (p.0 - mx).powi(2)).sum();
    if sxx < 1e-9 {
        return 0.0;
    }
    let b_coef = (pts.iter().map(|p| p.2 * (p.0 - mx) * (p.1 - mv)).sum::<f64>() / sxx).max(0.0);
    let a_coef = (mv - b_coef * mx).max(1e-9);
    ((b_coef / a_coef) as f32).clamp(0.0, SHADOW_MAX_K)
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
    // how much noisier than the baseline each pixel is, from how dark it is
    let fmap: Vec<f32> = sq.iter().map(|q| noise_factor(q[3], p.shadow)).collect();
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
                                let f = fmap[(y0 + ry) * width + x];
                                let w = (-((d - noise2 * f).max(0.0)) / (hl2 * f)).exp();
                                wl_sum[i] += w;
                                acc_l[i * 3] += w * px[0];
                                acc_l[i * 3 + 1] += w * px[1];
                                acc_l[i * 3 + 2] += w * px[2];
                            }
                            if use_c {
                                let d = (bc[r0 * width + x] + bc[r1 * width + x] + bc[r2 * width + x]) / (3.0 * PATCH as f32);
                                let f = fmap[(y0 + ry) * width + x];
                                let w = (-((d - noise2 * f).max(0.0)) / (hc2 * f)).exp();
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
                    let o = combine(orig, rgb_l, rgb_c, sigma * fmap[y * width + x].sqrt(), p.detail);
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
    // Detail restoration in the sqrt domain: big residuals are edges, keep
    // them. The threshold has to tell an edge from the noise, and a straight
    // ramp did not - a residual the size of the noise scored half, so a quarter
    // of the noise was being added straight back at the default setting. It is
    // a soft threshold now: nothing below the noise floor comes back, and
    // anything well clear of it comes back whole.
    let r_sqrt = yo.sqrt() - yl.sqrt();
    let k = detail * soft_threshold(r_sqrt.abs(), sigma);
    let y_final = (yl + k * (yo - yl)).max(0.0);
    let scale = y_final / yc;
    [rgb_c[0] * scale, rgb_c[1] * scale, rgb_c[2] * scale]
}

#[allow(dead_code)]
fn _keep(_: [f32; 3]) -> f32 {
    LUMA_PROXY[0]
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 192;
    const H: usize = 128;

    /// Two flat patches either side of a hard edge, with repeatable noise on top.
    fn noisy() -> Vec<f32> {
        let mut v = vec![0.0f32; W * H * 3];
        let mut s = 0x1234_5678u32;
        let mut rnd = || {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            (s >> 8) as f32 / 8_388_608.0 - 1.0
        };
        for y in 0..H {
            for x in 0..W {
                let base = if x < W / 2 { 0.18 } else { 0.45 };
                for c in 0..3 {
                    v[(y * W + x) * 3 + c] = (base + rnd() * 0.05).max(0.0);
                }
            }
        }
        v
    }

    /// Noise left in a flat patch, well away from the edge.
    fn residual(v: &[f32]) -> f32 {
        let (mut n, mut sum, mut sq) = (0.0f32, 0.0f32, 0.0f32);
        for y in 10..H - 10 {
            for x in 10..W / 2 - 10 {
                let p = v[(y * W + x) * 3 + 1];
                n += 1.0;
                sum += p;
                sq += p * p;
            }
        }
        (sq / n - (sum / n).powi(2)).max(0.0).sqrt()
    }

    /// The step across the real edge, which the filter must not soften.
    fn edge(v: &[f32]) -> f32 {
        let (mut lo, mut hi, mut n) = (0.0f32, 0.0f32, 0.0f32);
        for y in 10..H - 10 {
            lo += v[(y * W + (W / 2 - 4)) * 3 + 1];
            hi += v[(y * W + (W / 2 + 4)) * 3 + 1];
            n += 1.0;
        }
        hi / n - lo / n
    }

    /// The sliders have to earn their travel. The top half used to be worth ten
    /// points of noise reduction out of sixty, which is why they felt dead.
    #[test]
    fn the_sliders_get_steadily_stronger_and_reach_most_of_the_way() {
        let img = noisy();
        let sigma = estimate_sigma(&img, W, H);
        assert!(sigma > 0.0, "no noise was detected in a noisy picture");
        let before = residual(&img);
        let e0 = edge(&img);

        let removed = |amount: f32| {
            let p = NoiseParams::from_sliders(amount, amount, 35.0);
            let out = denoise_image(&img, W, H, sigma, &p);
            ((1.0 - residual(&out) / before) * 100.0, edge(&out) / e0 * 100.0)
        };
        let (r25, _) = removed(25.0);
        let (r50, _) = removed(50.0);
        let (r100, edge100) = removed(100.0);

        // measured 22 / 63 / 75 / 77 at the shipping defaults; the old curve
        // was 28 / 52 / 59 / 62, with the whole top half worth ten points
        assert!(r100 > 72.0, "full strength only removed {r100:.1}% of the noise");
        assert!(r100 - r50 > 10.0, "the top half of the slider did almost nothing: {r50:.1}% -> {r100:.1}%");
        assert!(r50 - r25 > 25.0, "the first half of the slider did almost nothing: {r25:.1}% -> {r50:.1}%");
        // and none of it may come out of real edges
        assert!(edge100 > 97.0, "the edge was softened to {edge100:.1}% of itself");
    }



    /// Detail trades noise reduction for texture, so it has to move the result.
    #[test]
    fn the_detail_slider_trades_against_the_others() {
        let img = noisy();
        let sigma = estimate_sigma(&img, W, H);
        let before = residual(&img);
        let at = |detail: f32| {
            let p = NoiseParams::from_sliders(100.0, 100.0, detail);
            (1.0 - residual(&denoise_image(&img, W, H, sigma, &p)) / before) * 100.0
        };
        let (none, half, full) = (at(0.0), at(50.0), at(100.0));
        assert!(none > half && half > full, "detail did not trade: {none:.1} {half:.1} {full:.1}");
        assert!(none - full > 20.0, "detail barely mattered: {none:.1} -> {full:.1}");
    }
}
