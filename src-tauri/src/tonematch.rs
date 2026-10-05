//! Tone match: make a photo look like a reference by finding the slider values
//! that do it.
//!
//! The usual way to match one picture to another is to push its statistics onto
//! the other's - mean and spread per channel, or a histogram specification - and
//! write the result into the pixels. That works, but what comes out is a
//! finished picture with no sliders behind it: it cannot be adjusted, backed off
//! or exported any differently from what was previewed.
//!
//! This does the other thing. It measures how the reference is distributed in
//! tone and colour, then searches the ordinary develop sliders - exposure,
//! contrast, highlights, shadows, whites, blacks, temperature, tint, saturation -
//! for the values at which the photo, run through the real develop pipeline,
//! measures the same. The answer is nine numbers in sliders you already have, so
//! it can be nudged, backed off with one strength control, undone, saved as a
//! preset, and exports exactly as it previewed.
//!
//! It can match tone and balance. It cannot match content: a sunset reference
//! will not turn a grey afternoon into a sunset, and a reference with a strong
//! colour cast will pass some of that cast on, which is why the strength control
//! exists.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::color::{mul3, DWG_TO_SRGB};
use crate::decode::LinearImage;
use crate::pipeline::{self, srgb_enc, EditParams};

/// Brightness percentiles measured, from the deepest shadows to the brightest
/// highlights. The middle is weighted most (see WEIGHTS) and the ends keep the
/// black and white points honest.
pub const QUANTILES: [f32; 7] = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99];
const WEIGHTS: [f32; 7] = [1.0, 1.0, 1.5, 2.5, 1.5, 1.0, 1.0];

/// Longest edge both pictures are shrunk to before measuring. The measurements
/// are distributions, not detail, and the solver runs the whole develop pipeline
/// hundreds of times.
pub const PROXY_EDGE: usize = 200;

/// What a picture looks like, in the terms the match works in. All of it is
/// measured on display values - what a person sees - not on linear light.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToneStats {
    /// brightness at each of `QUANTILES`
    pub q: [f32; 7],
    /// red and blue share of the light in the mid tones: the colour balance
    pub mid: [f32; 2],
    /// how saturated the picture is, on average
    pub sat: f32,
}

#[inline]
fn luma(r: f32, g: f32, b: f32) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Measure a picture from its display values, interleaved RGB in 0..1.
pub fn stats(display: &[f32]) -> ToneStats {
    let n = display.len() / 3;
    if n == 0 {
        return ToneStats::default();
    }
    let mut ys: Vec<f32> = display.chunks_exact(3).map(|p| luma(p[0], p[1], p[2])).collect();
    ys.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mut q = [0.0f32; 7];
    for (i, f) in QUANTILES.iter().enumerate() {
        q[i] = ys[((n as f32 - 1.0) * f).round() as usize];
    }

    let (mut mr, mut mb, mut mn) = (0.0f64, 0.0f64, 0.0f64);
    let (mut ss, mut sn) = (0.0f64, 0.0f64);
    for p in display.chunks_exact(3) {
        let y = luma(p[0], p[1], p[2]);
        let total = p[0] + p[1] + p[2];
        if (0.25..=0.75).contains(&y) && total > 1e-4 {
            mr += (p[0] / total) as f64;
            mb += (p[2] / total) as f64;
            mn += 1.0;
        }
        if (0.1..=0.95).contains(&y) {
            let mx = p[0].max(p[1]).max(p[2]);
            let mi = p[0].min(p[1]).min(p[2]);
            if mx > 1e-4 {
                ss += ((mx - mi) / mx) as f64;
                sn += 1.0;
            }
        }
    }
    // a picture with nothing in the middle (all very dark, say) has no mid-tone
    // balance to speak of; the overall balance is the next best thing
    if mn < 8.0 {
        for p in display.chunks_exact(3) {
            let total = p[0] + p[1] + p[2];
            if total > 1e-4 {
                mr += (p[0] / total) as f64;
                mb += (p[2] / total) as f64;
                mn += 1.0;
            }
        }
    }
    ToneStats {
        q,
        mid: if mn > 0.0 { [(mr / mn) as f32, (mb / mn) as f32] } else { [1.0 / 3.0; 2] },
        sat: if sn > 0.0 { (ss / sn) as f32 } else { 0.0 },
    }
}

/// How a reference looks on screen. A bitmap already is what it looks like, so
/// its own pixel values are used as they are; running a finished JPEG through a
/// tone curve again would measure a picture nobody has seen. A RAW has no look
/// until it is developed, so it gets the app's default one.
pub fn reference_stats(img: &LinearImage, is_raw: bool, lut: &[f32]) -> ToneStats {
    let display: Vec<f32> = if is_raw {
        pipeline::develop_buffer(&img.data, img.width, None, &EditParams::default(), lut)
    } else {
        img.data
            .par_chunks_exact(3)
            .flat_map_iter(|p| {
                let s = mul3(&DWG_TO_SRGB, [p[0], p[1], p[2]]);
                [srgb_enc(s[0].clamp(0.0, 1.0)), srgb_enc(s[1].clamp(0.0, 1.0)), srgb_enc(s[2].clamp(0.0, 1.0))]
            })
            .collect()
    };
    stats(&display)
}

