use crate::decode::LinearImage;
use crate::denoise::{self, NoiseParams};
use crate::detail;
use crate::pipeline::{self, EditParams};
use anyhow::{bail, Context, Result};
use image::{ImageBuffer, ImageEncoder, Rgb};
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
    let mut developed = develop_full(img, &req.params, &lut);
    // the cross-screen filter sits on the lens, so it comes before anything
    // that is added to the picture afterwards - the watermark included - and
    // before the crop, exactly as the preview applies it to the whole frame
    if req.params.star.is_active() {
        developed = crate::star::apply(&developed, img.width, img.height, &req.params.star);
    }
    let wmp = &req.params.watermark;
    if wmp.enabled && !wmp.path.is_empty() {
        let wm = pipeline::WatermarkImage::load(Path::new(&wmp.path))?;
        pipeline::watermark_pass(&mut developed, img.width, img.height, wmp, &wm);
    }
    // crop + straighten + perspective + lens distortion/CA in one resample
    let warp = req.params.warp(img.width, img.height);
    let (developed, cw, ch) =
        crate::geometry::geometry_pass(&developed, img.width, img.height, &req.params.crop, &warp);
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

    // 3. output sharpening, then the display-space Motion Trails effect. This
    // mirrors the preview wrapper: trails are created from the finished image,
    // not by changing scene content or inventing pixels.
    let (w, h) = (buf.width() as usize, buf.height() as usize);
    let mut data = buf.into_raw();
    pipeline::sharpen(&mut data, w, h, req.params.sharpen);
    data = motion_trail_pass(&data, w, h, &req.params.mirror, &req.params.masks);

    // 4. quantise + encode
    let out = Path::new(&req.out_path);
    if let Some(parent) = out.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).ok();
        }
    }
    // Every file is tagged as sRGB. The preview canvas is colour managed by
    // the webview, so an untagged export would only match the app in viewers
    // that happen to assume sRGB; on a calibrated or wide-gamut display the
    // two drift apart badly.
    let profile = crate::icc::srgb();
    let file = std::fs::File::create(out).with_context(|| format!("create {}", out.display()))?;
    let w8 = std::io::BufWriter::new(file);
    match req.format.as_str() {
        "jpeg" | "jpg" => {
            let bytes = to_u8(&data);
            let mut enc =
                image::codecs::jpeg::JpegEncoder::new_with_quality(w8, req.quality.clamp(1, 100));
            enc.set_icc_profile(profile).ok();
            enc.encode(&bytes, w as u32, h as u32, image::ExtendedColorType::Rgb8)
                .context("encode JPEG")?;
        }
        "png" | "tiff" | "tif" => {
            let png = req.format.starts_with("png");
            if req.bit_depth == 16 {
                let ib: ImageBuffer<Rgb<u16>, Vec<u16>> =
                    ImageBuffer::from_raw(w as u32, h as u32, to_u16(&data)).context("buffer")?;
                if png {
                    let mut enc = image::codecs::png::PngEncoder::new(w8);
                    enc.set_icc_profile(profile).ok();
                    ib.write_with_encoder(enc)
                } else {
                    let mut enc = image::codecs::tiff::TiffEncoder::new(w8);
                    enc.set_icc_profile(profile).ok();
                    ib.write_with_encoder(enc)
                }
                .with_context(|| format!("write {}", out.display()))?;
            } else {
                let ib: ImageBuffer<Rgb<u8>, Vec<u8>> =
                    ImageBuffer::from_raw(w as u32, h as u32, to_u8(&data)).context("buffer")?;
                if png {
                    let mut enc = image::codecs::png::PngEncoder::new(w8);
                    enc.set_icc_profile(profile).ok();
                    ib.write_with_encoder(enc)
                } else {
                    let mut enc = image::codecs::tiff::TiffEncoder::new(w8);
                    enc.set_icc_profile(profile).ok();
                    ib.write_with_encoder(enc)
                }
                .with_context(|| format!("write {}", out.display()))?;
            }
        }
        other => bail!("unknown export format {other}"),
    }
    Ok(())
}

