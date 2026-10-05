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
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f32::max)
}

fn mean_diff(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).sum::<f32>() / a.len() as f32
}

fn temp_cube(name: &str, text: &str) -> String {
    let path =
        std::env::temp_dir().join(format!("darkroom-check-{}-{name}.cube", std::process::id()));
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
    assert!(
        max_diff(&plain, &looked) < 1e-3,
        "max diff {}",
        max_diff(&plain, &looked)
    );
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
        [
            (e * i - f * h) * k,
            (c * h - b * i) * k,
            (b * f - c * e) * k,
        ],
        [
            (f * g - d * i) * k,
            (a * i - c * g) * k,
            (c * d - a * f) * k,
        ],
        [
            (d * h - e * g) * k,
            (b * g - a * h) * k,
            (a * e - b * d) * k,
        ],
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
    let shoulder = |x: f32| {
        if x <= 0.8 {
            x
        } else {
            0.8 + 0.2 * (1.0 - (-(x - 0.8) / 0.2).exp())
        }
    };
    let srgb = |x: f32| {
        if x <= 0.003_130_8 {
            12.92 * x
        } else {
            1.055 * x.powf(1.0 / 2.4) - 0.055
        }
    };
    let n = 33;
    let mut text = format!("LUT_3D_SIZE {n}\n");
    for b in 0..n {
        for g in 0..n {
            for r in 0..n {
                let s = (n - 1) as f32;
                let lin = [
                    decode(r as f32 / s),
                    decode(g as f32 / s),
                    decode(b as f32 / s),
                ];
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
    let (mean, max) = (
        mean_diff(&reference, &through_lut),
        max_diff(&reference, &through_lut),
    );
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
    assert!(
        changed_inside,
        "the spot did not change anything inside its circle"
    );
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
    assert!(
        row_mean(&masked, 0) > row_mean(&plain, 0) + 0.02,
        "top row did not brighten"
    );
    for y in (H * 3 / 10)..H {
        let i = y * W * 3;
        assert!(
            max_diff(&masked[i..i + W * 3], &plain[i..i + W * 3]) < 1e-5,
            "row {y} outside the mask changed"
        );
    }
}

#[test]
fn mono_profile_is_neutral() {
    let mut p = quiet();
    p.profile = "mono".into();
    let out = develop(&test_card(), &p);
    for px in out.chunks_exact(3) {
        assert!(
            (px[0] - px[1]).abs() < 1e-6 && (px[1] - px[2]).abs() < 1e-6,
            "{px:?}"
        );
    }
}

#[test]
fn presets_never_carry_frame_specific_fields() {
    let full = serde_json::to_value(EditParams::default()).unwrap();
    let preset = crate::preset::filter(&full);
    let obj = preset.as_object().unwrap();
    for k in [
        "crop",
        "rotation",
        "transform",
        "masks",
        "heal",
        "lensProfile",
        "watermark",
        "mirror",
        "blend",
        "marked",
    ] {
        assert!(!obj.contains_key(k), "preset carries {k}");
    }
    for k in [
        "exposure", "curves", "profile", "look", "lens", "grain", "star",
    ] {
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
    for k in [
        "look",
        "masks",
        "heal",
        "transform",
        "lens",
        "lensProfile",
        "profile",
        "dehaze",
    ] {
        obj.remove(k);
    }
    let opened: EditParams = serde_json::from_value(old).expect("an older sidecar must still open");
    assert_eq!(opened.profile, "standard");
    assert_eq!(opened.look.input, "display");
}

// ---- double exposure ----

/// A solid-colour sRGB PNG on disk, to stand in for the second photograph.
fn temp_png(name: &str, w: u32, h: u32, rgb: [u8; 3]) -> String {
    let path =
        std::env::temp_dir().join(format!("darkroom-check-{}-{name}.png", std::process::id()));
    let buf = image::ImageBuffer::from_fn(w, h, |_, _| image::Rgb(rgb));
    buf.save(&path).expect("write test png");
    path.to_string_lossy().into_owned()
}

fn blend(path: String, mode: &str) -> crate::blend::Blend {
    crate::blend::Blend {
        path,
        name: "check".into(),
        mode: mode.into(),
        ..Default::default()
    }
}

#[test]
fn double_exposure_at_zero_opacity_changes_nothing() {
    let img = test_card();
    let base = develop(&img, &quiet());
    for mode in ["expose", "screen", "multiply", "softlight", "difference"] {
        let mut p = quiet();
        p.blend = blend(temp_png("blend-off", 32, 32, [200, 120, 60]), mode);
        p.blend.opacity = 0.0;
        assert_eq!(max_diff(&base, &develop(&img, &p)), 0.0, "mode {mode}");
    }
    // and the same with the layer switched off
    let mut p = quiet();
    p.blend = blend(temp_png("blend-off", 32, 32, [200, 120, 60]), "screen");
    p.blend.enabled = false;
    assert_eq!(max_diff(&base, &develop(&img, &p)), 0.0);
}

#[test]
fn exposing_a_second_picture_only_adds_light() {
    let img = test_card();
    let base = develop(&img, &quiet());
    let mut p = quiet();
    p.blend = blend(temp_png("blend-grey", 40, 40, [128, 128, 128]), "expose");
    let out = develop(&img, &p);
    // a second exposure can only ever brighten the negative
    for (a, b) in out.iter().zip(&base) {
        assert!(
            *a >= *b - 1e-5,
            "the double exposure darkened a pixel: {a} < {b}"
        );
    }
    assert!(
        mean_diff(&out, &base) > 0.05,
        "the second exposure did nothing"
    );
}

#[test]
fn a_scaled_down_overlay_leaves_the_rest_of_the_frame_alone() {
    let img = test_card();
    let base = develop(&img, &quiet());
    let mut p = quiet();
    p.blend = blend(temp_png("blend-small", 40, 40, [255, 255, 255]), "screen");
    p.blend.fit = "contain".into();
    p.blend.scale = 25.0;
    let out = develop(&img, &p);
    let corner = |v: &[f32], x: usize, y: usize| {
        let i = (y * W + x) * 3;
        [v[i], v[i + 1], v[i + 2]]
    };
    for (x, y) in [(0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1)] {
        assert_eq!(
            corner(&out, x, y),
            corner(&base, x, y),
            "corner {x},{y} moved"
        );
    }
    // the middle, where it does sit, is screened towards white
    let mid = (H / 2 * W + W / 2) * 3;
    assert!(
        out[mid] > base[mid] + 0.1,
        "the overlay is missing from the centre"
    );
}

#[test]
fn blend_modes_pull_the_picture_the_way_they_say() {
    let img = test_card();
    let base = develop(&img, &quiet());
    let grey = temp_png("blend-mid", 40, 40, [128, 128, 128]);
    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
    let with = |mode: &str| {
        let mut p = quiet();
        p.blend = blend(grey.clone(), mode);
        develop(&img, &p)
    };
    assert!(mean(&with("screen")) > mean(&base), "screen must lighten");
    assert!(
        mean(&with("multiply")) < mean(&base),
        "multiply must darken"
    );
    // lighten and darken never cross the original in the wrong direction
    for (a, b) in with("lighten").iter().zip(&base) {
        assert!(*a >= *b - 1e-5, "lighten darkened a pixel");
    }
    for (a, b) in with("darken").iter().zip(&base) {
        assert!(*a <= *b + 1e-5, "darken lightened a pixel");
    }
    // normal at full opacity replaces the picture with a flat frame
    let flat = with("normal");
    let first = [flat[0], flat[1], flat[2]];
    for px in flat.chunks_exact(3) {
        assert!(
            max_diff(px, &first) < 1e-4,
            "normal is not flat: {px:?} vs {first:?}"
        );
    }
}

#[test]
fn an_unreadable_second_picture_is_skipped_rather_than_fatal() {
    let img = test_card();
    let base = develop(&img, &quiet());
    let mut p = quiet();
    p.blend = blend("Z:/no/such/photo.jpg".into(), "screen");
    assert_eq!(max_diff(&base, &develop(&img, &p)), 0.0);
}

// ---- colour management ----

/// Every exported file must be tagged sRGB. The preview canvas is colour
/// managed by the webview, so an untagged export only matches the app by luck:
/// on a calibrated or wide-gamut display the two drift apart badly.
#[test]
fn exports_are_tagged_as_srgb() {
    let img = test_card();
    let dir = std::env::temp_dir();
    for (ext, format, depth) in [
        ("jpg", "jpeg", 8),
        ("png", "png", 8),
        ("png", "png", 16),
        ("tif", "tiff", 16),
    ] {
        let out = dir.join(format!(
            "darkroom-icc-{}-{format}{depth}.{ext}",
            std::process::id()
        ));
        let req = crate::export::ExportRequest {
            out_path: out.to_string_lossy().into_owned(),
            format: format.into(),
            quality: 90,
            bit_depth: depth,
            max_long_edge: None,
            params: quiet(),
            lut: Vec::new(),
        };
        crate::export::export(&img, &req)
            .unwrap_or_else(|e| panic!("export {format}{depth}: {e:#}"));
        let bytes = std::fs::read(&out).expect("read the export back");
        // each container carries the profile its own way: JPEG in an APP2
        // segment introduced by "ICC_PROFILE", PNG deflated inside an iCCP
        // chunk, TIFF verbatim in tag 34675
        let profile = crate::icc::srgb();
        let has = |needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
        let found = match format {
            "jpeg" => has(b"ICC_PROFILE"),
            "png" => has(b"iCCP"),
            _ => has(&profile[..64]),
        };
        assert!(found, "{format} {depth}-bit carries no ICC profile");
        std::fs::remove_file(&out).ok();
    }
}

// ---- output sharpening ----

/// Sharpening must move brightness only. It used to add its luma delta to
/// each channel, and adding the same number to R, G and B does not keep their
/// ratios: the bright side of a halo lost saturation and the dark side gained
/// it, which on a coloured edge reads as a colour fringe.
#[test]
fn sharpening_a_coloured_edge_keeps_its_hue() {
    const W: usize = 32;
    const H: usize = 8;
    // a saturated red block against a dark one: a hard, coloured edge
    let mut img = vec![0.0f32; W * H * 3];
    for y in 0..H {
        for x in 0..W {
            let i = (y * W + x) * 3;
            let bright = x < W / 2;
            img[i] = if bright { 0.60 } else { 0.10 };
            img[i + 1] = if bright { 0.12 } else { 0.02 };
            img[i + 2] = if bright { 0.09 } else { 0.015 };
        }
    }
    let before = img.clone();
    crate::pipeline::sharpen(&mut img, W, H, 100.0);

    let mut worst = 0.0f32;
    let mut changed = 0.0f32;
    let mut looked = 0;
    for y in 1..H - 1 {
        for x in 1..W - 1 {
            let i = (y * W + x) * 3;
            changed = changed.max((img[i + 1] - before[i + 1]).abs());
            // a halo that overshoots to black or white has no hue left to
            // keep, and clipping is a brightness limit rather than a tint
            let clipped = (0..3).any(|c| img[i + c] <= 0.0005 || img[i + c] >= 0.9995);
            if clipped {
                continue;
            }
            let ratio = |p: &[f32]| (p[i] / p[i + 1].max(1e-6), p[i + 2] / p[i + 1].max(1e-6));
            let (r0, b0) = ratio(&before);
            let (r1, b1) = ratio(&img);
            worst = worst.max((r1 - r0).abs() / r0).max((b1 - b0).abs() / b0);
            looked += 1;
        }
    }
    assert!(
        changed > 0.01,
        "the edge was not sharpened at all ({changed})"
    );
    assert!(
        looked > 20,
        "not enough unclipped pixels to judge ({looked})"
    );
    assert!(
        worst < 0.02,
        "sharpening shifted the colour of the edge by {:.1}% - it should only change brightness",
        worst * 100.0
    );
}

/// Grain has to roughen the picture without moving its exposure, and it has to
/// survive the whole export path rather than only existing in `grain.rs`.
#[test]
fn grain_roughens_the_picture_without_moving_its_exposure() {
    let card = test_card();
    let clean = develop(&card, &quiet());
    let mut p = quiet();
    p.grain = crate::grain::Grain {
        amount: 80.0,
        size: 30.0,
        colour: 0.0,
    };
    let grainy = develop(&card, &p);

    let mean = |v: &[f32]| v.iter().sum::<f32>() / v.len() as f32;
    let (a, b) = (mean(&clean), mean(&grainy));
    assert!(
        (a - b).abs() < 0.02,
        "grain shifted the exposure: {a} -> {b}"
    );

    // second difference along a row: a smooth ramp reads as zero, grain does not
    let rough = |v: &[f32]| {
        let mut s = 0.0f32;
        for y in 0..H {
            for x in 1..W - 1 {
                let i = (y * W + x) * 3;
                s += (2.0 * v[i] - v[i - 3] - v[i + 3]).abs();
            }
        }
        s / ((H * (W - 2)) as f32)
    };
    let (rc, rg) = (rough(&clean), rough(&grainy));
    assert!(
        rg > rc * 3.0 + 0.002,
        "grain hardly roughened anything: {rc} -> {rg}"
    );
}

/// Two exports of the same photo must carry identical grain, otherwise the
/// grain is coming from a random number and the preview can never match.
#[test]
fn grain_is_the_same_every_render() {
    let card = test_card();
    let mut p = quiet();
    p.grain = crate::grain::Grain {
        amount: 60.0,
        size: 50.0,
        colour: 50.0,
    };
    assert_eq!(max_diff(&develop(&card, &p), &develop(&card, &p)), 0.0);
}

/// A subtract mask has to take its area out of the mask above it and leave the
/// rest of that mask, and the picture outside it, exactly as they were.
#[test]
fn a_subtract_mask_cuts_a_hole_in_the_mask_above_it() {
    let img = test_card();
    let plain = develop(&img, &quiet());

    let bright = MaskAdjust {
        exposure: 1.5,
        ..Default::default()
    };
    // a soft-edged band down the left half, then the top half of it cut away
    let band = Mask {
        kind: "linear".into(),
        x0: 0.0,
        y0: 0.5,
        x1: 0.5,
        y1: 0.5,
        adjust: bright.clone(),
        ..Default::default()
    };
    let cut = Mask {
        kind: "linear".into(),
        mode: "subtract".into(),
        x0: 0.5,
        y0: 0.0,
        x1: 0.5,
        y1: 0.1,
        ..Default::default()
    };

    let mut whole = quiet();
    whole.masks = vec![band.clone()];
    let whole = develop(&img, &whole);
    let mut p = quiet();
    p.masks = vec![band, cut];
    let out = develop(&img, &p);

    // the top row was lifted by the band and the cut takes nearly all of it
    // back (nearly, not exactly: the cut has a feathered edge of its own)
    let lift = row_mean(&whole, 0) - row_mean(&plain, 0);
    assert!(
        lift > 0.01,
        "the band did not brighten the top row at all: {lift}"
    );
    let left = row_mean(&out, 0) - row_mean(&plain, 0);
    assert!(
        left < lift * 0.1,
        "the cut barely removed anything: {left} of {lift}"
    );
    // the bottom row is clear of the cut and still carries the band untouched
    let i = (H - 1) * W * 3;
    assert!(
        row_mean(&out, H - 1) > row_mean(&plain, H - 1) + 0.01,
        "the cut removed the whole band"
    );
    assert!(
        max_diff(&out[i..i + W * 3], &whole[i..i + W * 3]) < 1e-5,
        "the band changed where it was not cut"
    );
    // the right-hand half was never in the band
    let at = |v: &[f32], x: usize, y: usize| v[(y * W + x) * 3];
    assert!(
        (at(&out, W - 1, H / 2) - at(&plain, W - 1, H / 2)).abs() < 1e-5,
        "pixels outside the band moved"
    );
}

/// A subtract mask is not a mask of its own: on its own it must do nothing,
/// and its own adjustment sliders must never reach the picture.
#[test]
fn a_subtract_mask_alone_changes_nothing() {
    let img = test_card();
    let plain = develop(&img, &quiet());
    let mut p = quiet();
    p.masks = vec![Mask {
        kind: "radial".into(),
        mode: "subtract".into(),
        adjust: MaskAdjust {
            exposure: 3.0,
            ..Default::default()
        },
        ..Default::default()
    }];
    assert!(max_diff(&plain, &develop(&img, &p)) < 1e-6);
}

/// Motion Trails pointed at a mask must streak the masked subject and nothing
/// else: another bright object in the frame casts no trail, and the subject
/// itself keeps its own pixels so it stays sharp.
#[test]
fn a_masked_motion_trail_only_streaks_the_masked_subject() {
    // two white blocks on black: one will be masked, one will not
    let mut img = vec![0.0f32; W * H * 3];
    let mut block = |x0: usize, x1: usize| {
        for y in 24..40 {
            for x in x0..x1 {
                for c in 0..3 {
                    img[(y * W + x) * 3 + c] = 1.0;
                }
            }
        }
    };
    block(10, 20);
    block(50, 60);

    let subject = Mask {
        id: "subject-1".into(),
        kind: "radial".into(),
        cx: 15.0 / W as f32,
        cy: 0.5,
        rx: 7.0 / W as f32,
        ry: 9.0 / W as f32,
        feather: 1.0,
        ..Default::default()
    };
    // legacy Mirror storage: cx = copies/10, ry = amount, feather = fade,
    // length = distance, rx = blur
    let trail = crate::pipeline::Mirror {
        enabled: true,
        cx: 0.3,
        rx: 0.0,
        ry: 1.0,
        feather: 100.0,
        offset: 0.0,
        length: 0.2,
        direction: 0.0,
        opacity: 100.0,
        mask: "subject-1".into(),
        ..Default::default()
    };

    let masks = vec![subject];
    let out = crate::export::motion_trail_pass(&img, W, H, &trail, &masks);
    let whole = crate::export::motion_trail_pass(
        &img,
        W,
        H,
        &crate::pipeline::Mirror {
            mask: String::new(),
            ..trail.clone()
        },
        &masks,
    );
    let at = |v: &[f32], x: usize, y: usize| v[(y * W + x) * 3];

    // the masked block trails to its right
    assert!(
        at(&out, 28, 32) > 0.05,
        "the masked subject cast no trail: {}",
        at(&out, 28, 32)
    );
    // the unmasked block does not, though it does when the trail is frame-wide
    assert!(
        at(&out, 70, 32) < 1e-6,
        "an unmasked object cast a trail: {}",
        at(&out, 70, 32)
    );
    assert!(
        at(&whole, 70, 32) > 0.05,
        "the frame-wide trail stopped working: {}",
        at(&whole, 70, 32)
    );
    // and the subject itself is untouched, so it keeps all of its detail
    for x in 10..20 {
        assert!(
            (at(&out, x, 32) - at(&img, x, 32)).abs() < 1e-6,
            "the subject was lightened at x={x}"
        );
    }
}

/// Subject Feather softens the edge the trail is cut from. It must not also
/// soften what the subject keeps: doing that rubbed out the brightest part of
/// the trail, the part right beside the subject, and the effect looked weak.
#[test]
fn feathering_a_masked_trail_does_not_weaken_it() {
    let mut img = vec![0.0f32; W * H * 3];
    for y in 24..40 {
        for x in 10..20 {
            for c in 0..3 {
                img[(y * W + x) * 3 + c] = 1.0;
            }
        }
    }
    let masks = vec![Mask {
        id: "s".into(),
        kind: "radial".into(),
        cx: 15.0 / W as f32,
        cy: 0.5,
        rx: 7.0 / W as f32,
        ry: 9.0 / W as f32,
        feather: 1.0,
        ..Default::default()
    }];
    let trail = |offset: f32| crate::pipeline::Mirror {
        enabled: true,
        cx: 0.3,
        rx: 0.0,
        ry: 1.0,
        feather: 100.0,
        offset,
        length: 0.2,
        direction: 0.0,
        opacity: 100.0,
        mask: "s".into(),
        ..Default::default()
    };

    let hard = crate::export::motion_trail_pass(&img, W, H, &trail(0.0), &masks);
    let soft = crate::export::motion_trail_pass(&img, W, H, &trail(0.25), &masks);
    let at = |v: &[f32], x: usize, y: usize| v[(y * W + x) * 3];

    // just past the subject, where the trail is brightest
    let (a, b) = (at(&hard, 24, 32), at(&soft, 24, 32));
    assert!(a > 0.05, "the unfeathered trail is missing: {a}");
    assert!(b > a * 0.5, "feathering gutted the trail: {a} -> {b}");
    // and the subject itself is still untouched either way
    for x in 10..20 {
        assert!((at(&soft, x, 32) - at(&img, x, 32)).abs() < 1e-6, "the subject was lightened at x={x}");
    }
}

/// A watermark belongs to the picture you end up with, not to the one you
/// started from: cropping must not move it out of its corner, or off the frame.
#[test]
fn a_watermark_keeps_its_corner_when_the_photo_is_cropped() {
    use crate::pipeline::{Watermark, WatermarkImage};

    // a small solid red mark
    let mark = WatermarkImage {
        width: 8,
        height: 8,
        rgba: (0..8 * 8).flat_map(|_| [255u8, 0, 0, 255]).collect(),
    };
    let wm = Watermark {
        enabled: true,
        path: "x".into(),
        // bottom right, as a signature would be
        x: 0.85,
        y: 0.9,
        size: 0.12,
        opacity: 100.0,
    };

    // Place it on a frame, and on the crop of that frame, and ask where it
    // landed relative to each. Both have to put it in the same corner.
    let red_centroid = |v: &[f32], w: usize, h: usize| -> (f32, f32) {
        let (mut sx, mut sy, mut n) = (0.0f32, 0.0f32, 0.0f32);
        for y in 0..h {
            for x in 0..w {
                let i = (y * w + x) * 3;
                if v[i] > 0.5 && v[i + 1] < 0.2 {
                    sx += x as f32 / w as f32;
                    sy += y as f32 / h as f32;
                    n += 1.0;
                }
            }
        }
        assert!(n > 0.0, "the watermark is not on the frame at all");
        (sx / n, sy / n)
    };

    let (fw, fh) = (200usize, 150usize);
    let mut full = vec![0.5f32; fw * fh * 3];
    crate::pipeline::watermark_pass(&mut full, fw, fh, &wm, &mark);
    let on_full = red_centroid(&full, fw, fh);

    // the same mark on a frame cropped to half the width and height
    let (cw, ch) = (100usize, 75usize);
    let mut cropped = vec![0.5f32; cw * ch * 3];
    crate::pipeline::watermark_pass(&mut cropped, cw, ch, &wm, &mark);
    let on_crop = red_centroid(&cropped, cw, ch);

    assert!(
        (on_full.0 - on_crop.0).abs() < 0.02 && (on_full.1 - on_crop.1).abs() < 0.02,
        "the mark sits at {on_full:?} of the whole frame but {on_crop:?} of the cropped one"
    );
    // and it really is in the bottom right, not merely consistent
    assert!(on_crop.0 > 0.7 && on_crop.1 > 0.75, "the mark is not in its corner: {on_crop:?}");
}

#[cfg(test)]
mod hsl {
    use super::*;
    use crate::color::{mul3, SRGB_TO_DWG};
    use crate::pipeline::{hsl_band_weight, hsl_push, EditParams};

    const CENTRES: [f32; 8] = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 275.0, 310.0];
    const NAMES: [&str; 8] = ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];

    fn srgb_dec(v: f32) -> f32 {
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    }

    fn patch(hdeg: f32, s: f32, v: f32) -> [f32; 3] {
        let c = v * s;
        let h = hdeg / 60.0;
        let x = c * (1.0 - (h % 2.0 - 1.0).abs());
        let (r, g, b) = match h as i32 {
            0 => (c, x, 0.0),
            1 => (x, c, 0.0),
            2 => (0.0, c, x),
            3 => (0.0, x, c),
            4 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        let m = v - c;
        mul3(&SRGB_TO_DWG, [srgb_dec(r + m), srgb_dec(g + m), srgb_dec(b + m)])
    }

    fn hsv_of(rgb: [f32; 3]) -> [f32; 3] {
        let (r, g, b) = (rgb[0], rgb[1], rgb[2]);
        let mx = r.max(g).max(b);
        let mn = r.min(g).min(b);
        let d = mx - mn;
        let h = if d < 1e-6 {
            0.0
        } else if mx == r {
            60.0 * (((g - b) / d) % 6.0)
        } else if mx == g {
            60.0 * ((b - r) / d + 2.0)
        } else {
            60.0 * ((r - g) / d + 4.0)
        };
        [h.rem_euclid(360.0), if mx > 1e-6 { d / mx } else { 0.0 }, mx]
    }

    fn through(p: &EditParams, hdeg: f32) -> [f32; 3] {
        let c = patch(hdeg, 0.85, 0.75);
        let img = LinearImage { width: 1, height: 1, data: c.to_vec() };
        let out = develop(&img, p);
        hsv_of([out[0], out[1], out[2]])
    }

    /// The eight bands have to divide the hue circle between them: a hue on a
    /// centre belongs wholly to that band, and every hue's weights add to one.
    /// They are not evenly spaced, so a fixed reach cannot do this - with one,
    /// a band reached past its neighbour's centre.
    #[test]
    fn the_bands_divide_the_hue_circle_between_them() {
        for (i, name) in NAMES.iter().enumerate() {
            let own = hsl_band_weight(CENTRES[i], i);
            assert!((own - 1.0).abs() < 1e-5, "{name} does not own its own centre: {own}");
            for (j, other) in NAMES.iter().enumerate() {
                if i == j {
                    continue;
                }
                let bleed = hsl_band_weight(CENTRES[j], i);
                assert!(bleed < 1e-5, "{name} reaches as far as {other}: {bleed}");
            }
        }
        // and nowhere on the circle do they add up to anything but one
        for step in 0..720 {
            let h = step as f32 * 0.5;
            let sum: f32 = (0..8).map(|i| hsl_band_weight(h, i)).sum();
            assert!((sum - 1.0).abs() < 1e-4, "at {h} degrees the weights add to {sum}");
        }
    }

    /// Pushing a band must move its own colour further than anything else.
    /// It used to move the neighbour further: Red moved orange by +0.097 and
    /// red itself by only +0.061.
    #[test]
    fn a_band_moves_its_own_colour_most() {
        for (i, name) in NAMES.iter().enumerate() {
            let mut p = quiet();
            p.hsl.saturation[i] = 100.0;
            let own = through(&p, CENTRES[i])[1] - through(&quiet(), CENTRES[i])[1];
            assert!(own > 0.01, "{name} barely moved its own colour: {own:+.4}");
            for (j, other) in NAMES.iter().enumerate() {
                if i == j {
                    continue;
                }
                let bleed = (through(&p, CENTRES[j])[1] - through(&quiet(), CENTRES[j])[1]).abs();
                assert!(
                    bleed < own * 0.5,
                    "{name} moved {other} by {bleed:+.4}, against {own:+.4} of its own"
                );
            }
        }
    }

    /// Saturation and luminance used to multiply, so a colour already near the
    /// top had nowhere to go and the same slider did four times as much to
    /// yellow as to blue. Closing a share of what is left always has somewhere
    /// to go, and never overshoots.
    #[test]
    fn pushing_a_band_never_runs_into_the_ceiling() {
        for start in [0.0f32, 0.2, 0.5, 0.9, 0.99, 1.0] {
            for amount in [-1.0f32, -0.5, 0.0, 0.5, 1.0] {
                let out = hsl_push(start, amount);
                assert!((0.0..=1.0).contains(&out), "{start} pushed by {amount} left 0..1: {out}");
                if amount > 0.0 && start < 1.0 {
                    assert!(out > start, "pushing {start} up by {amount} did nothing");
                }
                if amount < 0.0 && start > 0.0 {
                    assert!(out < start, "pulling {start} down by {amount} did nothing");
                }
            }
        }
        assert_eq!(hsl_push(0.4, 0.0), 0.4, "a band at rest must change nothing");
    }
}

#[cfg(test)]
mod profiles {
    use super::*;

    /// How far a profile moves the picture against Standard, averaged over the
    /// test card.
    fn distance_from_standard(id: &str) -> f32 {
        let img = test_card();
        let mut base = quiet();
        base.profile = "standard".into();
        let mut p = quiet();
        p.profile = id.into();
        mean_diff(&develop(&img, &base), &develop(&img, &p))
    }

    /// A profile you cannot see is a profile that is not there. Neutral and
    /// Portrait used to move the picture by six and seven thousandths, which is
    /// below noticing; the whole set was about half as strong as it reads.
    #[test]
    fn every_profile_is_visibly_its_own_thing() {
        for id in ["flat", "neutral", "portrait", "landscape", "vivid", "mono"] {
            let d = distance_from_standard(id);
            assert!(d > 0.012, "the {id} profile barely changes anything: {d:.4}");
        }
        // and the strong ones have to be clearly stronger than the mild ones
        assert!(
            distance_from_standard("vivid") > distance_from_standard("neutral") * 2.0,
            "Vivid is not much more than Neutral"
        );
        assert!(
            distance_from_standard("landscape") > distance_from_standard("neutral") * 2.0,
            "Landscape is not much more than Neutral"
        );
    }

    /// Two profiles that do the same thing are one profile with two names.
    #[test]
    fn the_profiles_differ_from_each_other() {
        let img = test_card();
        let out = |id: &str| {
            let mut p = quiet();
            p.profile = id.into();
            develop(&img, &p)
        };
        let ids = ["flat", "neutral", "portrait", "landscape", "vivid"];
        for (i, a) in ids.iter().enumerate() {
            for b in ids.iter().skip(i + 1) {
                let d = mean_diff(&out(a), &out(b));
                assert!(d > 0.004, "{a} and {b} are nearly the same picture: {d:.4}");
            }
        }
    }
}
