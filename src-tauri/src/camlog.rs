//! Camera log encodings and gamuts, for looks built for log footage.
//!
//! A Sony "S-Log3 / S-Gamut3.Cine to LC-709" LUT, a Canon Log 3 LUT or a
//! Blackmagic Film LUT expects its input already encoded the way that camera
//! records video. To use one on a photo, the graded scene-linear image (linear
//! DaVinci Wide Gamut, 0.18 = mid grey) is converted into the camera gamut and
//! encoded with the camera's log curve, which is what a Color Space Transform
//! node does in Resolve before such a LUT.
//!
//! Every curve and set of primaries here comes from the manufacturer's
//! published specification. CPU twin of `src/camlog.ts` and `encodeLog` in the
//! develop shader.

pub type Mat3 = [[f32; 3]; 3];

/// Display-referred input: the LUT is applied to the finished picture.
pub const ENC_DISPLAY: u8 = 0;
pub const ENC_SLOG3: u8 = 1;
pub const ENC_CLOG3: u8 = 2;
pub const ENC_BMDFILM5: u8 = 3;
pub const ENC_DI: u8 = 4;

const D65: [f64; 2] = [0.3127, 0.3290];
const DWG: [[f64; 2]; 3] = [[0.8000, 0.3130], [0.1682, 0.9877], [0.0790, -0.1155]];
const S_GAMUT3_CINE: [[f64; 2]; 3] = [[0.766, 0.275], [0.225, 0.800], [0.089, -0.087]];
const S_GAMUT3: [[f64; 2]; 3] = [[0.730, 0.280], [0.140, 0.855], [0.100, -0.050]];
const CINEMA_GAMUT: [[f64; 2]; 3] = [[0.74, 0.27], [0.17, 1.14], [0.08, -0.10]];
const BMD_WG_GEN5: [[f64; 2]; 3] = [
    [0.717_721_5, 0.317_118_1],
    [0.228_041_0, 0.861_569_0],
    [0.100_584_1, -0.082_045_2],
];
const BMD_WG_GEN5_WHITE: [f64; 2] = [0.312_717_0, 0.329_031_2];

/// Look input ids as stored in the sidecar, with their display names.
pub const INPUTS: &[(&str, &str)] = &[
    ("display", "Rec.709 / sRGB (display)"),
    ("slog3-sgamut3cine", "Sony S-Log3 / S-Gamut3.Cine"),
    ("slog3-sgamut3", "Sony S-Log3 / S-Gamut3"),
    ("clog3-cinema", "Canon Log 3 / Cinema Gamut"),
    ("bmdfilm5-bmdwg5", "Blackmagic Film Gen 5 / Wide Gamut"),
    ("di-dwg", "DaVinci Intermediate / Wide Gamut"),
];

type M64 = [[f64; 3]; 3];

fn mul(a: &M64, b: &M64) -> M64 {
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    o
}

fn invert(m: &M64) -> M64 {
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

/// Normalised primary matrix: RGB with the given primaries and white -> XYZ.
fn npm(p: [[f64; 2]; 3], white: [f64; 2]) -> M64 {
    let xyz = |x: f64, y: f64| [x / y, 1.0, (1.0 - x - y) / y];
    let (r, g, b) = (
        xyz(p[0][0], p[0][1]),
        xyz(p[1][0], p[1][1]),
        xyz(p[2][0], p[2][1]),
    );
    let m = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
    let w = xyz(white[0], white[1]);
    let inv = invert(&m);
    let s: Vec<f64> = (0..3)
        .map(|i| (0..3).map(|k| inv[i][k] * w[k]).sum())
        .collect();
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = m[i][j] * s[j];
        }
    }
    o
}

fn to_f32(m: &M64) -> Mat3 {
    let mut o = [[0.0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = m[i][j] as f32;
        }
    }
    o
}

/// Linear DWG -> linear target gamut.
fn from_dwg(target: [[f64; 2]; 3], white: [f64; 2]) -> Mat3 {
    to_f32(&mul(&invert(&npm(target, white)), &npm(DWG, D65)))
}

const IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// Encoding and DWG -> camera gamut matrix for a look input id.
/// Unknown ids behave like "display".
pub fn input(id: &str) -> (u8, Mat3) {
    match id {
        "slog3-sgamut3cine" => (ENC_SLOG3, from_dwg(S_GAMUT3_CINE, D65)),
        "slog3-sgamut3" => (ENC_SLOG3, from_dwg(S_GAMUT3, D65)),
        "clog3-cinema" => (ENC_CLOG3, from_dwg(CINEMA_GAMUT, D65)),
        "bmdfilm5-bmdwg5" => (ENC_BMDFILM5, from_dwg(BMD_WG_GEN5, BMD_WG_GEN5_WHITE)),
        "di-dwg" => (ENC_DI, IDENTITY),
        _ => (ENC_DISPLAY, IDENTITY),
    }
}

/// Sony S-Log3, scene reflectance (0.18 = mid grey) -> full-range code value.
#[inline]
pub fn slog3(x: f32) -> f32 {
    if x >= 0.011_25 {
        (420.0 + ((x + 0.01) / 0.19).log10() * 261.5) / 1023.0
    } else {
        (x * (171.210_29 - 95.0) / 0.011_25 + 95.0) / 1023.0
    }
}

