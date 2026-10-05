//! The watermark library: marks you have used before, kept in the app data
//! folder so choosing one is a click rather than a trip through a file picker.
//!
//! A mark is saved by copying the image in, not by remembering where it was. A
//! watermark that lives in Downloads and gets tidied away would otherwise leave
//! every photo that used it exporting without one, silently.

use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    /// what it is called in the library: the file name without its extension
    pub name: String,
    /// where the saved copy lives
    pub path: String,
}

const EXTENSIONS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

pub fn dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    let d = app
        .path()
        .app_data_dir()
        .context("app data dir")?
        .join("watermarks");
    std::fs::create_dir_all(&d).with_context(|| format!("create {}", d.display()))?;
    Ok(d)
}

fn is_image(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// A name safe to use as a file name, keeping the letters people recognise.
pub fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '-' })
        .collect();
    let s = s.trim().trim_matches('-').to_string();
    if s.is_empty() {
        "watermark".into()
    } else {
        s.chars().take(60).collect()
    }
}

pub fn list_in(d: &Path) -> Result<Vec<Mark>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(d)?.flatten() {
        let p = entry.path();
        if !is_image(&p) {
            continue;
        }
        let name = p.file_stem().and_then(|s| s.to_str()).unwrap_or("watermark").to_string();
        out.push(Mark { name, path: p.to_string_lossy().into_owned() });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Copy `src` into the library under `name`, replacing a mark of the same name.
pub fn save_in(d: &Path, src: &Path, name: Option<&str>) -> Result<Mark> {
    if !src.is_file() {
        bail!("{} is not a file", src.display());
    }
    if !is_image(src) {
        bail!("a watermark has to be a PNG, JPEG or WebP image");
    }
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_ascii_lowercase();
    let stem = match name {
        Some(n) if !n.trim().is_empty() => slug(n),
        _ => slug(src.file_stem().and_then(|s| s.to_str()).unwrap_or("watermark")),
    };
    // one mark per name, whatever format it came in: saving "logo" as a PNG over
    // an older "logo.jpg" must not leave two logos behind
    for e in EXTENSIONS {
        let old = d.join(format!("{stem}.{e}"));
        if old.exists() {
            std::fs::remove_file(&old).ok();
        }
    }
    let dest = d.join(format!("{stem}.{ext}"));
    std::fs::copy(src, &dest).with_context(|| format!("copy to {}", dest.display()))?;
    Ok(Mark { name: stem, path: dest.to_string_lossy().into_owned() })
}

pub fn delete_in(d: &Path, name: &str) -> Result<()> {
    let stem = slug(name);
    for e in EXTENSIONS {
        let p = d.join(format!("{stem}.{e}"));
        if p.exists() {
            std::fs::remove_file(&p).with_context(|| format!("remove {}", p.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("darkroom-wmlib-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&d).ok();
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_png(d: &Path, name: &str) -> PathBuf {
        let p = d.join(name);
        std::fs::write(&p, b"\x89PNG not really").unwrap();
        p
    }

    #[test]
    fn a_saved_mark_is_a_copy_that_outlives_the_original() {
        let lib = scratch("a-lib");
        let src_dir = scratch("a-src");
        let src = fake_png(&src_dir, "My Logo.png");
        let m = save_in(&lib, &src, None).unwrap();
        // the original is tidied away, as Downloads folders are
        std::fs::remove_dir_all(&src_dir).unwrap();
        assert!(Path::new(&m.path).is_file(), "the saved copy went with the original");
        let all = list_in(&lib).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "My Logo");
    }

    #[test]
    fn saving_a_name_again_replaces_it_whatever_the_format() {
        let lib = scratch("b-lib");
        let src_dir = scratch("b-src");
        save_in(&lib, &fake_png(&src_dir, "logo.png"), Some("logo")).unwrap();
        let jpg = src_dir.join("logo.jpg");
        std::fs::write(&jpg, b"jpeg").unwrap();
        save_in(&lib, &jpg, Some("logo")).unwrap();
        let all = list_in(&lib).unwrap();
        assert_eq!(all.len(), 1, "two logos were left behind: {all:?}");
        assert!(all[0].path.ends_with("logo.jpg"));
    }

    #[test]
    fn only_images_go_in_and_delete_takes_one_out() {
        let lib = scratch("c-lib");
        let src_dir = scratch("c-src");
        let txt = src_dir.join("notes.txt");
        std::fs::write(&txt, b"hi").unwrap();
        assert!(save_in(&lib, &txt, None).is_err(), "a text file became a watermark");
        assert!(save_in(&lib, &src_dir.join("missing.png"), None).is_err());
        save_in(&lib, &fake_png(&src_dir, "a.png"), None).unwrap();
        save_in(&lib, &fake_png(&src_dir, "b.png"), None).unwrap();
        delete_in(&lib, "a").unwrap();
        let names: Vec<_> = list_in(&lib).unwrap().into_iter().map(|m| m.name).collect();
        assert_eq!(names, vec!["b".to_string()]);
    }

    #[test]
    fn a_name_cannot_climb_out_of_the_library() {
        let lib = scratch("d-lib");
        let src_dir = scratch("d-src");
        let m = save_in(&lib, &fake_png(&src_dir, "x.png"), Some("../../escape")).unwrap();
        let parent = Path::new(&m.path).parent().unwrap().canonicalize().unwrap();
        assert_eq!(parent, lib.canonicalize().unwrap(), "the mark was written outside the library");
    }
}
