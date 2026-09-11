//! End-to-end checks of the develop pipeline on synthetic images.
//!
//! They run with `cargo test`, need no photos, and so run in CI as well. Each
//! one guards a promise the app makes: a setting at its neutral value changes
//! nothing, a look built for S-Log3 lands where the published maths says it
//! should, retouch spots stay inside their circle, presets never move the
//! picture, and old sidecars still open.

use crate::camlog;
use crate::color::{mul3, DWG_TO_SRGB, SRGB_TO_DWG};
use crate::decode::LinearImage;
use crate::export::develop_full;
use crate::geometry::{geometry_pass, Lens, Transform, Warp};
use crate::heal::{heal_image, HealSpot};
use crate::mask::{Mask, MaskAdjust};
use crate::pipeline::{identity_lut, Crop, EditParams, Look};

const W: usize = 96;
const H: usize = 64;

/// A test card in linear DaVinci Wide Gamut: a nine-stop grey ramp across the
/// top half, colour patches (inside sRGB, so gamut mapping stays out of the
/// way) across the bottom half.
fn test_card() -> LinearImage {
    let patches: [[f32; 3]; 6] = [
        [0.30, 0.12, 0.08],
        [0.10, 0.25, 0.08],
        [0.08, 0.10, 0.28],
        [0.30, 0.26, 0.08],
        [0.08, 0.24, 0.26],
        [0.26, 0.10, 0.24],
    ];
    let mut data = vec![0.0f32; W * H * 3];
    for y in 0..H {
        for x in 0..W {
            let t = x as f32 / (W - 1) as f32;
            let rgb = if y < H / 2 {
                let grey = 0.005 * 2f32.powf(t * 9.0);
                [grey, grey, grey]
            } else {
                mul3(&SRGB_TO_DWG, patches[x * 6 / W])
            };
            data[(y * W + x) * 3..(y * W + x) * 3 + 3].copy_from_slice(&rgb);
        }
    }
    LinearImage {
        width: W,
        height: H,
        data,
    }
}

/// Default settings with the whole-image filters that would blur comparisons turned off.
fn quiet() -> EditParams {
    let mut p = EditParams::default();
    p.denoise_luma = 0.0;
    p.denoise_chroma = 0.0;
    p.sharpen = 0.0;
    p
}

fn develop(img: &LinearImage, p: &EditParams) -> Vec<f32> {
    develop_full(img, p, &identity_lut())
}

fn max_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

fn mean_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f32>() / a.len() as f32
}

fn temp_cube(name: &str, text: &str) -> String {
    let path = std::env::temp_dir().join(format!("darkroom-check-{}-{name}.cube", std::process::id()));
    std::fs::write(&path, text).expect("write test cube");
    path.to_string_lossy().into_owned()
}

fn look(path: String, input: &str) -> Look {
    Look {
        enabled: true,
        path,
        name: "check".into(),
        amount: 100.0,
        input: input.into(),
    }
}

fn row_mean(img: &[f32], y: usize) -> f32 {
    img[y * W * 3..(y + 1) * W * 3].iter().sum::<f32>() / (W * 3) as f32
}

#[test]
fn default_develop_is_finite_and_in_range() {
    let out = develop(&test_card(), &quiet());
    assert!(out.iter().all(|v| v.is_finite() && (0.0..=1.0).contains(v)));
}

#[test]
fn identity_cube_look_changes_nothing() {
    let mut text = String::from("LUT_3D_SIZE 2\n");
    for b in 0..2 {
        for g in 0..2 {
            for r in 0..2 {
                text.push_str(&format!("{r} {g} {b}\n"));
            }
        }
    }
    let img = test_card();
    let plain = develop(&img, &quiet());
    let mut p = quiet();
    p.look = look(temp_cube("identity", &text), "display");
    let looked = develop(&img, &p);
    assert!(max_diff(&plain, &looked) < 1e-3, "max diff {}", max_diff(&plain, &looked));
}

