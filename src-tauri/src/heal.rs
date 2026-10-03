//! Object remover: patch-based heal / clone spots.
//!
//! A spot copies real pixels from somewhere else in the same photograph into
//! a feathered shape: a disc where you click, or the swept path of the brush
//! where you drag, so a wire or a line marking can be followed rather than
//! covered with a row of circles. Nothing is invented: "heal" adds a smooth colour and
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
    /// The painted path, in the same normalised coordinates as `x`/`y`. Empty
    /// or a single point is a plain disc at `x`, `y`; more points sweep the
    /// brush along them. Capped at MAX_PATH, which the shader must match.
    pub path: Vec<[f32; 2]>,
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
            path: Vec::new(),
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

/// Points a spot's shape is swept along. The shader holds this many per spot,
/// so a longer drag is resampled down to it before being stored.
pub const MAX_PATH: usize = 8;

impl HealSpot {
    /// The path in image pixels, always at least one point.
    pub fn points(&self, w: usize, h: usize) -> Vec<[f32; 2]> {
        let mut p: Vec<[f32; 2]> = self
            .path
            .iter()
            .take(MAX_PATH)
            .map(|q| [q[0] * w as f32, q[1] * h as f32])
            .collect();
        if p.is_empty() {
            p.push([self.x * w as f32, self.y * h as f32]);
        }
        p
    }
}