/// The scene-referred part of the pipeline that needs whole-image context:
/// noise estimate -> NLM denoise -> local-contrast maps -> per-pixel develop.
pub fn develop_full(img: &LinearImage, params: &EditParams, lut: &[f32]) -> Vec<f32> {
    // Object remover first: the copied pixels then go through denoise and
    // develop exactly like the rest of the frame.
    let healed: std::borrow::Cow<[f32]> = if params.heal.iter().any(|s| s.is_active()) {
        let mut d = img.data.clone();
        crate::heal::heal_image(&mut d, img.width, img.height, &params.heal);
        std::borrow::Cow::Owned(d)
    } else {
        std::borrow::Cow::Borrowed(&img.data)
    };
    let np = NoiseParams::from_sliders(
        params.denoise_luma,
        params.denoise_chroma,
        params.denoise_detail,
    );
    let denoised: std::borrow::Cow<[f32]> = if np.is_noop() {
        healed
    } else {
        let sigma = denoise::estimate_sigma(&healed, img.width, img.height);
        log::info!("export denoise sigma={sigma:.5}");
        std::borrow::Cow::Owned(denoise::denoise_image(
            &healed, img.width, img.height, sigma, &np,
        ))
    };
    let maps = if params.needs_maps() {
        Some(detail::build(&denoised, img.width, img.height))
    } else {
        None
    };
    // creative look (.cube); a look that cannot be read is skipped rather
    // than failing the whole export
    let look = if params.look.is_active() {
        match crate::lut3d::Lut3d::load(Path::new(&params.look.path)) {
            Ok(l) => Some(l),
            Err(e) => {
                log::warn!("look: {e:#}");
                None
            }
        }
    } else {
        None
    };
    // double exposure: the second photograph, read at full resolution. As
    // with the look, a file that cannot be read is skipped with a warning
    // rather than failing the whole export.
    let over = if params.blend.is_active() {
        match crate::decode::load(Path::new(&params.blend.path)) {
            Ok((i, _)) => Some(i),
            Err(e) => {
                log::warn!("double exposure: {e:#}");
                None
            }
        }
    } else {
        None
    };
    let over = over
        .as_ref()
        .map(|i| crate::blend::Source::new(&params.blend, i, img.width, img.height));
    pipeline::develop_buffer_full(
        &denoised,
        img.width,
        maps.as_ref(),
        params,
        lut,
        look.as_ref(),
        over.as_ref(),
    )
}

/// Motion Trails uses the legacy `Mirror` storage shape for sidecar
/// compatibility. The current semantic mapping is documented in src/types.ts:
/// cx=copies/10, rx=blur, ry=amount, feather=fade, offset=edge feather,
/// length=distance.
///
/// The blend is intentionally deterministic and non-generative. Each echo is
/// a translated sample of the already-developed image, combined with a Screen
/// blend so black/dark background areas do not stamp over the original.
///
/// When `m.mask` names a mask, the echoes are cut from that mask's area alone,
/// and the area itself is left untouched: the trail streaks out from behind a
/// selected subject while the subject keeps all of its own detail. Twin of the
/// trail compositor in src/components/Viewer.tsx.
pub(crate) fn motion_trail_pass(
    img: &[f32],
    width: usize,
    height: usize,
    m: &pipeline::Mirror,
    masks: &[crate::mask::Mask],
) -> Vec<f32> {
    if !m.enabled || m.opacity <= 0.0 || width == 0 || height == 0 {
        return img.to_vec();
    }

    let weights = if m.mask.is_empty() {
        None
    } else {
        // luminance masks read the developed luminance of the finished picture
        let luma: Vec<f32> = img
            .chunks_exact(3)
            .map(|p| p[0] * 0.2126 + p[1] * 0.7152 + p[2] * 0.0722)
            .collect();
        crate::mask::weight_map(masks, &m.mask, width, height, &luma)
    };
    // a trail asked to come from a mask that is gone or switched off has no
    // source, so it draws nothing rather than falling back to the whole frame
    if !m.mask.is_empty() && weights.is_none() {
        return img.to_vec();
    }
    // Two maps. The feathered one decides what the trail is cut FROM, so the
    // echoes fade off the subject instead of ending on a cut line. The plain one
    // decides what the subject KEEPS, because feathering that would rub out the
    // brightest part of the trail, the part closest to the subject.
    let source_weights = weights.as_ref().map(|v| {
        let mut w = v.clone();
        let sigma = m.offset.clamp(0.0, 0.25) * TRAIL_MASK_FEATHER * width.max(height) as f32;
        crate::mask::blur_weights(&mut w, width, height, sigma);
        w
    });

    let copies = ((m.cx * 10.0).round() as i32).clamp(1, MAX_TRAIL_COPIES as i32) as usize;
    let amount = m.ry.clamp(0.0, 1.0);
    let opacity = (m.opacity / 100.0).clamp(0.0, 1.0);
    if amount <= 0.0 || opacity <= 0.0 {
        return img.to_vec();
    }
    let fade = (m.feather / 100.0).clamp(0.0, 1.0);
    let fade_retention = 0.2 + fade * 0.78;
    let edge_feather = m.offset.clamp(0.0, 0.25);
    let long = width.max(height) as f32;
    let distance = m.length.clamp(0.0, 0.7) * long;
    let angle = m.direction.to_radians();
    let dx = angle.cos();
    let dy = angle.sin();
    let blur_spread = m.rx.clamp(0.0, 1.0) * (long * 0.006).clamp(2.0, 32.0);

    let mut out = img.to_vec();
    out.par_chunks_mut(width * 3)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..width {
                let mut base = [
                    img[(y * width + x) * 3],
                    img[(y * width + x) * 3 + 1],
                    img[(y * width + x) * 3 + 2],
                ];

                // Far echoes first, matching the preview compositor.
                for i in (1..=copies).rev() {
                    let t = i as f32 / copies as f32;
                    let base_alpha = opacity * amount * fade_retention.powi(i as i32 - 1) * 0.72;
                    if base_alpha <= 0.002 {
                        continue;
                    }
                    let sx = x as f32 - dx * distance * t;
                    let sy = y as f32 - dy * distance * t;
                    let edge_alpha = source_edge_alpha(sx, sy, width, height, edge_feather);
                    // only the masked subject casts a trail
                    let from_mask = match &source_weights {
                        Some(v) => sample_weight(v, width, height, sx, sy),
                        None => 1.0,
                    };
                    let alpha = base_alpha * edge_alpha * from_mask;
                    if alpha <= 0.002 {
                        continue;
                    }
                    let spread = blur_spread * (0.35 + t * 0.65);

                    let s0 = sample_rgb(img, width, height, sx, sy);
                    let sm = if spread > 0.2 {
                        let a = sample_rgb(img, width, height, sx - dx * spread, sy - dy * spread);
                        let b = sample_rgb(img, width, height, sx + dx * spread, sy + dy * spread);
                        [
                            (a[0] + s0[0] + b[0]) / 3.0,
                            (a[1] + s0[1] + b[1]) / 3.0,
                            (a[2] + s0[2] + b[2]) / 3.0,
                        ]
                    } else {
                        s0
                    };

                    for c in 0..3 {
                        let d = base[c].clamp(0.0, 1.0);
                        let s = (sm[c].clamp(0.0, 1.0) * alpha).clamp(0.0, 1.0);
                        base[c] = 1.0 - (1.0 - d) * (1.0 - s);
                    }
                }

                if let Some(v) = &weights {
                    // the subject keeps its own pixels: the trail only shows
                    // around it, which is what keeps the subject sharp
                    let keep = 1.0 - v[y * width + x].clamp(0.0, 1.0);
                    for c in 0..3 {
                        let orig = img[(y * width + x) * 3 + c];
                        base[c] = orig + (base[c] - orig) * keep;
                    }
                }
                row[x * 3..x * 3 + 3].copy_from_slice(&base);
            }
        });
    out
}