/// The sliders the match sets, in the units the sliders use.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tune {
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub temperature: f32,
    pub tint: f32,
    pub saturation: f32,
}

const N: usize = 9;
/// How far each slider may go: exposure in stops, the rest in slider units. The
/// match stops short of the extremes - a picture that needs everything pushed
/// to the end is better served by being told it cannot be matched.
const LIMITS: [(f32, f32); N] = [
    (-3.0, 3.0),
    (-80.0, 80.0),
    (-80.0, 80.0),
    (-80.0, 80.0),
    (-80.0, 80.0),
    (-80.0, 80.0),
    (-60.0, 60.0),
    (-60.0, 60.0),
    (-70.0, 70.0),
];
const STEPS: [f32; N] = [0.5, 20.0, 20.0, 20.0, 20.0, 20.0, 15.0, 15.0, 20.0];
const MIN_STEPS: [f32; N] = [0.01, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4];

impl Tune {
    fn to_array(self) -> [f32; N] {
        [
            self.exposure,
            self.contrast,
            self.highlights,
            self.shadows,
            self.whites,
            self.blacks,
            self.temperature,
            self.tint,
            self.saturation,
        ]
    }
    fn from_array(a: [f32; N]) -> Self {
        Self {
            exposure: a[0],
            contrast: a[1],
            highlights: a[2],
            shadows: a[3],
            whites: a[4],
            blacks: a[5],
            temperature: a[6],
            tint: a[7],
            saturation: a[8],
        }
    }
    pub fn from_params(p: &EditParams) -> Self {
        Self {
            exposure: p.exposure,
            contrast: p.contrast,
            highlights: p.highlights,
            shadows: p.shadows,
            whites: p.whites,
            blacks: p.blacks,
            temperature: p.temperature,
            tint: p.tint,
            saturation: p.saturation,
        }
    }
    fn apply(self, base: &EditParams) -> EditParams {
        let mut p = base.clone();
        p.exposure = self.exposure;
        p.contrast = self.contrast;
        p.highlights = self.highlights;
        p.shadows = self.shadows;
        p.whites = self.whites;
        p.blacks = self.blacks;
        p.temperature = self.temperature;
        p.tint = self.tint;
        p.saturation = self.saturation;
        p
    }
}

fn tone_loss(s: &ToneStats, t: &ToneStats) -> f32 {
    let mut l = 0.0;
    for i in 0..7 {
        l += WEIGHTS[i] * (s.q[i] - t.q[i]).powi(2);
    }
    l
}

fn colour_loss(s: &ToneStats, t: &ToneStats) -> f32 {
    // balance is a few hundredths wide where brightness is a few tenths, so it
    // is scaled up to carry comparable weight
    60.0 * ((s.mid[0] - t.mid[0]).powi(2) + (s.mid[1] - t.mid[1]).powi(2))
}

fn sat_loss(s: &ToneStats, t: &ToneStats) -> f32 {
    4.0 * (s.sat - t.sat).powi(2)
}

/// The result of a match.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Match {
    /// the sliders that do it
    pub values: Tune,
    pub reference: ToneStats,
    pub before: ToneStats,
    pub after: ToneStats,
    /// how far the photo was from the reference before and after, 0 being a
    /// perfect match, so the caller can say how close it got
    pub distance_before: f32,
    pub distance_after: f32,
}

fn total_loss(s: &ToneStats, t: &ToneStats) -> f32 {
    tone_loss(s, t) + colour_loss(s, t) + sat_loss(s, t)
}

