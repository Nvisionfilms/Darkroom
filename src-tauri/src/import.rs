//! Bringing a picked photo within reach of the decoder.
//!
//! On the desktop the file dialog hands back real paths and there is nothing
//! to do. Phones hand back handles instead: `content://` on Android, with no
//! path, name or extension, and a security-scoped `file://` URL on iOS that
//! only stays readable while access is held. Either way the app may read the
//! photo but not write beside it. So the photo is copied into the app's own
//! storage with an extension read from the file itself. Its edits (the
//! .drk.json sidecar) then sit next to that copy, somewhere the app is allowed
//! to write, and picking the same photo again finds them.

use anyhow::{anyhow, bail, Context, Result};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_fs::{FilePath, FsExt};

/// A path the decoder can open for whatever the file picker returned. `ext`
/// names the file type for things that are not photos (a .cube look), which
/// cannot be recognised from their bytes.
pub fn resolve<R: Runtime>(app: &AppHandle<R>, uri: &str, ext: Option<&str>) -> Result<PathBuf> {
    if !is_handle(uri) {
        return Ok(match uri.strip_prefix("file://") {
            Some(p) => PathBuf::from(percent_decode(p)),
            None => PathBuf::from(uri),
        });
    }
    let url = tauri::Url::parse(uri).with_context(|| format!("not a valid handle: {uri}"))?;
    let bytes = app
        .fs()
        .read(FilePath::Url(url))
        .with_context(|| format!("could not read {uri}"))?;
    if is_heic(&bytes) {
        bail!(
            "iPhone HEIC photos can't be opened yet. Set Settings > Camera > Formats to Most Compatible \
             to shoot JPEG, or open a RAW or JPEG instead."
        );
    }
    let (ext, folder) = match ext {
        Some(e) => (e.trim_start_matches('.').to_ascii_lowercase(), "imports"),
        None => (
            sniff(&bytes)
                .ok_or_else(|| anyhow!("that file is not a photo Darkroom can open"))?
                .to_string(),
            "photos",
        ),
    };
    let dir = app.path().app_data_dir().context("no app data folder")?.join(folder);
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let dest = dir.join(format!("{}.{ext}", media_name(uri)));
    // the same photo picked again keeps its copy, and so its edits
    let same = std::fs::metadata(&dest).map(|m| m.len() == bytes.len() as u64).unwrap_or(false);
    if !same {
        std::fs::write(&dest, &bytes).with_context(|| format!("write {}", dest.display()))?;
    }
    Ok(dest)
}

/// Whether the picker handed back a handle rather than a plain path: always
/// the case on a phone (`content://` on Android, a security-scoped `file://`
/// URL on iOS), never on the desktop.
pub fn is_handle(uri: &str) -> bool {
    uri.starts_with("content://") || (cfg!(mobile) && uri.starts_with("file://"))
}

/// HEIF/HEIC, the iPhone camera's default format. Its brand sits in the
/// ISO-BMFF `ftyp` box, the same place CR3 declares itself.
fn is_heic(b: &[u8]) -> bool {
    b.len() > 12 && &b[4..8] == b"ftyp" && matches!(&b[8..12], b"heic" | b"heix" | b"hevc" | b"heim" | b"heis" | b"mif1" | b"msf1")
}

/// Copy a finished file out through a content:// handle. Android's save
/// dialog returns one of those, and the exporter can only write to paths, so
/// the export is rendered into app storage first and then copied here.
pub fn write_back<R: Runtime>(app: &AppHandle<R>, uri: &str, from: &std::path::Path) -> Result<()> {
    let url = tauri::Url::parse(uri).with_context(|| format!("not a valid handle: {uri}"))?;
    let mut opts = tauri_plugin_fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    let mut dst = app
        .fs()
        .open(FilePath::Url(url), opts)
        .with_context(|| format!("could not write to {uri}"))?;
    let mut src = std::fs::File::open(from).with_context(|| format!("open {}", from.display()))?;
    std::io::copy(&mut src, &mut dst).context("copy the export")?;
    Ok(())
}

