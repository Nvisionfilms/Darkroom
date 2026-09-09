//! Object remover: patch-based heal / clone spots.
//!
//! A spot copies real pixels from somewhere else in the same photograph into
//! a feathered disc. Nothing is invented: "heal" adds a smooth colour and
//! brightness offset so the copied patch blends into its new surroundings,
//! "clone" copies as-is. This is the classic content-aware patch approach,
//! not a generative model.
//!
//! Spots are applied to the linear source before denoise and develop, so the
//! copied pixels go through exactly the same processing as the rest of the
//! frame. CPU twin of `HEAL_FRAG` in src/gl/shaders.ts.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// One retouch spot. Positions are fractions of the image width/height,
/// radius is a fraction of the long edge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealSpot {
    pub id: String,
    /// "heal" (match surroundings) or "clone" (copy as-is)
    pub kind: String,
    pub enabled: bool,
    /// destination centre
    pub x: f32,
    pub y: f32,
    /// source centre
    pub sx: f32,
    pub sy: f32,
    pub radius: f32,
    /// 0..100 edge softness
    pub feather: f32,
    /// 0..100
    pub opacity: f32,
}

impl Default for HealSpot {
    fn default() -> Self {
        Self {
            id: String::new(),
            kind: "heal".into(),
            enabled: true,
            x: 0.5,
            y: 0.5,
            sx: 0.4,
            sy: 0.5,
            radius: 0.03,
            feather: 60.0,
            opacity: 100.0,
        }
    }
}

impl HealSpot {
    pub fn is_active(&self) -> bool {
        self.enabled && self.opacity > 0.0 && self.radius > 0.0
    }
}