/// Pattern search over the chosen sliders: nudge each way, keep what helps, and
/// halve the steps when nothing does. It needs no gradients, and the develop
/// pipeline is far from smooth, with its shoulders and clips.
fn search(start: [f32; N], free: &[usize], mut loss: impl FnMut(&[f32; N]) -> f32, base: [f32; N]) -> [f32; N] {
    let mut p = start;
    // A pull back towards where it started. Several sliders overlap - highlights,
    // whites and contrast can make nearly the same picture - so without it the
    // search lands on whichever combination it met first, often with highlights
    // and whites pushed in opposite directions, which is no fun to edit from.
    // Measured on a known look: 0.0008 gave 0.0082 from the reference with whites
    // at -38; 0.004 gave 0.0068, a better match, with every slider small.
    let mut reg = |p: &[f32; N], loss: &mut dyn FnMut(&[f32; N]) -> f32| {
        let mut r = 0.0;
        for &k in free {
            let range = LIMITS[k].1 - LIMITS[k].0;
            r += ((p[k] - base[k]) / range).powi(2);
        }
        loss(p) + 0.004 * r
    };
    let mut best = reg(&p, &mut loss);
    let mut step = STEPS;
    let mut evals = 0;
    while evals < 900 {
        let mut improved = false;
        for &k in free {
            for dir in [1.0f32, -1.0] {
                let mut q = p;
                q[k] = (p[k] + dir * step[k]).clamp(LIMITS[k].0, LIMITS[k].1);
                if (q[k] - p[k]).abs() < 1e-9 {
                    continue;
                }
                let l = reg(&q, &mut loss);
                evals += 1;
                if l < best - 1e-9 {
                    best = l;
                    p = q;
                    improved = true;
                    break;
                }
            }
        }
        if !improved {
            let mut any = false;
            for &k in free {
                if step[k] > MIN_STEPS[k] {
                    step[k] *= 0.5;
                    any = true;
                }
            }
            if !any {
                break;
            }
        }
    }
    p
}

/// Find the sliders that make `src` - a small linear copy of the photo - look
/// like the reference, starting from the photo's own settings in `base`.
pub fn run(src: &LinearImage, base: &EditParams, lut: &[f32], reference: &ToneStats) -> Match {
    // only the plain develop is compared: the things that need neighbourhood
    // maps, and the local adjustments, are not what is being matched
    let mut proxy = base.clone();
    proxy.texture = 0.0;
    proxy.clarity = 0.0;
    proxy.dehaze = 0.0;
    proxy.masks.clear();
    proxy.heal.clear();

    let measure = |t: &Tune| -> ToneStats {
        let p = t.apply(&proxy);
        stats(&pipeline::develop_buffer(&src.data, src.width, None, &p, lut))
    };

    let start = Tune::from_params(base);
    let before = measure(&start);
    let origin = start.to_array();
    let mut cur = origin;

    let eval = |a: &[f32; N]| measure(&Tune::from_array(*a));
    // tone first, then colour, then saturation, then tone again with the colour
    // in place, since warming a picture moves its brightness a little
    for _ in 0..2 {
        cur = search(cur, &[0, 1, 2, 3, 4, 5], |a| tone_loss(&eval(a), reference), origin);
        cur = search(cur, &[6, 7], |a| colour_loss(&eval(a), reference), origin);
        cur = search(cur, &[8], |a| sat_loss(&eval(a), reference), origin);
    }
    let values = Tune::from_array(cur);
    let after = measure(&values);
    Match {
        values,
        reference: *reference,
        before,
        after,
        distance_before: total_loss(&before, reference).sqrt(),
        distance_after: total_loss(&after, reference).sqrt(),
    }
}