/// The file's extension, read from its contents. The decoder picks its RAW or
/// bitmap path by extension, and a content handle does not carry one.
pub fn sniff(b: &[u8]) -> Option<&'static str> {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if b.starts_with(b"\x89PNG") {
        return Some("png");
    }
    if b.len() > 12 && &b[4..8] == b"ftyp" && &b[8..11] == b"crx" {
        return Some("cr3");
    }
    if b.starts_with(b"FUJIFILM") {
        return Some("raf");
    }
    // Most RAW formats (ARW, NEF, CR2, DNG, ORF, RW2, PEF...) share TIFF's
    // header with plain TIFF, so only rawler can tell them apart.
    let src = rawler::rawsource::RawSource::new_from_slice(b);
    if let Ok(dec) = rawler::get_decoder(&src) {
        let make = dec
            .raw_metadata(&src, &rawler::decoders::RawDecodeParams::default())
            .map(|m| m.make.to_ascii_lowercase())
            .unwrap_or_default();
        return Some(raw_extension(&make));
    }
    if b.starts_with(b"II*\0") || b.starts_with(b"MM\0*") {
        return Some("tif");
    }
    None
}

fn raw_extension(make: &str) -> &'static str {
    match make {
        m if m.contains("sony") => "arw",
        m if m.contains("canon") => "cr2",
        m if m.contains("nikon") => "nef",
        m if m.contains("fuji") => "raf",
        m if m.contains("olympus") || m.contains("om digital") => "orf",
        m if m.contains("panasonic") || m.contains("leica") => "rw2",
        m if m.contains("pentax") || m.contains("ricoh") => "pef",
        _ => "dng",
    }
}

/// A stable file name for a content handle: its last segment (the media id),
/// kept to characters every file system accepts.
fn media_name(uri: &str) -> String {
    let last = uri.trim_end_matches('/').rsplit('/').next().unwrap_or("photo");
    let last = percent_decode(last);
    // an iOS file URL keeps the real name: use it, without its extension
    if uri.starts_with("file://") {
        let stem = last.rsplit_once('.').map(|(s, _)| s).unwrap_or(&last);
        let clean: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        let clean = clean.trim_matches('-');
        return if clean.is_empty() { "photo".into() } else { clean.to_string() };
    }
    let clean: String = last
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let clean = clean.trim_matches('-');
    if clean.is_empty() {
        "photo".into()
    } else {
        format!("photo-{clean}")
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_bitmaps_from_their_headers() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some("jpg"));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some("png"));
        assert_eq!(sniff(b"\0\0\0\x18ftypcrx \0\0\0\x01"), Some("cr3"));
        assert_eq!(sniff(b"not a photo at all"), None);
    }

    #[test]
    fn media_names_are_safe_and_stable() {
        let a = "content://media/picker/0/com.android.providers.media.photopicker/media/1000012345";
        assert_eq!(media_name(a), "photo-1000012345");
        assert_eq!(media_name(a), media_name(a));
        assert_eq!(
            media_name("content://com.android.providers.media.documents/document/image%3A42"),
            "photo-image-42"
        );
        assert_eq!(media_name("content://x/"), "photo-x");
    }

    #[test]
    fn ios_file_urls_keep_their_real_name() {
        assert_eq!(media_name("file:///private/var/mobile/tmp/IMG_1234.JPG"), "IMG-1234");
        assert_eq!(media_name("file:///x/DSC09673.ARW"), "DSC09673");
    }

    #[test]
    fn heic_is_recognised_so_it_can_be_explained() {
        assert!(is_heic(b"\0\0\0\x18ftypheic\0\0\0\0"));
        assert!(is_heic(b"\0\0\0\x18ftypmif1\0\0\0\0"));
        // CR3 shares the ftyp box but is a RAW
        assert!(!is_heic(b"\0\0\0\x18ftypcrx \0\0\0\x01"));
    }

    #[test]
    fn plain_paths_pass_straight_through() {
        assert_eq!(percent_decode("C:/My%20Photos/a.ARW"), "C:/My Photos/a.ARW");
        assert_eq!(percent_decode("100%"), "100%");
    }
}