/// Bilinear sample of a single-channel weight map.
#[inline]
fn sample_weight(w: &[f32], width: usize, height: usize, x: f32, y: f32) -> f32 {
    if x < 0.0
        || y < 0.0
        || x > (width.saturating_sub(1)) as f32
        || y > (height.saturating_sub(1)) as f32
    {
        return 0.0;
    }
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;
    let a = w[y0 * width + x0] * (1.0 - tx) + w[y0 * width + x1] * tx;
    let b = w[y1 * width + x0] * (1.0 - tx) + w[y1 * width + x1] * tx;
    a * (1.0 - ty) + b * ty
}

/// A masked trail needs many more echoes than a whole-frame one: a frame-wide
/// echo overlaps itself and reads as a smear, while a cut-out subject echoes as
/// separate ghosts until there are enough of them to join up.
pub const MAX_TRAIL_COPIES: usize = 24;

/// Edge Feather, for a trail cut from a mask, softens the mask's own edge
/// instead of the frame boundary, which a cut-out subject never touches. The
/// slider's 0..0.25 maps to this fraction of the long edge.
pub const TRAIL_MASK_FEATHER: f32 = 0.06;

#[inline]
fn source_edge_alpha(x: f32, y: f32, width: usize, height: usize, feather: f32) -> f32 {
    if x < 0.0
        || y < 0.0
        || x > (width.saturating_sub(1)) as f32
        || y > (height.saturating_sub(1)) as f32
    {
        return 0.0;
    }
    if feather <= 0.0001 {
        return 1.0;
    }
    let nx = if width > 1 {
        x / (width - 1) as f32
    } else {
        0.5
    };
    let ny = if height > 1 {
        y / (height - 1) as f32
    } else {
        0.5
    };
    let dx = nx.min(1.0 - nx);
    let dy = ny.min(1.0 - ny);
    smoothstep01(dx / feather) * smoothstep01(dy / feather)
}

#[inline]
fn smoothstep01(v: f32) -> f32 {
    let x = v.clamp(0.0, 1.0);
    x * x * (3.0 - 2.0 * x)
}

#[inline]
fn sample_rgb(img: &[f32], width: usize, height: usize, x: f32, y: f32) -> [f32; 3] {
    if x < 0.0
        || y < 0.0
        || x > (width.saturating_sub(1)) as f32
        || y > (height.saturating_sub(1)) as f32
    {
        return [0.0; 3];
    }
    let x0 = x.floor() as usize;
    let y0 = y.floor() as usize;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;
    let get = |xx: usize, yy: usize, c: usize| img[(yy * width + xx) * 3 + c];
    let mut out = [0.0; 3];
    for (c, o) in out.iter_mut().enumerate() {
        let a = get(x0, y0, c) * (1.0 - tx) + get(x1, y0, c) * tx;
        let b = get(x0, y1, c) * (1.0 - tx) + get(x1, y1, c) * tx;
        *o = a * (1.0 - ty) + b * ty;
    }
    out
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
        enc.encode(
            &bytes,
            small.width as u32,
            small.height as u32,
            image::ExtendedColorType::Rgb8,
        )
        .context("thumbnail encode")?;
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    ))
}
