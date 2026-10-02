//! Decoding of every supported input format into one common representation:
//! interleaved linear-light RGB f32 in DaVinci Wide Gamut, D65 white.
//! RAW files keep highlight headroom above 1.0; JPEG/PNG/TIFF are clamped 0..1
//! before the sRGB -> DWG matrix.

use anyhow::{anyhow, bail, Context, Result};
use rawler::decoders::RawDecodeParams;
use rawler::imgop::chromatic_adaption::adapt_bradford;
use rawler::imgop::develop::{Intermediate, ProcessingStep, RawDevelop};
use rawler::imgop::matrix::{multiply, normalize, pseudo_inverse, transform_1d, IDENTITY_MATRIX_3};
use rawler::imgop::xyz::Illuminant;

use crate::color::{mul3, DWG_TO_XYZ, SRGB_TO_DWG};
use rawler::rawimage::RawPhotometricInterpretation;
use rawler::rawsource::RawSource;
use rawler::Orientation;
use rayon::prelude::*;
use serde::Serialize;
use std::path::Path;

pub struct LinearImage {
    pub width: usize,
    pub height: usize,
    /// interleaved RGB, linear light
    pub data: Vec<f32>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub kind: String,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<u32>,
    pub exposure_time: Option<String>,
    pub f_number: Option<f32>,
    pub focal_length: Option<f32>,
    pub date_taken: Option<String>,
}

pub const RAW_EXTENSIONS: &[&str] = &[
    "cr2", "cr3", "crw", "arw", "srf", "sr2", "nef", "nrw", "dng", "raf", "orf", "rw2", "pef",
    "iiq", "3fr", "erf", "mrw", "mef", "kdc", "dcr", "x3f",
];

pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "tif", "tiff"];