#[test]
fn look_amount_zero_changes_nothing() {
    let mut text = String::from("LUT_1D_SIZE 2\n1 1 1\n0 0 0\n"); // an inverting look
    text.push('\n');
    let img = test_card();
    let plain = develop(&img, &quiet());
    let mut p = quiet();
    p.look = look(temp_cube("invert", &text), "display");
    p.look.amount = 0.0;
    assert!(max_diff(&plain, &develop(&img, &p)) < 1e-6);
}

/// Invert a 3x3 matrix (test helper).
fn inv3(m: &[[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let [[a, b, c], [d, e, f], [g, h, i]] = *m;
    let det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    let k = 1.0 / det;
    [
        [(e * i - f * h) * k, (c * h - b * i) * k, (b * f - c * e) * k],
        [(f * g - d * i) * k, (a * i - c * g) * k, (c * d - a * f) * k],
        [(d * h - e * g) * k, (b * g - a * h) * k, (a * e - b * d) * k],
    ]
}

fn mat_mul(a: &[[f32; 3]; 3], b: &[[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut o = [[0.0; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            o[r][c] = (0..3).map(|k| a[r][k] * b[k][c]).sum();
        }
    }
    o
}

/// A technical "S-Log3 / S-Gamut3.Cine to display" LUT built from Sony's
/// published curve and primaries, pushed through Darkroom's S-Log3 input,
/// must land on Darkroom's own flat render. A wrong log curve, a wrong gamut
/// matrix or a look applied at the wrong stage all show up as a shift.
#[test]
fn slog3_technical_lut_lands_on_the_flat_render() {
    let (enc, dwg_to_sgc) = camlog::input("slog3-sgamut3cine");
    assert_eq!(enc, camlog::ENC_SLOG3);
    let sgc_to_srgb = mat_mul(&DWG_TO_SRGB, &inv3(&dwg_to_sgc));
    let decode = |v: f32| {
        let cv = v * 1023.0;
        if cv >= 171.210_29 {
            10f32.powf((cv - 420.0) / 261.5) * 0.19 - 0.01
        } else {
            (cv - 95.0) * 0.011_25 / (171.210_29 - 95.0)
        }
    };
    let shoulder = |x: f32| if x <= 0.8 { x } else { 0.8 + 0.2 * (1.0 - (-(x - 0.8) / 0.2).exp()) };
    let srgb = |x: f32| if x <= 0.003_130_8 { 12.92 * x } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 };
    let n = 33;
    let mut text = format!("LUT_3D_SIZE {n}\n");
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let s = (n - 1) as f32;
                let lin = [decode(r as f32 / s), decode(g as f32 / s), decode(b as f32 / s)];
                let o = mul3(&sgc_to_srgb, lin).map(|x| srgb(shoulder(x.max(0.0)).min(1.0)));
                text.push_str(&format!("{} {} {}\n", o[0], o[1], o[2]));
            }
        }
    }
    let img = test_card();
    let mut flat = quiet();
    flat.base_contrast = 0.0;
    let reference = develop(&img, &flat);
    let mut p = quiet();
    p.look = look(temp_cube("slog3", &text), "slog3-sgamut3cine");
    let through_lut = develop(&img, &p);
    let (mean, max) = (mean_diff(&reference, &through_lut), max_diff(&reference, &through_lut));
    assert!(mean < 0.01 && max < 0.06, "mean {mean}, max {max}");
}

#[test]
fn heal_spot_only_touches_its_disc() {
    let mut img = test_card().data;
    let before = img.clone();
    let spot = HealSpot {
        x: 0.5,
        y: 0.75,
        sx: 0.2,
        sy: 0.75,
        radius: 0.08,
        feather: 0.0,
        opacity: 100.0,
        ..Default::default()
    };
    heal_image(&mut img, W, H, &[spot]);
    let r = 0.08 * W.max(H) as f32;
    let (cx, cy) = (0.5 * W as f32, 0.75 * H as f32);
    let mut changed_inside = false;
    for y in 0..H {
        for x in 0..W {
            let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
            let i = (y * W + x) * 3;
            let moved = (0..3).any(|c| (img[i + c] - before[i + c]).abs() > 1e-6);
            if d > r + 1.0 {
                assert!(!moved, "pixel ({x},{y}) outside the spot changed");
            } else if d < r * 0.5 && moved {
                changed_inside = true;
            }
        }
    }
    assert!(changed_inside, "the spot did not change anything inside its circle");
}