/// Distance from a point to a polyline, or to the single point it collapses to.
#[inline]
pub fn dist_to_path(pts: &[[f32; 2]], px: f32, py: f32) -> f32 {
    if pts.len() == 1 {
        return ((px - pts[0][0]).powi(2) + (py - pts[0][1]).powi(2)).sqrt();
    }
    let mut best = f32::MAX;
    for seg in pts.windows(2) {
        let (a, b) = (seg[0], seg[1]);
        let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
        let len2 = ex * ex + ey * ey;
        let t = if len2 > 1e-9 {
            (((px - a[0]) * ex + (py - a[1]) * ey) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (cx, cy) = (a[0] + ex * t, a[1] + ey * t);
        let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt();
        if d < best {
            best = d;
        }
    }
    best
}

/// The box a spot touches, in pixels: its path grown by the radius.
#[inline]
pub fn path_bounds(pts: &[[f32; 2]], r: f32) -> (f32, f32, f32, f32) {
    let mut lo = [f32::MAX; 2];
    let mut hi = [f32::MIN; 2];
    for p in pts {
        lo[0] = lo[0].min(p[0]);
        lo[1] = lo[1].min(p[1]);
        hi[0] = hi[0].max(p[0]);
        hi[1] = hi[1].max(p[1]);
    }
    (lo[0] - r, lo[1] - r, hi[0] + r, hi[1] + r)
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

/// A correction that is a plane rather than a single level: it can follow a
/// gradient, which is what a retouch almost always lands in.
///
/// Fitted by least squares to the ring just outside the patch, so the copied
/// pixels meet the picture at the rim on every side rather than only on
/// average. Returned as [c0, cu, cv] per channel over u, v - the offset from
/// the centre in units of the radius. Twin of healPlane in src/heal.ts.
pub fn heal_plane(
    img: &[f32],
    w: usize,
    h: usize,
    pts: &[[f32; 2]],
    dx: f32,
    dy: f32,
    sx: f32,
    sy: f32,
    r: f32,
) -> [[f32; 3]; 3] {
    const RING: usize = 96;
    // normal equations for [1, u, v]
    let mut ata = [[0.0f64; 3]; 3];
    let mut atb = [[0.0f64; 3]; 3];
    // Sample the rim of whatever shape this is. For a disc that is a circle
    // around it; for a swept path it is the outline of the sweep, found by
    // walking a generous circle around the whole thing and stepping in to
    // wherever the path actually is.
    let (bx0, by0, bx1, by1) = path_bounds(pts, 0.0);
    let (cx, cy) = ((bx0 + bx1) * 0.5, (by0 + by1) * 0.5);
    let reach = ((bx1 - bx0).powi(2) + (by1 - by0).powi(2)).sqrt() * 0.5 + r * 2.0;
    for i in 0..RING {
        let a = i as f32 * std::f32::consts::TAU / RING as f32;
        let (ca, sa) = (a.cos(), a.sin());
        // walk in from outside until the rim of the shape is found
        let mut hit = None;
        let steps = 96;
        for st in 0..=steps {
            let t = reach * (1.0 - st as f32 / steps as f32);
            let px = cx + t * ca;
            let py = cy + t * sa;
            if dist_to_path(pts, px, py) <= r {
                hit = Some(t);
                break;
            }
        }
        let Some(t_rim) = hit else { continue };
        for k in [0.0f32, 0.04, 0.08] {
            let t = t_rim + r * k;
            let px = cx + t * ca;
            let py = cy + t * sa;
            let dst = bilinear(img, w, h, px, py);
            let src = bilinear(img, w, h, sx + (px - dx), sy + (py - dy));
            let u = (px - dx) / r;
            let v = (py - dy) / r;
            let basis = [1.0f64, u as f64, v as f64];
            for bi in 0..3 {
                for bj in 0..3 {
                    ata[bi][bj] += basis[bi] * basis[bj];
                }
                for c in 0..3 {
                    atb[bi][c] += basis[bi] * (dst[c] - src[c]) as f64;
                }
            }
        }
    }
    let mut out = [[0.0f32; 3]; 3];
    for c in 0..3 {
        let b = [atb[0][c], atb[1][c], atb[2][c]];
        let x = solve3(&ata, &b);
        for k in 0..3 {
            out[k][c] = x[k] as f32;
        }
    }
    out
}

/// Gauss-Jordan on a 3x3. The ring always spans the plane, so it is never
/// singular; a degenerate fit falls back to the flat answer.
fn solve3(a: &[[f64; 3]; 3], b: &[f64; 3]) -> [f64; 3] {
    let mut m = [[0.0f64; 4]; 3];
    for i in 0..3 {
        m[i][..3].copy_from_slice(&a[i]);
        m[i][3] = b[i];
    }
    for col in 0..3 {
        let mut piv = col;
        for r2 in col + 1..3 {
            if m[r2][col].abs() > m[piv][col].abs() {
                piv = r2;
            }
        }
        if m[piv][col].abs() < 1e-9 {
            return [b[0] / a[0][0].max(1e-9), 0.0, 0.0];
        }
        m.swap(col, piv);
        let d = m[col][col];
        for k in col..4 {
            m[col][k] /= d;
        }
        for r2 in 0..3 {
            if r2 == col {
                continue;
            }
            let f = m[r2][col];
            for k in col..4 {
                m[r2][k] -= f * m[col][k];
            }
        }
    }
    [m[0][3], m[1][3], m[2][3]]
}

/// The plane's value at a point, in image pixels. Twin of the shader.
#[inline]
pub fn plane_at(p: &[[f32; 3]; 3], dx: f32, dy: f32, r: f32, px: f32, py: f32) -> [f32; 3] {
    let u = (px - dx) / r;
    let v = (py - dy) / r;
    [
        p[0][0] + p[1][0] * u + p[2][0] * v,
        p[0][1] + p[1][1] * u + p[2][1] * v,
        p[0][2] + p[1][2] * u + p[2][2] * v,
    ]
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
        let pts = s.points(w, h);
        let dx = s.x * w as f32;
        let dy = s.y * h as f32;
        let ox = s.sx * w as f32;
        let oy = s.sy * h as f32;
        let hard = 1.0 - (s.feather / 100.0).clamp(0.0, 1.0);
        let opacity = (s.opacity / 100.0).clamp(0.0, 1.0);
        // heal: a correction field so the patch meets the picture without a
        // seam, rather than one offset that only matches the average
        let plane = if s.kind == "clone" {
            None
        } else {
            Some(heal_plane(&src, w, h, &pts, dx, dy, ox, oy, r))
        };
        let (bx0, by0, bx1, by1) = path_bounds(&pts, r);
        let x_lo = (bx0.floor().max(0.0)) as usize;
        let x_hi = (bx1.ceil().min(w as f32 - 1.0)) as usize;
        let y_lo = (by0.floor().max(0.0)) as usize;
        let y_hi = (by1.ceil().min(h as f32 - 1.0)) as usize;
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
                    let d = dist_to_path(&pts, px, py) / r;
                    if d >= 1.0 {
                        continue;
                    }
                    let a = opacity * (1.0 - smooth01((d - hard) / soft));
                    if a <= 0.0 {
                        continue;
                    }
                    let sp = bilinear(&src, w, h, ox + (px - dx), oy + (py - dy));
                    let fix = match &plane {
                        Some(p) => plane_at(p, dx, dy, r, px, py),
                        None => [0.0; 3],
                    };
                    for c in 0..3 {
                        let v = (sp[c] + fix[c]).max(0.0);
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

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 160;
    const H: usize = 160;

    /// A background with a strong diagonal gradient - skin shading, sky, grass
    /// falling off - which is what a retouch actually lands in. A constant
    /// offset cannot match a gradient.
    fn background() -> Vec<f32> {
        let mut v = vec![0.0f32; W * H * 3];
        for y in 0..H {
            for x in 0..W {
                let g = 0.10 + 0.50 * (x as f32 / W as f32) + 0.25 * (y as f32 / H as f32);
                for c in 0..3 {
                    v[(y * W + x) * 3 + c] = g;
                }
            }
        }
        v
    }

    /// The same, with something to remove. It sits inside the solid core of the
    /// patch: with feather at 50 the outer half of the radius is only partly
    /// applied, so a blemish wider than that is not fully covered whatever the
    /// blending does.
    fn blemished() -> Vec<f32> {
        let mut v = background();
        for y in 54..82 {
            for x in 54..82 {
                let d = (((x as f32 - 68.0).powi(2) + (y as f32 - 68.0).powi(2)).sqrt()) / 7.0;
                if d < 1.0 {
                    for c in 0..3 {
                        v[(y * W + x) * 3 + c] *= 0.35;
                    }
                }
            }
        }
        v
    }

    fn spot() -> HealSpot {
        HealSpot {
            id: "s".into(),
            kind: "heal".into(),
            enabled: true,
            x: 68.0 / W as f32,
            y: 68.0 / H as f32,
            // taken from further along the gradient, as the finder would
            sx: 112.0 / W as f32,
            sy: 36.0 / H as f32,
            radius: 16.0 / W as f32,
            path: Vec::new(),
            feather: 50.0,
            opacity: 100.0,
        }
    }

    /// How far the repair is from what was behind the blemish, over the patch.
    fn error_against_truth(out: &[f32], truth: &[f32], s: &HealSpot) -> (f32, f32) {
        let r = s.radius * W.max(H) as f32;
        let (cx, cy) = (s.x * W as f32, s.y * H as f32);
        let (mut worst, mut sum, mut n) = (0.0f32, 0.0f32, 0.0f32);
        for y in 0..H {
            for x in 0..W {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                if d > r * 1.1 {
                    continue;
                }
                let i = (y * W + x) * 3 + 1;
                let e = (out[i] - truth[i]).abs();
                worst = worst.max(e);
                sum += e;
                n += 1.0;
            }
        }
        (worst, sum / n.max(1.0))
    }

    /// A wire across the frame: the thing a row of circles is tedious for.
    fn wired() -> Vec<f32> {
        let mut v = background();
        for x in 40..120 {
            let y = 60 + ((x as f32 - 40.0) * 0.25) as usize;
            for dy in 0..3 {
                for c in 0..3 {
                    v[((y + dy) * W + x) * 3 + c] *= 0.3;
                }
            }
        }
        v
    }

    #[test]
    fn a_painted_repair_follows_the_path_it_was_given() {
        let truth = background();
        let img = wired();
        // the same drag the brush would record, resampled to a handful of points
        let path: Vec<[f32; 2]> = (0..5)
            .map(|i| {
                let x = 40.0 + i as f32 * 20.0;
                let y = 61.0 + (x - 40.0) * 0.25;
                [x / W as f32, y / H as f32]
            })
            .collect();
        let s = HealSpot {
            id: "w".into(),
            kind: "heal".into(),
            enabled: true,
            x: 80.0 / W as f32,
            y: 71.0 / H as f32,
            sx: 80.0 / W as f32,
            sy: 110.0 / H as f32,
            radius: 5.0 / W as f32,
            path,
            feather: 40.0,
            opacity: 100.0,
        };
        let mut out = img.clone();
        heal_image(&mut out, W, H, &[s.clone()]);

        let at = |v: &[f32], x: usize, y: usize| v[(y * W + x) * 3 + 1];
        // the wire is gone all the way along, not just where a circle would be
        let mut worst = 0.0f32;
        for i in 0..5 {
            let x = 48 + i * 16;
            let y = 61 + ((x as f32 - 40.0) * 0.25) as usize;
            worst = worst.max((at(&out, x, y) - at(&truth, x, y)).abs());
        }
        assert!(worst < 0.02, "the wire is still showing somewhere along the path: off by {worst:.4}");

        // and the rest of the picture is untouched, well clear of the stroke
        for (x, y) in [(20usize, 20usize), (140, 30), (20, 140), (140, 140)] {
            assert!(
                (at(&out, x, y) - at(&img, x, y)).abs() < 1e-6,
                "the repair spilled to ({x}, {y})"
            );
        }
    }

    #[test]
    fn a_heal_matches_what_was_behind_the_blemish() {
        let truth = background();
        let img = blemished();
        let s = spot();
        let mut out = img.clone();
        heal_image(&mut out, W, H, &[s.clone()]);
        let (worst, mean) = error_against_truth(&out, &truth, &s);
        let (bad_worst, bad_mean) = error_against_truth(&img, &truth, &s);
        println!(
            "
against the real background: blemish was off by {bad_worst:.4} (mean {bad_mean:.4}), the repair is off by {worst:.4} (mean {mean:.4})"
        );
        assert!(worst < bad_worst * 0.12, "the repair is barely better than the blemish");
        // a patch whose brightness is right everywhere, not just on average
        assert!(worst < 0.012, "the repair is off by {worst:.4} at its worst - that shows as a seam");
    }
}