pub fn is_raw(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| RAW_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn load(path: &Path) -> Result<(LinearImage, Metadata)> {
    if is_raw(path) {
        load_raw(path)
    } else {
        load_image(path)
    }
}

fn rational_f32(r: &rawler::formats::tiff::Rational) -> Option<f32> {
    if r.d == 0 {
        None
    } else {
        Some(r.n as f32 / r.d as f32)
    }
}

fn format_exposure(n: u32, d: u32) -> Option<String> {
    if n == 0 || d == 0 {
        return None;
    }
    let v = n as f64 / d as f64;
    if v >= 1.0 {
        Some(format!("{}s", trim_float(v)))
    } else {
        Some(format!("1/{}", trim_float(1.0 / v)))
    }
}

fn trim_float(v: f64) -> String {
    if (v - v.round()).abs() < 1e-3 {
        format!("{}", v.round() as i64)
    } else {
        format!("{:.1}", v)
    }
}

// ---------------------------------------------------------------- RAW

fn load_raw(path: &Path) -> Result<(LinearImage, Metadata)> {
    let src = RawSource::new(path).with_context(|| format!("open {}", path.display()))?;
    let decoder = rawler::get_decoder(&src).map_err(|e| anyhow!("unsupported RAW: {e}"))?;
    let params = RawDecodeParams::default();
    let raw = decoder
        .raw_image(&src, &params, false)
        .map_err(|e| anyhow!("RAW decode failed: {e}"))?;
    let md = decoder.raw_metadata(&src, &params).ok();
    log::info!(
        "raw {}x{} cpp={} bps={} orientation={:?} exif_orientation={:?} wb={:?} white={:?} black={:?} float_data={} photometric={:?}",
        raw.width,
        raw.height,
        raw.cpp,
        raw.bps,
        raw.orientation,
        md.as_ref().and_then(|m| m.exif.orientation),
        raw.wb_coeffs,
        raw.whitelevel,
        raw.blacklevel.levels,
        matches!(raw.data, rawler::RawImageData::Float(_)),
        std::mem::discriminant(&raw.photometric)
    );

    // Linear DNGs whose lossless JPEG carries restart markers (Samsung's
    // Expert RAW) decode into a gradient, because the decoder underneath
    // ignores those markers. Decode the picture ourselves in that case.
    let restarts = if matches!(raw.photometric, RawPhotometricInterpretation::LinearRaw) {
        match crate::lossless::linear_dng_with_restarts(path) {
            Ok(d) => d,
            Err(e) => {
                log::warn!("restart-marker DNG: {e:#}; falling back to the usual decoder");
                None
            }
        }
    } else {
        None
    };

    // Let rawler do black/white scaling, demosaic (PPG), fuji rotation and the
    // default crop. We deliberately skip WhiteBalance/Calibrate/SRgb: rawler
    // clips those to 0..1 and we want the highlight headroom.
    // rawler's Rescale silently skips linear (already demosaiced) DNGs whose
    // black-level and white-level counts differ, so we scale those ourselves.
    let manual_scale =
        restarts.is_none() && matches!(raw.photometric, RawPhotometricInterpretation::LinearRaw);
    let mut steps = vec![
        ProcessingStep::Demosaic,
        ProcessingStep::FujiRotate,
        ProcessingStep::CropActiveArea,
        ProcessingStep::CropDefault,
    ];
    if !manual_scale {
        steps.insert(0, ProcessingStep::Rescale);
    }
    let mut rgb = if let Some(d) = restarts {
        // already demosaiced: scale the samples to 0..1 and keep going
        if d.components < 3 {
            bail!(
                "linear DNG with {} components is not supported yet",
                d.components
            );
        }
        let black = raw.blacklevel.as_vec();
        let white = raw.whitelevel.as_vec();
        let level = |v: &[f32], c: usize, default: f32| {
            if v.is_empty() {
                default
            } else {
                v[c % v.len()]
            }
        };
        let full = (1u32 << raw.bps.max(1)) as f32 - 1.0;
        let mut scale = [1.0f32; 3];
        let mut offset = [0.0f32; 3];
        for c in 0..3 {
            offset[c] = level(&black, c, 0.0);
            scale[c] = 1.0 / (level(&white, c, full) - offset[c]).max(1.0);
        }
        let cpp = d.components;
        let data: Vec<[f32; 3]> = d
            .samples
            .par_chunks_exact(cpp)
            .map(|px| {
                let mut out = [0.0f32; 3];
                for c in 0..3 {
                    out[c] = ((px[c] as f32 - offset[c]) * scale[c]).max(0.0);
                }
                out
            })
            .collect();
        rawler::pixarray::RgbF32::new_with(data, d.width, d.height)
    } else {
        let dev = RawDevelop::new_with(&steps);
        let inter = dev
            .develop_intermediate(&raw)
            .map_err(|e| anyhow!("RAW develop failed: {e}"))?;

        match inter {
            Intermediate::ThreeColor(p) => p,
            Intermediate::Monochrome(p) => {
                let d = p.dim();
                let data: Vec<[f32; 3]> = p.pixels().iter().map(|v| [*v, *v, *v]).collect();
                rawler::pixarray::RgbF32::new_with(data, d.w, d.h)
            }
            Intermediate::FourColor(_) => {
                bail!("4-colour sensors (RGBE/CYGM) are not supported yet")
            }
        }
    };

    if manual_scale {
        let black = raw.blacklevel.as_vec();
        let mut white = raw.whitelevel.as_vec();
        // Some phone DNGs (e.g. Samsung) declare a 12-bit white level but store
        // linearised 16-bit samples. Trust the data over the tag in that case.
        let data_max = raw
            .data
            .as_f32()
            .par_iter()
            .cloned()
            .reduce(|| 0.0f32, f32::max);
        let declared = white.iter().cloned().fold(0.0f32, f32::max);
        if data_max > declared * 1.02 {
            let bits = (data_max + 1.0).log2().ceil().max(1.0) as u32;
            let fixed = ((1u64 << bits) - 1) as f32;
            log::warn!("white level {declared} below data max {data_max}; using {fixed}");
            white = vec![fixed; 3];
        }
        let level = |v: &[f32], c: usize, default: f32| {
            if v.is_empty() {
                default
            } else {
                v[c % v.len()]
            }
        };
        let mut scale = [1.0f32; 3];
        let mut offset = [0.0f32; 3];
        for c in 0..3 {
            let b = level(&black, c, 0.0);
            let w = level(&white, c, (1u32 << raw.bps.max(1)) as f32 - 1.0);
            offset[c] = b;
            scale[c] = 1.0 / (w - b).max(1.0);
        }
        rgb.pixels_mut().par_iter_mut().for_each(|pix| {
            for c in 0..3 {
                pix[c] = ((pix[c] - offset[c]) * scale[c]).max(0.0);
            }
        });
    }

    // Camera -> linear sRGB matrix (same derivation as rawler's Calibrate step).
    let cam2rgb: [[f32; 3]; 3] = if raw.is_monochrome() {
        IDENTITY_MATRIX_3
    } else {
        let (illu, matrix) = raw
            .color_matrix_find_first([
                Illuminant::D65,
                Illuminant::A,
                Illuminant::B,
                Illuminant::C,
                Illuminant::D50,
                Illuminant::D55,
                Illuminant::D75,
                Illuminant::Daylight,
                Illuminant::Flash,
            ])
            .unwrap_or_else(|| {
                log::warn!("no colour matrix for {}; using identity", raw.clean_model);
                (Illuminant::D65, IDENTITY_MATRIX_3.as_flattened().to_vec())
            });
        let xyz2cam: [[f32; 3]; 3] = match transform_1d::<3, 3>(&matrix) {
            Some(m) if illu == Illuminant::D65 => m,
            Some(m) => adapt_bradford(&illu, &Illuminant::D65, &m),
            None => {
                log::warn!(
                    "colour matrix has {} entries, expected 9; using identity",
                    matrix.len()
                );
                IDENTITY_MATRIX_3
            }
        };
        // Camera -> DaVinci Wide Gamut (rows normalised so camera white after
        // WB lands on DWG white), same derivation rawler uses for sRGB.
        let dwg2cam = normalize(multiply(&xyz2cam, &DWG_TO_XYZ));
        pseudo_inverse(dwg2cam)
    };

    let mut wb = if raw.wb_coeffs[0].is_nan() || raw.wb_coeffs[1] == 0.0 {
        [1.0, 1.0, 1.0, 1.0]
    } else {
        raw.wb_coeffs
    };
    let g = wb[1];
    for w in wb.iter_mut() {
        *w /= g;
    }

    rgb.pixels_mut().par_iter_mut().for_each(|pix| {
        let r = pix[0] * wb[0];
        let g = pix[1] * wb[1];
        let b = pix[2] * wb[2];
        let out = [
            cam2rgb[0][0] * r + cam2rgb[0][1] * g + cam2rgb[0][2] * b,
            cam2rgb[1][0] * r + cam2rgb[1][1] * g + cam2rgb[1][2] * b,
            cam2rgb[2][0] * r + cam2rgb[2][1] * g + cam2rgb[2][2] * b,
        ];
        *pix = [out[0].max(0.0), out[1].max(0.0), out[2].max(0.0)];
    });

    // Many decoders leave RawImage.orientation at Normal and only report the
    // rotation through EXIF, so prefer the EXIF tag when it is present.
    let orientation = md
        .as_ref()
        .and_then(|m| m.exif.orientation)
        .map(Orientation::from_u16)
        .filter(|o| !matches!(o, Orientation::Unknown))
        .unwrap_or(raw.orientation);
    rgb = match orientation {
        Orientation::Rotate90 => rgb.rotate_90cw(),
        Orientation::Rotate180 => rgb.rotate_180(),
        Orientation::Rotate270 => rgb.rotate_90ccw(),
        _ => rgb,
    };

    let dim = rgb.dim();
    let image = LinearImage {
        width: dim.w,
        height: dim.h,
        data: rgb.into_flatten(),
    };

    let mut meta = Metadata {
        kind: "raw".into(),
        camera: Some(
            format!("{} {}", raw.clean_make, raw.clean_model)
                .trim()
                .to_string(),
        ),
        ..Default::default()
    };
    if let Some(md) = md {
        let ex = &md.exif;
        meta.lens = md
            .lens
            .as_ref()
            .map(|l| {
                format!("{} {}", l.lens_make, l.lens_model)
                    .trim()
                    .to_string()
            })
            .or_else(|| ex.lens_model.clone());
        meta.iso = ex
            .iso_speed_ratings
            .map(|v| v as u32)
            .or(ex.iso_speed)
            .or(ex.recommended_exposure_index);
        meta.exposure_time = ex
            .exposure_time
            .as_ref()
            .and_then(|r| format_exposure(r.n, r.d));
        meta.f_number = ex.fnumber.as_ref().and_then(rational_f32);
        meta.focal_length = ex.focal_length.as_ref().and_then(rational_f32);
        meta.date_taken = ex
            .date_time_original
            .clone()
            .or_else(|| ex.create_date.clone());
    }
    Ok((image, meta))
}

// ---------------------------------------------------------------- JPEG / PNG / TIFF

fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn load_image(path: &Path) -> Result<(LinearImage, Metadata)> {
    let reader = image::ImageReader::open(path)
        .with_context(|| format!("open {}", path.display()))?
        .with_guessed_format()
        .context("detect image format")?;
    let format = reader.format();
    let mut img = reader.decode().context("decode image")?;

    let mut meta = Metadata {
        kind: match format {
            Some(image::ImageFormat::Jpeg) => "jpeg",
            Some(image::ImageFormat::Png) => "png",
            Some(image::ImageFormat::Tiff) => "tiff",
            _ => "image",
        }
        .into(),
        ..Default::default()
    };

    // EXIF (orientation + shooting data) for JPEG/TIFF.
    let mut orientation = 1u32;
    if let Ok(file) = std::fs::File::open(path) {
        let mut br = std::io::BufReader::new(&file);
        if let Ok(exif) = exif::Reader::new().read_from_container(&mut br) {
            let field_str = |tag: exif::Tag| {
                exif.get_field(tag, exif::In::PRIMARY)
                    .map(|f| f.display_value().to_string().trim_matches('"').to_string())
            };
            let field_f32 = |tag: exif::Tag| {
                exif.get_field(tag, exif::In::PRIMARY)
                    .and_then(|f| match &f.value {
                        exif::Value::Rational(v) if !v.is_empty() && v[0].denom != 0 => {
                            Some(v[0].to_f32())
                        }
                        _ => None,
                    })
            };
            if let Some(f) = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY) {
                orientation = f.value.get_uint(0).unwrap_or(1);
            }
            let make = field_str(exif::Tag::Make).unwrap_or_default();
            let model = field_str(exif::Tag::Model).unwrap_or_default();
            let cam = format!("{make} {model}").trim().to_string();
            if !cam.is_empty() {
                meta.camera = Some(cam);
            }
            meta.lens = field_str(exif::Tag::LensModel);
            meta.iso = exif
                .get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY)
                .and_then(|f| f.value.get_uint(0));
            meta.exposure_time = exif
                .get_field(exif::Tag::ExposureTime, exif::In::PRIMARY)
                .and_then(|f| match &f.value {
                    exif::Value::Rational(v) if !v.is_empty() => {
                        format_exposure(v[0].num, v[0].denom)
                    }
                    _ => None,
                });
            meta.f_number = field_f32(exif::Tag::FNumber);
            meta.focal_length = field_f32(exif::Tag::FocalLength);
            meta.date_taken = field_str(exif::Tag::DateTimeOriginal);
        }
    }

    img = match orientation {
        3 => img.rotate180(),
        6 => img.rotate90(),
        8 => img.rotate270(),
        2 => img.fliph(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        7 => img.rotate270().fliph(),
        _ => img,
    };

    let (w, h) = (img.width() as usize, img.height() as usize);
    // NOTE: embedded ICC profiles are ignored; input is assumed sRGB-encoded.
    let rgb = img.into_rgb32f();
    let mut data = rgb.into_raw();
    data.par_chunks_exact_mut(3).for_each(|px| {
        let lin = [
            srgb_to_linear(px[0].clamp(0.0, 1.0)),
            srgb_to_linear(px[1].clamp(0.0, 1.0)),
            srgb_to_linear(px[2].clamp(0.0, 1.0)),
        ];
        let d = mul3(&SRGB_TO_DWG, lin);
        px[0] = d[0].max(0.0);
        px[1] = d[1].max(0.0);
        px[2] = d[2].max(0.0);
    });

    Ok((
        LinearImage {
            width: w,
            height: h,
            data,
        },
        meta,
    ))
}

