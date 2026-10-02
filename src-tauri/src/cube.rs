//! Export the current look as a `.cube` 3D LUT, so it can be used in Resolve,
//! Premiere, FCP, OBS, a camera, or anything else that loads a cube.
//!
//! A cube is a lookup from one colour to another: 3 numbers in, 3 numbers out.
//! That makes it a faithful carrier for everything in Darkroom that depends
//! only on a pixel's own colour - white balance, exposure, the tone controls,
//! the base and point curves, vibrance and saturation, HSL, colour grading, the
//! picture profile and a creative look - and it cannot carry anything that
//! depends on a pixel's *neighbours* or on where it sits in the frame. Texture,
//! clarity, dehaze, sharpening, noise reduction, grain, the starburst, motion
//! trails, masks, retouch spots, crop, lens corrections and the double exposure
//! are all left out, and `excluded()` says which of them were actually in use
//! so the app can tell the photographer rather than quietly dropping them.
//!
//! The LUT is display-referred: feed it Rec.709/sRGB and you get Darkroom's
//! look back. Each lattice point is decoded from sRGB to linear light, taken
//! into the working space, run through exactly the same `develop_pixel` the
//! export uses, and written out as the display value that comes back. So the
//! cube is not an approximation of the pipeline - it is the pipeline, sampled.

use anyhow::{Context, Result};
use rayon::prelude::*;
use std::fmt::Write as _;
use std::path::Path;

use crate::color::{mul3, SRGB_TO_DWG};
use crate::lut3d::Lut3d;
use crate::pipeline::{self, EditParams, Uniforms};

/// Lattice sizes offered. 33 is what most cube files in the wild use; 65 is
/// what Resolve exports for a look that needs the extra precision.
pub const SIZES: [usize; 3] = [17, 33, 65];

/// sRGB EOTF: display code value to linear light. Inverse of `srgb_enc` in
/// pipeline.rs, which is what the lattice output is encoded with.
#[inline]
fn srgb_dec(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

/// Settings a cube cannot carry, named the way the panels name them, and only
/// the ones this photo is actually using.
pub fn excluded(p: &EditParams) -> Vec<&'static str> {
    let mut out = Vec::new();
    if p.texture != 0.0 {
        out.push("Texture");
    }
    if p.clarity != 0.0 {
        out.push("Clarity");
    }
    if p.dehaze != 0.0 {
        out.push("Dehaze");
    }
    if p.sharpen > 0.0 {
        out.push("Sharpening");
    }
    if p.denoise_luma > 0.0 || p.denoise_chroma > 0.0 {
        out.push("Noise Reduction");
    }
    if p.grain.is_active() {
        out.push("Grain");
    }
    if p.star.is_active() {
        out.push("Starburst");
    }
    if p.mirror.enabled && p.mirror.opacity > 0.0 {
        out.push("Motion Trails");
    }
    if p.masks.iter().any(|m| m.is_active()) {
        out.push("Masks");
    }
    if !p.heal.is_empty() {
        out.push("Object Remover");
    }
    if p.blend.enabled && !p.blend.path.is_empty() {
        out.push("Double Exposure");
    }
    if p.crop.enabled {
        out.push("Crop");
    }
    if p.watermark.enabled && !p.watermark.path.is_empty() {
        out.push("Watermark");
    }
    out
}

/// The colour-only part of an edit: the spatial settings zeroed, so sampling the
/// lattice cannot reach code that wants a neighbourhood it does not have.
fn colour_only(p: &EditParams) -> EditParams {
    let mut q = p.clone();
    q.texture = 0.0;
    q.clarity = 0.0;
    q.dehaze = 0.0;
    q.sharpen = 0.0;
    q.denoise_luma = 0.0;
    q.denoise_chroma = 0.0;
    q.masks = Vec::new();
    q.heal = Vec::new();
    q.grain = Default::default();
    q.star = Default::default();
    q.blend = Default::default();
    q
}

/// The lattice itself, in cube order: red fastest, then green, then blue.
pub fn lattice(params: &EditParams, lut: &[f32], size: usize, look: Option<&Lut3d>) -> Vec<[f32; 3]> {
    let size = size.clamp(2, 129);
    let p = colour_only(params);
    let u = Uniforms::from_params(&p);
    let n = size - 1;
    let mut out = vec![[0.0f32; 3]; size * size * size];
    out.par_chunks_mut(size).enumerate().for_each(|(row, line)| {
        let b = row / size;
        let g = row % size;
        for (r, o) in line.iter_mut().enumerate() {
            // display code value -> linear light -> working space
            let srgb = [
                srgb_dec(r as f32 / n as f32),
                srgb_dec(g as f32 / n as f32),
                srgb_dec(b as f32 / n as f32),
            ];
            let dwg = mul3(&SRGB_TO_DWG, srgb);
            // the same per-pixel develop the export runs, with no neighbourhood
            let v = pipeline::develop_pixel_gain(dwg, None, &u.tone, &u, lut, 1.0, look, None);
            *o = [v[0].clamp(0.0, 1.0), v[1].clamp(0.0, 1.0), v[2].clamp(0.0, 1.0)];
        }
    });
    out
}