/// Canon Log 3 (v1.2), scene reflectance -> normalised code value.
#[inline]
pub fn clog3(x: f32) -> f32 {
    let x = x / 0.9;
    if x < -0.014 {
        -0.367_268_45 * (-x * 14.983_25 + 1.0).log10() + 0.127_839_01
    } else if x <= 0.014 {
        1.975_479_8 * x + 0.125_122_19
    } else {
        0.367_268_45 * (x * 14.983_25 + 1.0).log10() + 0.122_405_37
    }
}

/// Blackmagic Film Generation 5 OETF.
#[inline]
pub fn bmdfilm5(x: f32) -> f32 {
    const A: f32 = 0.086_928_76;
    const B: f32 = 0.005_494_072;
    const C: f32 = 0.530_013_3;
    const D: f32 = 8.283_606;
    const E: f32 = 0.092_465_75;
    if x < 0.005 {
        D * x + E
    } else {
        A * (x + B).ln() + C
    }
}

#[inline]
pub fn encode_channel(enc: u8, x: f32) -> f32 {
    match enc {
        ENC_SLOG3 => slog3(x),
        ENC_CLOG3 => clog3(x),
        ENC_BMDFILM5 => bmdfilm5(x),
        ENC_DI => crate::color::davinci_intermediate_encode(x),
        _ => x,
    }
}

#[inline]
pub fn encode(enc: u8, rgb: [f32; 3]) -> [f32; 3] {
    [
        encode_channel(enc, rgb[0]),
        encode_channel(enc, rgb[1]),
        encode_channel(enc, rgb[2]),
    ]
}

/// Guess a look's input from its file name or TITLE, the way LUT packs are
/// usually named ("SLog3SGamut3.CineToLC-709", "CanonLog3_to_709", ...).
pub fn detect(name: &str) -> &'static str {
    let n: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    if n.contains("slog3") {
        if n.contains("cine") {
            "slog3-sgamut3cine"
        } else {
            "slog3-sgamut3"
        }
    } else if n.contains("clog3") || n.contains("canonlog3") {
        "clog3-cinema"
    } else if n.contains("bmdfilm")
        || n.contains("blackmagicfilm")
        || n.contains("gen5")
        || n.contains("bmdwg")
    {
        "bmdfilm5-bmdwg5"
    } else if n.contains("davinciintermediate") || n.contains("dwg") || n.contains("davinciwide") {
        "di-dwg"
    } else {
        "display"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::DWG_TO_XYZ;

    fn close(a: f32, b: f32, tol: f32) -> bool {
        (a - b).abs() <= tol
    }

    #[test]
    fn dwg_matrix_matches_the_published_constant() {
        let m = to_f32(&npm(DWG, D65));
        for i in 0..3 {
            for j in 0..3 {
                assert!(close(m[i][j], DWG_TO_XYZ[i][j], 1e-4), "{m:?}");
            }
        }
    }

    #[test]
    fn mid_grey_code_values_match_the_specs() {
        assert!(close(slog3(0.18), 420.0 / 1023.0, 1e-5));
        assert!(close(slog3(0.0), 95.0 / 1023.0, 1e-5));
        assert!(close(clog3(0.18), 0.3434, 1e-3), "{}", clog3(0.18));
        assert!(close(bmdfilm5(0.18), 0.3836, 1e-3), "{}", bmdfilm5(0.18));
        assert!(close(
            crate::color::davinci_intermediate_encode(0.18),
            0.3360,
            1e-3
        ));
    }

    #[test]
    fn curves_are_continuous_at_their_cuts() {
        assert!(close(slog3(0.011_249), slog3(0.011_251), 1e-4));
        assert!(close(
            clog3(0.014 * 0.9 - 1e-6),
            clog3(0.014 * 0.9 + 1e-6),
            1e-4
        ));
        assert!(close(bmdfilm5(0.004_999), bmdfilm5(0.005_001), 1e-4));
    }

    #[test]
    fn gamut_matrices_keep_white_neutral() {
        for id in [
            "slog3-sgamut3cine",
            "slog3-sgamut3",
            "clog3-cinema",
            "bmdfilm5-bmdwg5",
            "di-dwg",
        ] {
            let (_, m) = input(id);
            let w = crate::color::mul3(&m, [1.0, 1.0, 1.0]);
            for c in w {
                assert!(close(c, 1.0, 2e-3), "{id}: {w:?}");
            }
        }
    }

    #[test]
    fn detects_common_lut_names() {
        assert_eq!(detect("SLog3SGamut3.CineToLC-709"), "slog3-sgamut3cine");
        assert_eq!(detect("1_SGamut3CineSLog3_To_LC-709"), "slog3-sgamut3cine");
        assert_eq!(detect("SLog3SGamut3ToRec709"), "slog3-sgamut3");
        assert_eq!(detect("CanonLog3_CinemaGamut_to_BT709"), "clog3-cinema");
        assert_eq!(detect("Blackmagic Gen 5 Film to Video"), "bmdfilm5-bmdwg5");
        assert_eq!(detect("DWG Intermediate to Rec709"), "di-dwg");
        assert_eq!(detect("Warm Film 65"), "display");
    }
}