// ---------------------------------------------------------------- helpers

/// Integer-factor box downsample so the long edge is <= `max_edge`.
pub fn downsample(img: &LinearImage, max_edge: usize) -> LinearImage {
    let long = img.width.max(img.height);
    let f = long.div_ceil(max_edge).max(1);
    if f == 1 {
        return LinearImage {
            width: img.width,
            height: img.height,
            data: img.data.clone(),
        };
    }
    let ow = img.width / f;
    let oh = img.height / f;
    let mut out = vec![0.0f32; ow * oh * 3];
    let inv = 1.0 / (f * f) as f32;
    out.par_chunks_mut(ow * 3)
        .enumerate()
        .for_each(|(oy, row)| {
            for ox in 0..ow {
                let mut acc = [0.0f32; 3];
                for dy in 0..f {
                    let y = oy * f + dy;
                    let base = (y * img.width + ox * f) * 3;
                    let src = &img.data[base..base + f * 3];
                    for px in src.chunks_exact(3) {
                        acc[0] += px[0];
                        acc[1] += px[1];
                        acc[2] += px[2];
                    }
                }
                row[ox * 3] = acc[0] * inv;
                row[ox * 3 + 1] = acc[1] * inv;
                row[ox * 3 + 2] = acc[2] * inv;
            }
        });
    LinearImage {
        width: ow,
        height: oh,
        data: out,
    }
}

/// Pack interleaved RGB f32 into little-endian IEEE half floats.
pub fn to_f16_bytes(data: &[f32]) -> Vec<u8> {
    const CHUNK: usize = 4096;
    let mut out = vec![0u8; data.len() * 2];
    out.par_chunks_mut(CHUNK * 2)
        .zip(data.par_chunks(CHUNK))
        .for_each(|(dst, src)| {
            for (d, v) in dst.chunks_exact_mut(2).zip(src) {
                d.copy_from_slice(&half::f16::from_f32(*v).to_bits().to_le_bytes());
            }
        });
    out
}