/// Blend a match back towards where the sliders started: 0 is untouched, 1 is
/// the full match. Linear in each slider, so a strength of one half is halfway
/// in every one of them.
pub fn blend(from: &Tune, to: &Tune, strength: f32) -> Tune {
    let k = strength.clamp(0.0, 1.0);
    let a = from.to_array();
    let b = to.to_array();
    let mut o = [0.0f32; N];
    for i in 0..N {
        o[i] = a[i] + (b[i] - a[i]) * k;
    }
    Tune::from_array(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 96;
    const H: usize = 64;

    /// A picture with real range in it: a ramp from deep shadow to bright
    /// highlight, crossed with a gentle colour shift so it is not grey.
    fn scene() -> LinearImage {
        let mut data = vec![0.0f32; W * H * 3];
        for y in 0..H {
            for x in 0..W {
                let u = x as f32 / (W - 1) as f32;
                let v = y as f32 / (H - 1) as f32;
                let l = 0.01 + 0.9 * u.powf(2.2);
                let i = (y * W + x) * 3;
                data[i] = l * (0.9 + 0.2 * v);
                data[i + 1] = l;
                data[i + 2] = l * (1.1 - 0.2 * v);
            }
        }
        LinearImage { width: W, height: H, data }
    }

    fn develop_with(img: &LinearImage, t: &Tune, lut: &[f32]) -> Vec<f32> {
        pipeline::develop_buffer(&img.data, img.width, None, &t.apply(&EditParams::default()), lut)
    }

    /// The honest test of a match: build a reference by developing the photo
    /// with settings nobody told the solver about, then ask it to find them from
    /// the reference's statistics alone. It must end up looking the same, and the
    /// values it lands on should be close to the ones that were used.
    #[test]
    fn it_finds_the_look_a_reference_was_made_with() {
        let img = scene();
        let lut = pipeline::identity_lut();
        let secret = Tune {
            exposure: 0.7,
            contrast: 30.0,
            highlights: -25.0,
            shadows: 20.0,
            whites: 10.0,
            blacks: -15.0,
            temperature: 22.0,
            tint: -10.0,
            saturation: 18.0,
        };
        let reference = stats(&develop_with(&img, &secret, &lut));

        let m = run(&img, &EditParams::default(), &lut, &reference);
        println!(
            "\ndistance {:.4} -> {:.4}\nfound  {:?}\nsecret {:?}",
            m.distance_before, m.distance_after, m.values, secret
        );
        assert!(
            m.distance_after < m.distance_before * 0.2,
            "the match barely closed the gap: {:.4} -> {:.4}",
            m.distance_before,
            m.distance_after
        );
        // brightness percentiles, the thing a person sees first, within a hair
        for i in 0..7 {
            assert!(
                (m.after.q[i] - reference.q[i]).abs() < 0.03,
                "percentile {i} is off: {} against {}",
                m.after.q[i],
                reference.q[i]
            );
        }
        // and the colour balance and saturation too
        assert!((m.after.mid[0] - reference.mid[0]).abs() < 0.01, "red balance is off");
        assert!((m.after.mid[1] - reference.mid[1]).abs() < 0.01, "blue balance is off");
        assert!((m.after.sat - reference.sat).abs() < 0.04, "saturation is off");
        // it should warm the picture the way the reference was warmed
        assert!(m.values.temperature > 5.0, "the warmth was not found: {}", m.values.temperature);
    }

    /// Matching a picture to itself must leave it where it is.
    #[test]
    fn matching_a_picture_to_itself_changes_nothing_much() {
        let img = scene();
        let lut = pipeline::identity_lut();
        let base = EditParams::default();
        let own = stats(&develop_with(&img, &Tune::from_params(&base), &lut));
        let m = run(&img, &base, &lut, &own);
        let drift = |a: f32, b: f32| (a - b).abs();
        assert!(drift(m.values.exposure, 0.0) < 0.15, "exposure drifted to {}", m.values.exposure);
        assert!(drift(m.values.contrast, 0.0) < 8.0, "contrast drifted to {}", m.values.contrast);
        assert!(drift(m.values.temperature, 0.0) < 6.0, "warmth drifted to {}", m.values.temperature);
        assert!(m.distance_after <= m.distance_before + 1e-6);
    }

    /// A darker, flatter reference has to pull the photo down and flatten it,
    /// and a brighter one has to lift it: the direction, at least, is not
    /// negotiable.
    #[test]
    fn it_goes_the_right_way() {
        let img = scene();
        let lut = pipeline::identity_lut();
        let base = EditParams::default();
        let reference_of = |t: Tune| stats(&develop_with(&img, &t, &lut));
        let dark = reference_of(Tune { exposure: -1.0, ..Tune::from_params(&base) });
        let bright = reference_of(Tune { exposure: 1.0, ..Tune::from_params(&base) });
        let down = run(&img, &base, &lut, &dark).values.exposure;
        let up = run(&img, &base, &lut, &bright).values.exposure;
        assert!(down < -0.4, "a darker reference did not darken the photo: {down}");
        assert!(up > 0.4, "a brighter reference did not brighten the photo: {up}");
    }

    #[test]
    fn strength_blends_every_slider_by_the_same_share() {
        let from = Tune { exposure: 0.2, contrast: 10.0, ..Tune::default() };
        let to = Tune { exposure: 1.0, contrast: -30.0, temperature: 40.0, ..Tune::default() };
        assert_eq!(blend(&from, &to, 0.0), from);
        assert_eq!(blend(&from, &to, 1.0), to);
        let half = blend(&from, &to, 0.5);
        assert!((half.exposure - 0.6).abs() < 1e-6);
        assert!((half.contrast - -10.0).abs() < 1e-6);
        assert!((half.temperature - 20.0).abs() < 1e-6);
        // out of range is held, not extrapolated
        assert_eq!(blend(&from, &to, 5.0), to);
    }

    #[test]
    fn a_finished_bitmap_is_measured_as_it_stands() {
        // a mid grey bitmap must measure as mid grey, not as whatever the app's
        // tone curve turns it into
        let srgb_mid = 0.5f32;
        let lin = ((srgb_mid + 0.055) / 1.055).powf(2.4);
        let dwg = mul3(&crate::color::SRGB_TO_DWG, [lin, lin, lin]);
        let img = LinearImage { width: 16, height: 16, data: (0..256).flat_map(|_| dwg).collect() };
        let s = reference_stats(&img, false, &pipeline::identity_lut());
        assert!((s.q[3] - 0.5).abs() < 0.01, "a 0.5 grey bitmap measured as {}", s.q[3]);
        assert!(s.sat < 0.02, "grey measured as saturated: {}", s.sat);
    }

    #[test]
    fn an_empty_picture_does_not_panic() {
        assert_eq!(stats(&[]).sat, 0.0);
    }
}
