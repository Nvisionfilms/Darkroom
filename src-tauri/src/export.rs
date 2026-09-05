use crate::decode::LinearImage;
use crate::denoise::{self, NoiseParams};
use crate::detail;
use crate::pipeline::{self, EditParams};
use anyhow::{bail, Context, Result};
use image::{ImageBuffer, Rgb};
use rayon::prelude::*;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub out_path: String,
    /// "jpeg" | "png" | "tiff"
    pub format: String,
    /// 1..100, JPEG only
    pub quality: u8,
    /// 8 or 16, PNG/TIFF only
    pub bit_depth: u8,
    /// resize so the long edge is at most this many pixels
    pub max_long_edge: Option<u32>,
    pub params: EditParams,
    /// 4 x 256 curve LUT (master, r, g, b); identity if empty
    pub lut: Vec<f32>,
}

pub fn export(img: &LinearImage, req: &ExportRequest) -> Result<()> {
    let lut = if req.lut.len() == 1024 {
        req.lut.clone()
    } else {
        pipeline::identity_lut()
    };

    // 1. denoise + local-contrast maps + develop at full resolution
    let developed = develop_full(img, &req.params, &lut);
    let mut developed = pipeline::mirror_pass(&developed, img.width, img.height, &req.params.mirror);
    let wmp = &req.params.watermark;
    if wmp.enabled && !wmp.path.is_empty() {
        let wm = pipeline::WatermarkImage::load(Path::new(&wmp.path))?;
        pipeline::watermark_pass(&mut developed, img.width, img.height, wmp, &wm);
    }
    let (developed, cw, ch) = pipeline::crop_pass(&developed, img.width, img.height, &req.params.crop);
    let (developed, dw, dh) = pipeline::rotate(&developed, cw, ch, req.params.rotation);
    let mut buf: ImageBuffer<Rgb<f32>, Vec<f32>> =
        ImageBuffer::from_raw(dw as u32, dh as u32, developed).context("buffer size mismatch")?;

    // 2. optional resize
    if let Some(max) = req.max_long_edge {
        let long = dw.max(dh) as u32;
        if max > 0 && long > max {
            let scale = max as f64 / long as f64;
            let nw = ((dw as f64 * scale).round() as u32).max(1);
            let nh = ((dh as f64 * scale).round() as u32).max(1);
            buf = image::imageops::resize(&buf, nw, nh, image::imageops::FilterType::Lanczos3);
        }
    }

    // 3. output sharpening
    let (w, h) = (buf.width() as usize, buf.height() as usize);
    let mut data = buf.into_raw();
    pipeline::sharpen(&mut data, w, h, req.params.sharpen);

    // 4. quantise + encode
    let out = Path::new(&req.out_path);
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).ok();
        }
    }
    match req.format.as_str() {
        "jpeg" | "jpg" => {
            let bytes = to_u8(&data);
            let file = std::fs::File::create(out).with_context(|| format!("create {}", out.display()))?;
            let mut w8 = std::io::BufWriter::new(file);
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w8, req.quality.clamp(1, 100));
            enc.encode(&bytes, w as u32, h as u32, image::ExtendedColorType::Rgb8)
                .context("encode JPEG")?;
        }
        "png" | "tiff" | "tif" => {
            let fmt = if req.format.starts_with("png") {
                image::ImageFormat::Png
            } else {
                image::ImageFormat::Tiff
            };
            if req.bit_depth == 16 {
                let bytes = to_u16(&data);
                let ib: ImageBuffer<Rgb<u16>, Vec<u16>> =
                    ImageBuffer::from_raw(w as u32, h as u32, bytes).context("buffer")?;
                ib.save_with_format(out, fmt).with_context(|| format!("write {}", out.display()))?;
            } else {
                let bytes = to_u8(&data);
                let ib: ImageBuffer<Rgb<u8>, Vec<u8>> =
                    ImageBuffer::from_raw(w as u32, h as u32, bytes).context("buffer")?;
                ib.save_with_format(out, fmt).with_context(|| format!("write {}", out.display()))?;
            }
        }
        other => bail!("unknown export format {other}"),
    }
    Ok(())
}

/// The scene-referred part of the pipeline that needs whole-image context:
/// noise estimate -> NLM denoise -> local-contrast maps -> per-pixel develop.
pub fn develop_full(img: &LinearImage, params: &EditParams, lut: &[f32]) -> Vec<f32> {
    let np = NoiseParams::from_sliders(params.denoise_luma, params.denoise_chroma, params.denoise_detail);
    let denoised: std::borrow::Cow<[f32]> = if np.is_noop() {
        std::borrow::Cow::Borrowed(&img.data)
    } else {
        let sigma = denoise::estimate_sigma(&img.data, img.width, img.height);
        log::info!("export denoise sigma={sigma:.5}");
        std::borrow::Cow::Owned(denoise::denoise_image(&img.data, img.width, img.height, sigma, &np))
    };
    let maps = if params.texture != 0.0 || params.clarity != 0.0 {
        Some(detail::build(&denoised, img.width, img.height))
    } else {
        None
    };
    pipeline::develop_buffer(&denoised, img.width, maps.as_ref(), params, lut)
}

fn to_u8(data: &[f32]) -> Vec<u8> {
    data.par_iter()
        .map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8)
        .collect()
}

fn to_u16(data: &[f32]) -> Vec<u16> {
    data.par_iter()
        .map(|v| (v.clamp(0.0, 1.0) * 65535.0 + 0.5) as u16)
        .collect()
}

/// Small JPEG thumbnail of a linear image using the default look, as a data URL.
pub fn thumbnail_data_url(img: &LinearImage, max_edge: usize) -> Result<String> {
    use base64::Engine;
    let small = crate::decode::downsample(img, max_edge);
    let params = EditParams::default();
    let lut = pipeline::identity_lut();
    let dev = pipeline::develop_buffer(&small.data, small.width, None, &params, &lut);
    let bytes = to_u8(&dev);
    let mut jpeg = Vec::new();
    {
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80);
        enc.encode(&bytes, small.width as u32, small.height as u32, image::ExtendedColorType::Rgb8)
            .context("thumbnail encode")?;
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    ))
}
