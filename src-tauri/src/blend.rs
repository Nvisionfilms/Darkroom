//! Double exposure: a second photograph composited onto the one being edited.
//!
//! A real double exposure is two exposures onto one negative, so the default
//! mode ("expose") adds the second picture as scene-referred light *before*
//! the tone mapping. Where the two pictures overlap the highlights roll off
//! together exactly as they would in camera. The other modes are the familiar
//! display-referred layer blends and run after the point curves and looks.
//!
//! Twin of `src/blend.ts` and the `uBlend*` half of `src/gl/shaders.ts`; the
//! placement and the blend maths must be changed in all three at once.

use crate::color::{mul3, DWG_TO_SRGB, SRGB_TO_DWG};
use crate::decode::LinearImage;
use serde::{Deserialize, Serialize};

pub const MODE_EXPOSE: u32 = 0;
pub const MODE_NORMAL: u32 = 1;
pub const MODE_SCREEN: u32 = 2;
pub const MODE_MULTIPLY: u32 = 3;
pub const MODE_OVERLAY: u32 = 4;
pub const MODE_SOFT_LIGHT: u32 = 5;
pub const MODE_LIGHTEN: u32 = 6;
pub const MODE_DARKEN: u32 = 7;
pub const MODE_DIFFERENCE: u32 = 8;

/// How far, in the overlay's own 0..1 space, its edge is feathered. Only
/// visible when the overlay does not cover the frame (scaled down, moved,
/// rotated, or a "contain" fit); it keeps that border from aliasing.
const EDGE: f32 = 0.002;