#[inline]
fn smooth01(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

/// Mean colour of a disc of radius `r` around (cx, cy), in pixels.
/// Used for the heal offset; the shader approximates it with a mip level.
fn disc_mean(img: &[f32], w: usize, h: usize, cx: f32, cy: f32, r: f32) -> [f32; 3] {
    let step = (r / 6.0).max(1.0);
    let mut acc = [0.0f32; 3];
    let mut n = 0.0f32;
    let mut dy = -r;
    while dy <= r {
        let mut dx = -r;
        while dx <= r {
            if dx * dx + dy * dy <= r * r {
                let x = (cx + dx).round();
                let y = (cy + dy).round();
                if x >= 0.0 && y >= 0.0 && (x as usize) < w && (y as usize) < h {
                    let i = (y as usize * w + x as usize) * 3;
                    acc[0] += img[i];
                    acc[1] += img[i + 1];
                    acc[2] += img[i + 2];
                    n += 1.0;
                }
            }
            dx += step;
        }
        dy += step;
    }
    if n > 0.0 {
        [acc[0] / n, acc[1] / n, acc[2] / n]
    } else {
        [0.0; 3]
    }
}

/// The smooth colour/brightness difference between a spot's destination and
/// its source surroundings. Twin of `healOffset` in src/heal.ts.
pub fn heal_offset(img: &[f32], w: usize, h: usize, dx: f32, dy: f32, sx: f32, sy: f32, r: f32) -> [f32; 3] {
    let md = disc_mean(img, w, h, dx, dy, r * 1.35);
    let ms = disc_mean(img, w, h, sx, sy, r * 1.35);
    [md[0] - ms[0], md[1] - ms[1], md[2] - ms[2]]
}

#[inline]
fn bilinear(img: &[f32], w: usize, h: usize, x: f32, y: f32) -> [f32; 3] {
    let fx = (x - 0.5).clamp(0.0, w as f32 - 1.0);
    let fy = (y - 0.5).clamp(0.0, h as f32 - 1.0);
    let x0 = fx.floor() as usize;
    let y0 = fy.floor() as usize;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let tx = fx - x0 as f32;
    let ty = fy - y0 as f32;
    let mut o = [0.0f32; 3];
    for c in 0..3 {
        let a = img[(y0 * w + x0) * 3 + c] * (1.0 - tx) + img[(y0 * w + x1) * 3 + c] * tx;
        let b = img[(y1 * w + x0) * 3 + c] * (1.0 - tx) + img[(y1 * w + x1) * 3 + c] * tx;
        o[c] = a * (1.0 - ty) + b * ty;
    }
    o
}

/// Apply every active spot to a linear RGB buffer, in order.
pub fn heal_image(img: &mut Vec<f32>, w: usize, h: usize, spots: &[HealSpot]) {
    if w == 0 || h == 0 {
        return;
    }
    let long = w.max(h) as f32;
    // Every spot reads the untouched photo, so the result does not depend on
    // the order the spots were placed in. The shader does the same.
    let src = img.clone();
    for s in spots.iter().filter(|s| s.is_active()) {
        let r = (s.radius * long).max(1.0);
        let dx = s.x * w as f32;
        let dy = s.y * h as f32;
        let ox = s.sx * w as f32;
        let oy = s.sy * h as f32;
        let hard = 1.0 - (s.feather / 100.0).clamp(0.0, 1.0);
        let opacity = (s.opacity / 100.0).clamp(0.0, 1.0);
        // heal: smooth offset so the patch matches its new surroundings
        let offset = if s.kind == "clone" {
            [0.0f32; 3]
        } else {
            heal_offset(&src, w, h, dx, dy, ox, oy, r)
        };
        let x_lo = ((dx - r).floor().max(0.0)) as usize;
        let x_hi = ((dx + r).ceil().min(w as f32 - 1.0)) as usize;
        let y_lo = ((dy - r).floor().max(0.0)) as usize;
        let y_hi = ((dy + r).ceil().min(h as f32 - 1.0)) as usize;
        if x_lo > x_hi || y_lo > y_hi {
            continue;
        }
        let soft = (1.0 - hard).max(0.01);
        img.par_chunks_mut(w * 3)
            .enumerate()
            .skip(y_lo)
            .take(y_hi - y_lo + 1)
            .for_each(|(y, row)| {
                let py = y as f32 + 0.5;
                for x in x_lo..=x_hi {
                    let px = x as f32 + 0.5;
                    let d = ((px - dx).powi(2) + (py - dy).powi(2)).sqrt() / r;
                    if d >= 1.0 {
                        continue;
                    }
                    let a = opacity * (1.0 - smooth01((d - hard) / soft));
                    if a <= 0.0 {
                        continue;
                    }
                    let s = bilinear(&src, w, h, ox + (px - dx), oy + (py - dy));
                    for c in 0..3 {
                        let v = (s[c] + offset[c]).max(0.0);
                        row[x * 3 + c] += (v - row[x * 3 + c]) * a;
                    }
                }
            });
    }
}

/// Pick a source patch for a destination spot: the candidate on a ring around
/// it whose surroundings look most like the destination's surroundings, while
/// staying inside the frame and away from other spots. Deterministic.
pub fn find_source(
    img: &[f32],
    w: usize,
    h: usize,
    x: f32,
    y: f32,
    radius: f32,
    avoid: &[(f32, f32, f32)],
) -> (f32, f32) {
    let long = w.max(h) as f32;
    let r = (radius * long).max(1.0);
    let dx = x * w as f32;
    let dy = y * h as f32;
    // Compare a ring of samples around each candidate with the same ring
    // around the destination: a good source has similar surroundings but is
    // not the thing being removed.
    let ring = |cx: f32, cy: f32| -> Option<Vec<[f32; 3]>> {
        let mut v = Vec::with_capacity(16);
        for i in 0..16 {
            let a = i as f32 / 16.0 * std::f32::consts::TAU;
            let px = cx + a.cos() * r * 1.4;
            let py = cy + a.sin() * r * 1.4;
            if px < 0.0 || py < 0.0 || px >= w as f32 || py >= h as f32 {
                return None;
            }
            v.push(bilinear(img, w, h, px, py));
        }
        Some(v)
    };
    let Some(dest) = ring(dx, dy) else {
        return (x, y);
    };
    let mut best = (x, y);
    let mut best_cost = f32::MAX;
    for step in 0..3 {
        let dist = r * (2.2 + step as f32 * 1.6);
        for i in 0..24 {
            let a = i as f32 / 24.0 * std::f32::consts::TAU;
            let cx = dx + a.cos() * dist;
            let cy = dy + a.sin() * dist;
            if cx - r < 0.0 || cy - r < 0.0 || cx + r >= w as f32 || cy + r >= h as f32 {
                continue;
            }
            // stay away from other spots
            if avoid.iter().any(|(ax, ay, ar)| {
                let axp = ax * w as f32;
                let ayp = ay * h as f32;
                ((cx - axp).powi(2) + (cy - ayp).powi(2)).sqrt() < (ar * long + r)
            }) {
                continue;
            }
            let Some(cand) = ring(cx, cy) else { continue };
            let mut cost = 0.0;
            for (a, b) in dest.iter().zip(cand.iter()) {
                for c in 0..3 {
                    let d = a[c] - b[c];
                    cost += d * d;
                }
            }
            // prefer nearer candidates when the match is similar
            cost *= 1.0 + 0.05 * step as f32;
            if cost < best_cost {
                best_cost = cost;
                best = (cx / w as f32, cy / h as f32);
            }
        }
        if best_cost < 1e-4 {
            break;
        }
    }
    best
}
