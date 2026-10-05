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
fn search(
    start: [f32; N],
    free: &[usize],
    mut loss: impl FnMut(&[f32; N]) -> f32,
    base: [f32; N],
    limits: &[(f32, f32); N],
    pull: f32,
) -> [f32; N] {
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
            let range = limits[k].1 - limits[k].0;
            r += ((p[k] - base[k]) / range).powi(2);
        }
        loss(p) + pull * r
    };
    let mut best = reg(&p, &mut loss);
    let mut step = STEPS;
    let mut evals = 0;
    while evals < 900 {
        let mut improved = false;
        for &k in free {
            for dir in [1.0f32, -1.0] {
                let mut q = p;
                q[k] = (p[k] + dir * step[k]).clamp(limits[k].0, limits[k].1);
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
    run_with(src, base, lut, reference, &LIMITS, 0.004)
}

/// How far Auto may push each slider. A match to a reference is allowed to go a
/// long way, because the reference asked for it; Auto is a suggestion made on
/// the photo's own behalf, and a suggestion that needs Contrast at +80 is not
/// one worth making. Tighter, and with a stronger pull towards leaving things be.
pub const AUTO_LIMITS: [(f32, f32); N] = [
    (-2.0, 2.0),
    (-40.0, 40.0),
    (-45.0, 45.0),
    (-45.0, 45.0),
    (-40.0, 40.0),
    (-40.0, 40.0),
    (-25.0, 25.0),
    (-25.0, 25.0),
    (-35.0, 35.0),
];
const AUTO_PULL: f32 = 0.03;

/// The vibrance Auto applies, which is a matter of taste rather than of
/// measurement and so a constant. Twin of the 18 in applyAutoLook in App.tsx.
///
/// It has to be in the photo when the photo is measured. Auto used to measure the
/// picture without it and then add it, so pressing Auto a second time measured a
/// picture that already had it and landed a hair differently - contrast 22 the
/// first time and 23 the second. Measured with it in place, the first and every
/// press after are the same.
pub const AUTO_VIBRANCE: f32 = 18.0;

/// As `run`, with the slider limits and the pull towards the starting values
/// given.
pub fn run_with(
    src: &LinearImage,
    base: &EditParams,
    lut: &[f32],
    reference: &ToneStats,
    limits: &[(f32, f32); N],
    pull: f32,
) -> Match {
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
        cur = search(cur, &[0, 1, 2, 3, 4, 5], |a| tone_loss(&eval(a), reference), origin, limits, pull);
        cur = search(cur, &[6, 7], |a| colour_loss(&eval(a), reference), origin, limits, pull);
        cur = search(cur, &[8], |a| sat_loss(&eval(a), reference), origin, limits, pull);
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

/// What a photo should look like once it has been looked after, worked out from
/// the photo itself.
///
/// Auto used to be a fixed recipe - the same contrast, highlights, shadows and
/// vibrance on every photo, the only thing it read being the noise level - so a
/// dark photo and a bright one got the same treatment. This reads where the
/// photo's tones actually sit and moves them to where a well-exposed one would,
/// by as much as it needs rather than as much as a constant says.
///
///  * The black and white points go to just inside the ends of the range, so the
///    picture uses the room it has without clipping.
///  * The middle moves part of the way towards a comfortable brightness. Only
///    part: a night scene should stay a night scene, so a dark photo is lifted and
///    not turned into a daylight one.
///  * Tones in between follow, kept in order, with a little added contrast.
///  * A colour cast is reduced by about a third rather than removed. A warm
///    sunset is a warm sunset; a photo shot under the wrong light is not.
///  * Saturation is brought into a sensible range if it is outside it.
pub fn auto_target(s: &ToneStats) -> ToneStats {
    let (lo, hi) = (s.q[0], s.q[6]);
    let median = s.q[3];
    let aim = (median + 0.4 * (0.46 - median)).clamp(0.12, 0.72);
    // where each measured tone should land: black and white at the ends, the
    // median at `aim`, the rest in proportion on each side
    // Part of the way to the ends of the range, not all of it. Taking the 99th
    // percentile all the way to 0.97 asks for a threefold stretch of the top of
    // a photo whose highlights are bunched together - a bright sky, say - and the
    // only way to deliver that is Contrast and Highlights at their limits, which
    // is a harsh picture. Measured on a real photo: Contrast +80, Highlights +80.
    let t_lo = if lo > 0.03 { lo + 0.6 * (0.03 - lo) } else { lo.max(0.0) };
    let t_hi = if hi < 0.96 { hi + 0.55 * (0.96 - hi) } else { 0.96 };
    // And never more than about one and a half times the range the photo already has. A flat,
    // foggy photo asked to fill the whole scale is a threefold stretch, and the
    // only way to deliver it is Contrast at the end of its travel - a picture
    // that looks processed rather than looked after.
    let (t_lo, t_hi) = {
        let have = (hi - lo).max(1e-3);
        let want = (t_hi - t_lo).max(1e-3);
        let k = (1.6 * have / want).min(1.0);
        (aim + (t_lo - aim) * k, aim + (t_hi - aim) * k)
    };
    let map = |v: f32| -> f32 {
        let out = if v <= median {
            let span = (median - lo).max(1e-4);
            t_lo + (aim - t_lo) * ((v - lo) / span)
        } else {
            let span = (hi - median).max(1e-4);
            aim + (t_hi - aim) * ((v - median) / span)
        };
        // a touch more contrast about the middle
        (aim + (out - aim) * 1.06).clamp(0.0, 1.0)
    };
    let mut q = [0.0f32; 7];
    for i in 0..7 {
        q[i] = map(s.q[i]);
    }
    // keep them strictly ordered whatever the arithmetic did
    for i in 1..7 {
        q[i] = q[i].max(q[i - 1]);
    }
    let neutral = 1.0 / 3.0;
    let mid = [s.mid[0] + 0.35 * (neutral - s.mid[0]), s.mid[1] + 0.35 * (neutral - s.mid[1])];
    let sat = s.sat.clamp(0.22, 0.55) + 0.02;
    ToneStats { q, mid, sat }
}

/// Look after a photo: find the sliders that move it to `auto_target` of itself.
///
/// It starts from the tone sliders at zero rather than where they are, so
/// pressing Auto twice gives the same answer whatever was done in between.
pub fn auto(src: &LinearImage, base: &EditParams, lut: &[f32]) -> Match {
    let mut neutral = base.clone();
    neutral.exposure = 0.0;
    neutral.contrast = 0.0;
    neutral.highlights = 0.0;
    neutral.shadows = 0.0;
    neutral.whites = 0.0;
    neutral.blacks = 0.0;
    neutral.temperature = 0.0;
    neutral.tint = 0.0;
    neutral.saturation = 0.0;
    neutral.vibrance = AUTO_VIBRANCE;
    let mut proxy = neutral.clone();
    proxy.texture = 0.0;
    proxy.clarity = 0.0;
    proxy.dehaze = 0.0;
    proxy.masks.clear();
    proxy.heal.clear();
    let here = stats(&pipeline::develop_buffer(&src.data, src.width, None, &proxy, lut));
    run_with(src, &neutral, lut, &auto_target(&here), &AUTO_LIMITS, AUTO_PULL)
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

    /// A scene lit by a ramp from `lo` to `hi` (linear), crossed with a cast.
    fn lit(lo: f32, hi: f32, cast: f32) -> LinearImage {
        let mut data = vec![0.0f32; W * H * 3];
        for y in 0..H {
            for x in 0..W {
                let u = x as f32 / (W - 1) as f32;
                let l = lo + (hi - lo) * u.powf(1.6);
                let i = (y * W + x) * 3;
                data[i] = l * (1.0 + cast);
                data[i + 1] = l;
                data[i + 2] = l * (1.0 - cast);
            }
        }
        LinearImage { width: W, height: H, data }
    }

    /// Auto has to read the photo: a dark one is lifted, a bright one is pulled
    /// down, and neither ends up treated like the other.
    #[test]
    fn auto_lifts_a_dark_photo_and_pulls_a_bright_one() {
        let lut = pipeline::identity_lut();
        let base = EditParams::default();
        let dark = lit(0.002, 0.12, 0.0);
        let bright = lit(0.25, 3.0, 0.0);
        let a = auto(&dark, &base, &lut);
        let b = auto(&bright, &base, &lut);
        println!("\ndark   median {:.3} -> {:.3}  exposure {:+.2}", a.before.q[3], a.after.q[3], a.values.exposure);
        println!("bright median {:.3} -> {:.3}  exposure {:+.2}", b.before.q[3], b.after.q[3], b.values.exposure);
        assert!(a.after.q[3] > a.before.q[3] + 0.04, "a dark photo was not lifted");
        assert!(b.after.q[3] < b.before.q[3] - 0.04, "a bright photo was not pulled down");
        assert!(a.values.exposure > b.values.exposure + 0.5, "Auto gave the dark and bright photos the same treatment");
        // a night scene stays a night scene: lifted, not turned into daylight
        assert!(a.after.q[3] < 0.40, "a dark photo was turned into a bright one: {}", a.after.q[3]);
    }

    /// A picture whose brightness percentiles are exactly `q` (display values),
    /// built by sampling the quantile function; grey, so only tone is in play.
    fn from_quantiles(q: [f32; 7]) -> LinearImage {
        let marks = [0.0f32, 0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99, 1.0];
        let vals = [
            (q[0] - 0.02).max(0.0),
            q[0],
            q[1],
            q[2],
            q[3],
            q[4],
            q[5],
            q[6],
            (q[6] + 0.02).min(1.0),
        ];
        let n = W * H;
        let mut data = vec![0.0f32; n * 3];
        for i in 0..n {
            let t = i as f32 / (n - 1) as f32;
            let mut k = 0;
            while k + 2 < marks.len() && t > marks[k + 1] {
                k += 1;
            }
            let f = ((t - marks[k]) / (marks[k + 1] - marks[k]).max(1e-6)).clamp(0.0, 1.0);
            let disp = vals[k] + (vals[k + 1] - vals[k]) * f;
            let lin = if disp <= 0.04045 { disp / 12.92 } else { ((disp + 0.055) / 1.055).powf(2.4) };
            let g = mul3(&crate::color::SRGB_TO_DWG, [lin, lin, lin]);
            // scatter the values rather than leaving them in a ramp
            let j = (i * 7919) % n;
            data[j * 3..j * 3 + 3].copy_from_slice(&g);
        }
        LinearImage { width: W, height: H, data }
    }

    /// Auto must never need a slider at the end of its travel. Run on a spread of
    /// real-world shapes, including a bright photo with its highlights bunched
    /// together, measured off an actual photograph, where it used to set Contrast
    /// and Highlights to +80.
    #[test]
    fn auto_never_slams_a_slider_into_its_limit() {
        let lut = pipeline::identity_lut();
        let shapes: [(&str, [f32; 7]); 5] = [
            ("bunched highlights (a real photo)", [0.039, 0.10, 0.273, 0.687, 0.764, 0.79, 0.818]),
            ("low key", [0.01, 0.02, 0.05, 0.12, 0.26, 0.45, 0.62]),
            ("high key", [0.30, 0.45, 0.66, 0.84, 0.93, 0.98, 1.0]),
            ("flat and grey", [0.28, 0.31, 0.38, 0.45, 0.52, 0.58, 0.62]),
            ("contrasty", [0.0, 0.01, 0.12, 0.45, 0.80, 0.97, 1.0]),
        ];
        println!("\nshape                                 exposure contrast highl shadows whites blacks");
        for (name, q) in shapes {
            let m = auto(&from_quantiles(q), &EditParams::default(), &lut);
            let v = m.values;
            println!(
                "{name:36} {:+7.2} {:+8.1} {:+5.1} {:+7.1} {:+6.1} {:+6.1}",
                v.exposure, v.contrast, v.highlights, v.shadows, v.whites, v.blacks
            );
            // What matters is that the picture is not harsh, which is a matter of
            // what came out, not of where a slider sits: nothing clips, and no
            // tone is thrown across more than a third of the scale.
            assert!(m.after.q[0] > 0.0 && m.after.q[6] < 1.0, "{name}: Auto clipped the picture");
            for i in 0..7 {
                let moved = (m.after.q[i] - m.before.q[i]).abs();
                assert!(moved < 0.34, "{name}: Auto threw percentile {i} across {moved:.2} of the scale");
            }
            for (label, val, lim) in [
                ("highlights", v.highlights, 45.0f32),
                ("shadows", v.shadows, 45.0),
                ("whites", v.whites, 40.0),
                ("blacks", v.blacks, 40.0),
            ] {
                assert!(
                    val.abs() < lim - 0.5,
                    "{name}: Auto put {label} at {val:+.1}, against the end of its travel at {lim}"
                );
            }
            // Contrast is the one slider allowed to use its whole range, and only
            // on a photo that really is flat: a picture spanning a third of the
            // scale needs a lot of it, and the limit is there so that it cannot
            // have more. Everything else must leave room.
            // judged on the shape it was given, before the app's own tone curve
            let flat = q[6] - q[0] < 0.45;
            assert!(
                flat || v.contrast.abs() < 39.5,
                "{name}: Auto put contrast at {:+.1} on a photo that is not flat",
                v.contrast
            );
            assert!(v.exposure.abs() < 2.0 - 0.05, "{name}: Auto re-exposed by {:+.2} stops", v.exposure);
        }
    }

    /// The black and white points go to the ends of the range, so the picture
    /// uses the room it has.
    #[test]
    fn auto_uses_the_range_a_flat_photo_leaves_unused() {
        let lut = pipeline::identity_lut();
        let flat = lit(0.12, 0.30, 0.0);
        let m = auto(&flat, &EditParams::default(), &lut);
        let spread = |q: &[f32; 7]| q[6] - q[0];
        println!("\nspread {:.3} -> {:.3}", spread(&m.before.q), spread(&m.after.q));
        // Clearly wider, but gently: about a quarter as much again, where the
        // first version took it from 0.30 to 0.55 and needed Contrast at +80 on
        // real photos to do it. See auto_target.
        assert!(spread(&m.after.q) > spread(&m.before.q) * 1.15, "a flat photo was not stretched");
        assert!(spread(&m.after.q) < spread(&m.before.q) * 2.0, "a flat photo was stretched past double its range");
        assert!(m.after.q[6] < 1.0 && m.after.q[0] >= 0.0, "it clipped");
    }

    /// A photo that is already fine should come out about as it went in.
    #[test]
    fn auto_leaves_a_well_exposed_photo_alone() {
        let lut = pipeline::identity_lut();
        let m = auto(&scene(), &EditParams::default(), &lut);
        println!("\nfine photo: exposure {:+.2}", m.values.exposure);
        assert!(m.values.exposure.abs() < 0.6, "a fine photo was re-exposed by {}", m.values.exposure);
        for i in 0..7 {
            assert!((m.after.q[i] - m.before.q[i]).abs() < 0.15, "percentile {i} moved by {}", m.after.q[i] - m.before.q[i]);
        }
    }

    /// A cast is reduced, not erased.
    #[test]
    fn auto_softens_a_colour_cast_without_removing_it() {
        let lut = pipeline::identity_lut();
        let warm = lit(0.01, 0.8, 0.22);
        let m = auto(&warm, &EditParams::default(), &lut);
        let neutral = 1.0 / 3.0;
        let before = (m.before.mid[0] - neutral).abs();
        let after = (m.after.mid[0] - neutral).abs();
        println!("\nred balance off neutral by {before:.4} -> {after:.4}");
        assert!(after < before * 0.9, "the cast was not reduced: {before:.4} -> {after:.4}");
        assert!(after > before * 0.3, "the cast was erased: {before:.4} -> {after:.4}");
    }

    /// Pressing Auto twice is the same as pressing it once, wherever the tone
    /// sliders were left in between.
    #[test]
    fn auto_gives_the_same_answer_whatever_was_done_before() {
        let lut = pipeline::identity_lut();
        let img = lit(0.003, 0.25, 0.05);
        let fresh = auto(&img, &EditParams::default(), &lut);
        let mut fiddled = EditParams::default();
        fiddled.exposure = 1.5;
        fiddled.contrast = -40.0;
        fiddled.temperature = 30.0;
        // and with the vibrance a first press leaves behind, which is what a
        // second press actually meets
        fiddled.vibrance = AUTO_VIBRANCE;
        let after = auto(&img, &fiddled, &lut);
        assert_eq!(fresh.values, after.values, "Auto depends on what the sliders were");
    }

    #[test]
    fn an_empty_picture_does_not_panic() {
        assert_eq!(stats(&[]).sat, 0.0);
    }
}
