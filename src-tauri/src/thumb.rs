//! Fast filmstrip thumbnails.
//!
//! Every RAW file carries a JPEG preview written by the camera. Decoding that
//! is far cheaper than demosaicing the sensor data, and at filmstrip size the
//! difference is invisible, so the browser strip fills in quickly even for a
//! folder of 6000-pixel frames. Bitmap files are simply downscaled.
//!
//! The camera preview is stored unrotated, so the EXIF orientation is applied
//! here the same way `decode.rs` applies it to the developed image.

use crate::decode;
use anyhow::{bail, Context, Result};
use image::DynamicImage;
use rawler::Orientation;
use std::path::Path;

/// Long edge of a filmstrip thumbnail.
pub const THUMB_EDGE: u32 = 240;

fn orient(img: DynamicImage, orientation: Orientation) -> DynamicImage {
    match orientation {
        Orientation::Rotate90 => img.rotate90(),
        Orientation::Rotate180 => img.rotate180(),
        Orientation::Rotate270 => img.rotate270(),
        Orientation::HorizontalFlip => img.fliph(),
        Orientation::VerticalFlip => img.flipv(),
        Orientation::Transpose => img.rotate90().fliph(),
        Orientation::Transverse => img.rotate270().fliph(),
        _ => img,
    }
}

/// The camera's own preview, already oriented. None when the file has none.
fn raw_preview(path: &Path) -> Option<DynamicImage> {
    let src = rawler::rawsource::RawSource::new(path).ok()?;
    let dec = rawler::get_decoder(&src).ok()?;
    let params = rawler::decoders::RawDecodeParams::default();
    // thumbnail first: it is the smallest and by far the quickest to decode
    let img = dec
        .thumbnail_image(&src, &params)
        .ok()
        .flatten()
        .filter(|i| i.width() >= THUMB_EDGE && i.height() >= THUMB_EDGE)
        .or_else(|| dec.preview_image(&src, &params).ok().flatten())
        .or_else(|| dec.full_image(&src, &params).ok().flatten())?;
    let orientation = dec
        .raw_metadata(&src, &params)
        .ok()
        .and_then(|md| md.exif.orientation)
        .map(Orientation::from_u16)
        .filter(|o| !matches!(o, Orientation::Unknown))
        .unwrap_or(Orientation::Normal);
    Some(orient(img, orientation))
}

/// A JPEG data URL for the filmstrip, at most `THUMB_EDGE` on the long edge.
pub fn thumbnail(path: &Path) -> Result<String> {
    let img = if decode::is_raw(path) {
        match raw_preview(path) {
            Some(img) => img,
            // No embedded preview (some DNGs): fall back to the full decode.
            None => {
                let (linear, _) = decode::load(path)?;
                let small = decode::downsample(&linear, THUMB_EDGE as usize * 2);
                return crate::export::thumbnail_data_url(&small, THUMB_EDGE as usize);
            }
        }
    } else {
        let reader = image::ImageReader::open(path)
            .with_context(|| format!("open {}", path.display()))?
            .with_guessed_format()?;
        let img = reader.decode().context("decode image")?;
        let orientation = bitmap_orientation(path).unwrap_or(Orientation::Normal);
        orient(img, orientation)
    };
    if img.width() == 0 || img.height() == 0 {
        bail!("empty preview");
    }
    let small = img.thumbnail(THUMB_EDGE, THUMB_EDGE).to_rgb8();
    let mut jpeg = Vec::new();
    {
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80);
        enc.encode(&small, small.width(), small.height(), image::ExtendedColorType::Rgb8)
            .context("encode thumbnail")?;
    }
    use base64::Engine;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&jpeg)
    ))
}

/// EXIF orientation of a JPEG/TIFF, so sideways phone and camera files show
/// the right way up in the strip.
fn bitmap_orientation(path: &Path) -> Option<Orientation> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;
    let field = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?;
    let v = field.value.get_uint(0)?;
    let o = Orientation::from_u16(v as u16);
    if matches!(o, Orientation::Unknown) {
        None
    } else {
        Some(o)
    }
}