#[test]
fn identity_geometry_is_a_no_op() {
    let img = test_card();
    let warp = Warp::new(&Transform::default(), &Lens::default(), None, W, H);
    assert!(warp.is_identity());
    let (out, w, h) = geometry_pass(&img.data, W, H, &Crop::default(), &warp);
    assert_eq!((w, h), (W, H));
    assert!(max_diff(&out, &img.data) < 1e-6);
}

#[test]
fn mask_with_zero_amount_is_a_no_op() {
    let img = test_card();
    let plain = develop(&img, &quiet());
    let mut p = quiet();
    p.masks = vec![Mask {
        amount: 0.0,
        adjust: MaskAdjust {
            exposure: 2.0,
            ..Default::default()
        },
        ..Default::default()
    }];
    assert!(max_diff(&plain, &develop(&img, &p)) < 1e-6);
}

#[test]
fn exposure_mask_brightens_only_where_it_applies() {
    let img = test_card();
    let plain = develop(&img, &quiet());
    let mut p = quiet();
    // full effect along the top edge, fading out a quarter of the way down
    p.masks = vec![Mask {
        kind: "linear".into(),
        x0: 0.5,
        y0: 0.0,
        x1: 0.5,
        y1: 0.25,
        adjust: MaskAdjust {
            exposure: 1.0,
            ..Default::default()
        },
        ..Default::default()
    }];
    let masked = develop(&img, &p);
    assert!(row_mean(&masked, 0) > row_mean(&plain, 0) + 0.02, "top row did not brighten");
    for y in (H * 3 / 10)..H {
        let i = y * W * 3;
        assert!(max_diff(&masked[i..i + W * 3], &plain[i..i + W * 3]) < 1e-5, "row {y} outside the mask changed");
    }
}

#[test]
fn mono_profile_is_neutral() {
    let mut p = quiet();
    p.profile = "mono".into();
    let out = develop(&test_card(), &p);
    for px in out.chunks_exact(3) {
        assert!((px[0] - px[1]).abs() < 1e-6 && (px[1] - px[2]).abs() < 1e-6, "{px:?}");
    }
}

#[test]
fn presets_never_carry_frame_specific_fields() {
    let full = serde_json::to_value(EditParams::default()).unwrap();
    let preset = crate::preset::filter(&full);
    let obj = preset.as_object().unwrap();
    for k in ["crop", "rotation", "transform", "masks", "heal", "lensProfile", "watermark", "mirror"] {
        assert!(!obj.contains_key(k), "preset carries {k}");
    }
    for k in ["exposure", "curves", "profile", "look", "lens"] {
        assert!(obj.contains_key(k), "preset is missing {k}");
    }
}

#[test]
fn sidecars_round_trip_and_old_ones_still_open() {
    let mut p = EditParams::default();
    p.look.input = "slog3-sgamut3cine".into();
    p.heal = vec![HealSpot::default()];
    p.masks = vec![Mask::default()];
    p.transform.vertical = 12.0;
    let json = serde_json::to_string(&p).unwrap();
    let back: EditParams = serde_json::from_str(&json).unwrap();
    assert_eq!(back.look.input, "slog3-sgamut3cine");
    assert_eq!(back.heal.len(), 1);
    assert_eq!(back.masks.len(), 1);
    assert_eq!(back.transform.vertical, 12.0);

    // a sidecar written before looks, masks, retouching and lens corrections existed
    let mut old = serde_json::to_value(EditParams::default()).unwrap();
    let obj = old.as_object_mut().unwrap();
    for k in ["look", "masks", "heal", "transform", "lens", "lensProfile", "profile", "dehaze"] {
        obj.remove(k);
    }
    let opened: EditParams = serde_json::from_value(old).expect("an older sidecar must still open");
    assert_eq!(opened.profile, "standard");
    assert_eq!(opened.look.input, "display");
}