pub fn mode_id(name: &str) -> u32 {
    match name {
        "normal" => MODE_NORMAL,
        "screen" => MODE_SCREEN,
        "multiply" => MODE_MULTIPLY,
        "overlay" => MODE_OVERLAY,
        "softlight" => MODE_SOFT_LIGHT,
        "lighten" => MODE_LIGHTEN,
        "darken" => MODE_DARKEN,
        "difference" => MODE_DIFFERENCE,
        _ => MODE_EXPOSE,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blend {
    pub enabled: bool,
    /// the second photograph; any format `decode` can read, RAW included
    pub path: String,
    /// file name, shown in the panel
    pub name: String,
    /// see `mode_id`
    pub mode: String,
    /// 0..100
    pub opacity: f32,
    /// exposure of the second picture, in stops
    pub exposure: f32,
    /// 10..400, percent of the fitted size
    pub scale: f32,
    /// -100..100, percent of half the frame
    pub x: f32,
    pub y: f32,
    /// degrees, clockwise
    pub rotation: f32,
    pub flip: bool,
    pub invert: bool,
    /// "cover", "contain" or "stretch"
    pub fit: String,
}

impl Default for Blend {
    fn default() -> Self {
        Self {
            enabled: true,
            path: String::new(),
            name: String::new(),
            mode: "expose".into(),
            opacity: 100.0,
            exposure: 0.0,
            scale: 100.0,
            x: 0.0,
            y: 0.0,
            rotation: 0.0,
            flip: false,
            invert: false,
            fit: "cover".into(),
        }
    }
}

impl Blend {
    pub fn is_active(&self) -> bool {
        self.enabled && !self.path.is_empty() && self.opacity > 0.0
    }
}

/// Where the overlay sits on the frame, as the inverse map: a base pixel
/// centre to an overlay uv.
#[derive(Debug, Clone, Copy)]
pub struct Placement {
    cx: f32,
    cy: f32,
    /// overlay size in frame pixels along each axis
    denx: f32,
    deny: f32,
    cos: f32,
    sin: f32,
    flip: bool,
}

impl Placement {
    pub fn new(b: &Blend, bw: f32, bh: f32, ow: f32, oh: f32) -> Self {
        let s = (b.scale / 100.0).max(0.01);
        let (kx, ky) = match b.fit.as_str() {
            "contain" => {
                let k = (bw / ow).min(bh / oh) * s;
                (k, k)
            }
            "stretch" => (bw / ow * s, bh / oh * s),
            _ => {
                let k = (bw / ow).max(bh / oh) * s;
                (k, k)
            }
        };
        let th = b.rotation.to_radians();
        Self {
            cx: bw * 0.5 * (1.0 + b.x / 100.0),
            cy: bh * 0.5 * (1.0 + b.y / 100.0),
            denx: (ow * kx).max(1e-6),
            deny: (oh * ky).max(1e-6),
            cos: th.cos(),
            sin: th.sin(),
            flip: b.flip,
        }
    }

    /// uv of the overlay under a base pixel centre, and how much of the
    /// overlay covers it (0 outside).
    #[inline]
    pub fn uv(&self, px: f32, py: f32) -> (f32, f32, f32) {
        let dx = px - self.cx;
        let dy = py - self.cy;
        let rx = dx * self.cos + dy * self.sin;
        let ry = -dx * self.sin + dy * self.cos;
        let mut u = rx / self.denx + 0.5;
        let v = ry / self.deny + 0.5;
        if self.flip {
            u = 1.0 - u;
        }
        let edge = u.min(1.0 - u).min(v).min(1.0 - v);
        (u, v, smooth01(edge / EDGE))
    }
}

/// Everything the develop loop needs in order to sample the second picture.
pub struct Source<'a> {
    pub img: &'a LinearImage,
    pub place: Placement,
    pub mode: u32,
    /// opacity as 0..1
    pub alpha: f32,
    pub ev: f32,
    pub invert: bool,
}

impl<'a> Source<'a> {
    pub fn new(b: &Blend, img: &'a LinearImage, bw: usize, bh: usize) -> Self {
        Self {
            img,
            place: Placement::new(b, bw as f32, bh as f32, img.width as f32, img.height as f32),
            mode: mode_id(&b.mode),
            alpha: (b.opacity / 100.0).clamp(0.0, 1.0),
            ev: b.exposure,
            invert: b.invert,
        }
    }

    /// The overlay as linear DaVinci Wide Gamut light, already carrying its
    /// own exposure and inversion, with the alpha it contributes here.
    #[inline]
    pub fn sample(&self, px: f32, py: f32) -> ([f32; 3], f32) {
        let (u, v, cov) = self.place.uv(px, py);
        if cov <= 0.0 {
            return ([0.0; 3], 0.0);
        }
        let mut c = bilinear(self.img, u, v);
        let g = 2f32.powf(self.ev);
        for x in c.iter_mut() {
            *x *= g;
        }
        if self.invert {
            c = invert_linear(c);
        }
        (c, cov * self.alpha)
    }
}

/// Negative of a linear colour: encode it as plain sRGB, flip it, decode it
/// back. Inverting in a display encoding is what makes the result look like a
/// photographic negative instead of a near-black frame.
#[inline]
fn invert_linear(c: [f32; 3]) -> [f32; 3] {
    let s = mul3(&DWG_TO_SRGB, c);
    let d = [
        1.0 - srgb_enc(s[0].clamp(0.0, 1.0)),
        1.0 - srgb_enc(s[1].clamp(0.0, 1.0)),
        1.0 - srgb_enc(s[2].clamp(0.0, 1.0)),
    ];
    mul3(
        &SRGB_TO_DWG,
        [srgb_dec(d[0]), srgb_dec(d[1]), srgb_dec(d[2])],
    )
}

/// The display-referred layer blends, on gamma-encoded 0..1 values.
#[inline]
pub fn mix_display(b: [f32; 3], o: [f32; 3], mode: u32, a: f32) -> [f32; 3] {
    let mut out = b;
    for i in 0..3 {
        let x = b[i];
        let y = o[i];
        let m = match mode {
            MODE_SCREEN => 1.0 - (1.0 - x) * (1.0 - y),
            MODE_MULTIPLY => x * y,
            MODE_OVERLAY => {
                if x < 0.5 {
                    2.0 * x * y
                } else {
                    1.0 - 2.0 * (1.0 - x) * (1.0 - y)
                }
            }
            MODE_SOFT_LIGHT => soft_light(x, y),
            MODE_LIGHTEN => x.max(y),
            MODE_DARKEN => x.min(y),
            MODE_DIFFERENCE => (x - y).abs(),
            _ => y,
        };
        out[i] = (x + (m - x) * a).clamp(0.0, 1.0);
    }
    out
}

/// W3C compositing soft light, the same curve Photoshop uses.
#[inline]
fn soft_light(b: f32, o: f32) -> f32 {
    if o <= 0.5 {
        b - (1.0 - 2.0 * o) * b * (1.0 - b)
    } else {
        let d = if b <= 0.25 {
            ((16.0 * b - 12.0) * b + 4.0) * b
        } else {
            b.max(0.0).sqrt()
        };
        b + (2.0 * o - 1.0) * (d - b)
    }
}

#[inline]
fn smooth01(x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

#[inline]
pub fn srgb_enc(x: f32) -> f32 {
    if x <= 0.0031308 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

#[inline]
pub fn srgb_dec(x: f32) -> f32 {
    if x <= 0.04045 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}

/// Bilinear sample of an interleaved RGB image at uv, clamped at the edges.
#[inline]
fn bilinear(img: &LinearImage, u: f32, v: f32) -> [f32; 3] {
    let w = img.width;
    let h = img.height;
    if w == 0 || h == 0 {
        return [0.0; 3];
    }
    let x = (u * w as f32 - 0.5).clamp(0.0, w as f32 - 1.0);
    let y = (v * h as f32 - 0.5).clamp(0.0, h as f32 - 1.0);
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(w - 1);
    let y1 = (y0 + 1).min(h - 1);
    let fx = x - x0 as f32;
    let fy = y - y0 as f32;
    let mut out = [0.0f32; 3];
    for c in 0..3 {
        let top = {
            let a = img.data[(y0 * w + x0) * 3 + c];
            let b = img.data[(y0 * w + x1) * 3 + c];
            a + (b - a) * fx
        };
        let bot = {
            let a = img.data[(y1 * w + x0) * 3 + c];
            let b = img.data[(y1 * w + x1) * 3 + c];
            a + (b - a) * fx
        };
        out[c] = top + (bot - top) * fy;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(w: usize, h: usize, v: f32) -> LinearImage {
        LinearImage {
            width: w,
            height: h,
            data: vec![v; w * h * 3],
        }
    }

    #[test]
    fn cover_fills_the_frame() {
        let b = Blend::default();
        let p = Placement::new(&b, 100.0, 100.0, 40.0, 20.0);
        // a 2:1 overlay on a square frame: every frame pixel is still covered
        for (x, y) in [(0.5, 0.5), (99.5, 0.5), (50.0, 50.0), (99.5, 99.5)] {
            let (u, v, cov) = p.uv(x, y);
            assert!(cov > 0.0, "({x},{y}) not covered: uv {u},{v}");
        }
    }

    #[test]
    fn contain_leaves_the_edges_empty() {
        let b = Blend {
            fit: "contain".into(),
            ..Default::default()
        };
        let p = Placement::new(&b, 100.0, 100.0, 40.0, 20.0);
        assert!(p.uv(50.0, 50.0).2 > 0.0, "the centre should be covered");
        assert_eq!(p.uv(50.0, 1.0).2, 0.0, "the top should be empty");
    }

    #[test]
    fn the_centre_stays_put_under_scale_and_rotation() {
        for (scale, rot) in [(100.0, 0.0), (250.0, 33.0), (40.0, -90.0)] {
            let b = Blend {
                scale,
                rotation: rot,
                ..Default::default()
            };
            let p = Placement::new(&b, 100.0, 60.0, 80.0, 80.0);
            let (u, v, _) = p.uv(50.0, 30.0);
            assert!((u - 0.5).abs() < 1e-5 && (v - 0.5).abs() < 1e-5, "{u},{v}");
        }
    }

    #[test]
    fn offsets_move_the_overlay_by_half_frames() {
        let b = Blend {
            x: 100.0,
            ..Default::default()
        };
        let p = Placement::new(&b, 100.0, 100.0, 100.0, 100.0);
        // the overlay centre now sits on the right-hand edge of the frame
        let (u, _, _) = p.uv(100.0, 50.0);
        assert!((u - 0.5).abs() < 1e-5, "{u}");
    }

    #[test]
    fn zero_opacity_contributes_nothing() {
        let o = img(4, 4, 1.0);
        let b = Blend {
            opacity: 0.0,
            ..Default::default()
        };
        let s = Source::new(&b, &o, 8, 8);
        assert_eq!(s.sample(4.0, 4.0).1, 0.0);
    }

    #[test]
    fn exposure_scales_the_overlay_light() {
        let o = img(4, 4, 0.25);
        let b = Blend {
            exposure: 2.0,
            ..Default::default()
        };
        let s = Source::new(&b, &o, 8, 8);
        let (c, a) = s.sample(4.0, 4.0);
        assert!((c[0] - 1.0).abs() < 1e-5, "{c:?}");
        assert!((a - 1.0).abs() < 1e-5);
    }

    #[test]
    fn every_mode_is_a_no_op_at_zero_alpha() {
        let base = [0.2, 0.5, 0.9];
        for m in 0..=MODE_DIFFERENCE {
            let out = mix_display(base, [0.7, 0.1, 0.4], m, 0.0);
            for i in 0..3 {
                assert!((out[i] - base[i]).abs() < 1e-6, "mode {m}");
            }
        }
    }

    #[test]
    fn known_blend_results() {
        let b = [0.4, 0.4, 0.4];
        let o = [0.5, 0.5, 0.5];
        assert!((mix_display(b, o, MODE_MULTIPLY, 1.0)[0] - 0.2).abs() < 1e-6);
        assert!((mix_display(b, o, MODE_SCREEN, 1.0)[0] - 0.7).abs() < 1e-6);
        assert!((mix_display(b, o, MODE_NORMAL, 1.0)[0] - 0.5).abs() < 1e-6);
        assert!((mix_display(b, o, MODE_LIGHTEN, 1.0)[0] - 0.5).abs() < 1e-6);
        assert!((mix_display(b, o, MODE_DARKEN, 1.0)[0] - 0.4).abs() < 1e-6);
        assert!((mix_display(b, o, MODE_DIFFERENCE, 1.0)[0] - 0.1).abs() < 1e-6);
        // mid grey is the neutral point of soft light
        assert!((mix_display(b, o, MODE_SOFT_LIGHT, 1.0)[0] - 0.4).abs() < 1e-6);
        // half opacity gets half way there
        assert!((mix_display(b, o, MODE_MULTIPLY, 0.5)[0] - 0.3).abs() < 1e-6);
    }

    #[test]
    fn inverting_twice_returns_the_original() {
        // an in-gamut colour: the inversion clamps to sRGB, so anything
        // outside it is not expected to survive the round trip
        let c = mul3(&SRGB_TO_DWG, [0.3, 0.55, 0.12]);
        let back = invert_linear(invert_linear(c));
        for i in 0..3 {
            assert!((back[i] - c[i]).abs() < 1e-4, "{back:?}");
        }
    }

    #[test]
    fn mode_names_map_to_ids() {
        assert_eq!(mode_id("expose"), MODE_EXPOSE);
        assert_eq!(mode_id("screen"), MODE_SCREEN);
        assert_eq!(mode_id("softlight"), MODE_SOFT_LIGHT);
        // anything unknown falls back to the true double exposure
        assert_eq!(mode_id("nonsense"), MODE_EXPOSE);
    }
}