/// Format a lattice as cube text. `title` is what a host shows in its LUT list.
pub fn format(values: &[[f32; 3]], size: usize, title: &str) -> String {
    let clean: String = title
        .chars()
        .map(|c| if c == '"' || c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let mut s = String::with_capacity(values.len() * 26 + 256);
    let _ = writeln!(s, "# Created by Darkroom");
    let _ = writeln!(s, "# Display-referred: Rec.709 / sRGB in, Rec.709 / sRGB out.");
    let _ = writeln!(s, "# Carries tone, colour, curves, HSL, grading, profile and look only.");
    let _ = writeln!(s, "TITLE \"{}\"", clean.trim());
    let _ = writeln!(s, "LUT_3D_SIZE {size}");
    let _ = writeln!(s, "DOMAIN_MIN 0.0 0.0 0.0");
    let _ = writeln!(s, "DOMAIN_MAX 1.0 1.0 1.0");
    for v in values {
        let _ = writeln!(s, "{:.6} {:.6} {:.6}", v[0], v[1], v[2]);
    }
    s
}

/// Write the look beside the photo (or wherever the photographer chose).
pub fn write(out: &Path, params: &EditParams, lut: &[f32], size: usize, title: &str, look: Option<&Lut3d>) -> Result<()> {
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).ok();
        }
    }
    let values = lattice(params, lut, size, look);
    let text = format(&values, size.clamp(2, 129), title);
    std::fs::write(out, text).with_context(|| format!("write {}", out.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::identity_lut;

    fn quiet() -> EditParams {
        let mut p = EditParams::default();
        p.sharpen = 0.0;
        p.denoise_chroma = 0.0;
        p
    }

    #[test]
    fn srgb_decode_is_the_inverse_of_the_encode_the_pipeline_uses() {
        // the lattice input has to undo exactly what develop_pixel's last step did
        for i in 0..=100 {
            let v = i as f32 / 100.0;
            let round = pipeline::srgb_enc(srgb_dec(v));
            assert!((round - v).abs() < 1e-5, "{v} -> {round}");
        }
    }

    #[test]
    fn a_cube_of_a_neutral_edit_is_near_enough_an_identity() {
        // the default profile has a base curve, so "neutral" means the look the
        // app shows with nothing touched - sampling it and applying it back has
        // to land where the pipeline lands, which is what the next test checks.
        // Here we only ask that the lattice is monotonic and spans the range.
        let size = 17;
        let v = lattice(&quiet(), &identity_lut(), size, None);
        assert_eq!(v.len(), size * size * size);
        let grey = |i: usize| v[i * (1 + size + size * size)][1];
        for i in 1..size {
            assert!(grey(i) >= grey(i - 1) - 1e-6, "grey ramp went backwards at {i}");
        }
        assert!(grey(0) < 0.02, "black did not stay black: {}", grey(0));
        assert!(grey(size - 1) > 0.98, "white did not stay white: {}", grey(size - 1));
    }

    /// The real promise: a host applying this cube to an sRGB image gets what
    /// Darkroom shows. Round-trip it through the app's own .cube parser and
    /// compare against the pipeline, pixel for pixel.
    #[test]
    fn applying_the_cube_reproduces_the_pipeline() {
        let mut p = quiet();
        p.exposure = 0.6;
        p.contrast = 30.0;
        p.temperature = -25.0;
        p.saturation = 20.0;
        p.vibrance = 15.0;
        p.hsl.hue[1] = 20.0;
        p.hsl.saturation[5] = -30.0;
        p.grading.shadow_sat = 40.0;
        p.grading.shadow_hue = 220.0;

        let lut = identity_lut();
        let size = 65;
        let text = format(&lattice(&p, &lut, size, None), size, "test");
        let cube = Lut3d::parse(&text, "test".into()).expect("the app must be able to read its own cube");

        let u = Uniforms::from_params(&p);
        let mut worst = 0.0f32;
        let mut at = [0.0f32; 3];
        // walk a coarse grid of display colours, the way a host would feed it
        for r in 0..13 {
            for g in 0..13 {
                for b in 0..13 {
                    let d = [r as f32 / 12.0, g as f32 / 12.0, b as f32 / 12.0];
                    let dwg = mul3(&SRGB_TO_DWG, [srgb_dec(d[0]), srgb_dec(d[1]), srgb_dec(d[2])]);
                    let want = pipeline::develop_pixel_gain(dwg, None, &u.tone, &u, &lut, 1.0, None, None);
                    let got = cube.sample(d);
                    for c in 0..3 {
                        let e = (want[c].clamp(0.0, 1.0) - got[c]).abs();
                        if e > worst {
                            worst = e;
                            at = d;
                        }
                    }
                }
            }
        }
        // a 65-point lattice interpolated trilinearly: a couple of code values
        assert!(worst < 0.01, "cube drifted from the pipeline by {worst} at {at:?}");
    }

    #[test]
    fn the_cube_says_what_it_had_to_leave_behind() {
        let mut p = quiet();
        assert!(excluded(&p).is_empty(), "{:?}", excluded(&p));
        p.clarity = 40.0;
        p.grain.amount = 50.0;
        p.star.enabled = true;
        p.sharpen = 25.0;
        let out = excluded(&p);
        for k in ["Clarity", "Grain", "Starburst", "Sharpening"] {
            assert!(out.contains(&k), "{k} was not reported as excluded: {out:?}");
        }
        assert!(!out.contains(&"Masks"), "nothing was masked: {out:?}");
    }

    #[test]
    fn the_header_is_well_formed_and_the_title_cannot_break_it() {
        let size = 2;
        let text = format(&lattice(&quiet(), &identity_lut(), size, None), size, "a \"quoted\"\nname");
        assert!(text.contains("LUT_3D_SIZE 2"));
        assert!(text.lines().filter(|l| l.starts_with("TITLE")).count() == 1);
        assert!(!text.contains("\"quoted\""), "the title was not sanitised: {text}");
        assert!(Lut3d::parse(&text, "x".into()).is_ok());
    }
}
