//! Colour-space constants shared by the decoder, the CPU pipeline and (by copy)
//! the GLSL in `src/gl/shaders.ts`.
//!
//! Working space: linear DaVinci Wide Gamut (DWG), D65. It comfortably contains
//! every camera gamut and Rec.2020, so saturated colours survive the camera
//! matrix instead of being clipped at decode. Display transform goes
//! DWG -> linear sRGB -> gamut compression -> tone shoulder -> sRGB OETF.
//! Matrices derived from the published DWG primaries
//! R(0.8000,0.3130) G(0.1682,0.9877) B(0.0790,-0.1155) W(0.3127,0.3290).

pub const DWG_TO_XYZ: [[f32; 3]; 3] = [
    [0.700622392, 0.148774815, 0.101058720],
    [0.274118511, 0.873631896, -0.147750407],
    [-0.098962913, -0.137895325, 1.325915989],
];

pub const SRGB_TO_DWG: [[f32; 3]; 3] = [
    [0.562767456, 0.323516589, 0.113715955],
    [0.077754635, 0.749577346, 0.172668019],
    [0.064669200, 0.191998692, 0.743332108],
];

pub const DWG_TO_SRGB: [[f32; 3]; 3] = [
    [1.898614899, -0.792176183, -0.106438716],
    [-0.168948786, 1.488975754, -0.320026968],
    [-0.121539161, -0.315675853, 1.437215014],
];

/// Positive-weight luminance proxy used for tone, local contrast and denoise
/// decisions inside DWG. (True DWG Y has a negative blue coefficient, which
/// would make ratios blow up on saturated blues.) Rec.2020 weights.
pub const LUMA_PROXY: [f32; 3] = [0.2627, 0.6780, 0.0593];

/// Rec.709 / sRGB luminance, used once we are in display space.
pub const LUMA_709: [f32; 3] = [0.2126, 0.7152, 0.0722];

#[inline]
pub fn mul3(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

#[inline]
pub fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
pub fn luma_proxy(c: [f32; 3]) -> f32 {
    dot3(c, LUMA_PROXY)
}

/// DaVinci Intermediate log encoding (scene-linear -> log). Provided for
/// LUT / log-space tools; the pipeline itself grades in log2 around 0.18.
pub fn davinci_intermediate_encode(l: f32) -> f32 {
    const A: f32 = 0.0075;
    const B: f32 = 7.0;
    const C: f32 = 0.07329248;
    const M: f32 = 10.44426855;
    const LIN_CUT: f32 = 0.00262409;
    if l <= LIN_CUT {
        l * M
    } else {
        ((l + A).log2() + B) * C
    }
}

pub fn davinci_intermediate_decode(v: f32) -> f32 {
    const A: f32 = 0.0075;
    const B: f32 = 7.0;
    const C: f32 = 0.07329248;
    const M: f32 = 10.44426855;
    const LOG_CUT: f32 = 0.02740668;
    if v <= LOG_CUT {
        v / M
    } else {
        2f32.powf(v / C - B) - A
    }
}
