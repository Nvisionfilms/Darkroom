//! The photo library: a folder with one session folder inside it per import.
//!
//! Importing copies the chosen photos into a fresh session folder, so a shoot
//! ends up in one place together with its edits (the `.drk.json` sidecars come
//! along) whatever drive the originals were picked from.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    /// the session folder the photos went into ("" if nothing needed copying)
    pub session: String,
    /// where each photo now is, in the order they were given
    pub files: Vec<String>,
}

/// A folder name that is safe on every platform, whatever the caller sent.
fn clean(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | ' ' | '.') { c } else { '-' })
        .collect();
    let s = s.trim().trim_matches('.').to_string();
    if s.is_empty() {
        "Import".to_string()
    } else {
        s
    }
}

/// `base`, or `base-2`, `base-3`... whichever does not exist yet.
fn fresh_dir(parent: &Path, base: &str) -> PathBuf {
    let first = parent.join(base);
    if !first.exists() {
        return first;
    }
    (2..)
        .map(|n| parent.join(format!("{base}-{n}")))
        .find(|p| !p.exists())
        .unwrap()
}

fn fresh_file(dir: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem}-{n}{ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Copy `paths` into a new session folder named `session` inside `library`.
/// Photos that already live in the library are used where they are.
pub fn import(library: &Path, session: &str, paths: &[String]) -> Result<Imported> {
    std::fs::create_dir_all(library).with_context(|| format!("cannot create {}", library.display()))?;
    let lib = std::fs::canonicalize(library).unwrap_or_else(|_| library.to_path_buf());
    let mut dir: Option<PathBuf> = None;
    let mut files = Vec::with_capacity(paths.len());
    for p in paths {
        let src = Path::new(p);
        let inside = std::fs::canonicalize(src).map(|c| c.starts_with(&lib)).unwrap_or(false);
        if inside {
            files.push(p.clone());
            continue;
        }
        let d = match &dir {
            Some(d) => d.clone(),
            None => {
                let d = fresh_dir(library, &clean(session));
                std::fs::create_dir_all(&d)?;
                dir = Some(d.clone());
                d
            }
        };
        let name = src.file_name().context("a photo with no file name")?;
        let to = fresh_file(&d, name);
        std::fs::copy(src, &to).with_context(|| format!("cannot copy {}", src.display()))?;
        // keep the edits that go with it
        let side = crate::sidecar::sidecar_path(src);
        if side.exists() {
            let _ = std::fs::copy(&side, crate::sidecar::sidecar_path(&to));
        }
        files.push(to.to_string_lossy().into_owned());
    }
    Ok(Imported {
        session: dir.map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(),
        files,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub name: String,
    pub path: String,
    pub count: usize,
}

fn is_photo(p: &Path) -> bool {
    let ext = p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    crate::decode::RAW_EXTENSIONS.iter().chain(crate::decode::IMAGE_EXTENSIONS.iter()).any(|e| e.eq_ignore_ascii_case(&ext))
}

/// The photos directly inside `dir`, in name order.
pub fn photos_in(dir: &Path) -> Result<Vec<String>> {
    let mut out: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_photo(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    out.sort_by_key(|s| s.to_lowercase());
    Ok(out)
}

/// The session folders in the library that hold photos, newest first (the names
/// start with the date, so name order is time order).
pub fn sessions(library: &Path) -> Result<Vec<Session>> {
    if !library.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for e in std::fs::read_dir(library)?.filter_map(|e| e.ok()) {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let count = photos_in(&p).map(|v| v.len()).unwrap_or(0);
        if count == 0 {
            continue;
        }
        out.push(Session {
            name: e.file_name().to_string_lossy().into_owned(),
            path: p.to_string_lossy().into_owned(),
            count,
        });
    }
    out.sort_by(|a, b| b.name.to_lowercase().cmp(&a.name.to_lowercase()));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("darkroom-lib-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn each_import_gets_its_own_session_with_every_photo_and_its_edits() {
        let root = scratch("a");
        let from = root.join("card");
        std::fs::create_dir_all(&from).unwrap();
        std::fs::write(from.join("a.jpg"), b"A").unwrap();
        std::fs::write(from.join("b.jpg"), b"B").unwrap();
        std::fs::write(from.join("a.jpg.drk.json"), b"{}").unwrap();
        let lib = root.join("library");
        let pics = vec![from.join("a.jpg").to_string_lossy().into_owned(), from.join("b.jpg").to_string_lossy().into_owned()];

        let one = import(&lib, "2026-10-05_2145", &pics).unwrap();
        assert_eq!(one.files.len(), 2);
        assert!(Path::new(&one.session).ends_with("2026-10-05_2145"));
        assert_eq!(std::fs::read(&one.files[1]).unwrap(), b"B");
        assert!(crate::sidecar::sidecar_path(Path::new(&one.files[0])).exists(), "edits did not come along");
        assert!(from.join("a.jpg").exists(), "the original was moved, not copied");

        // the same minute again is a different session, not a merge into the first
        let two = import(&lib, "2026-10-05_2145", &pics).unwrap();
        assert_ne!(one.session, two.session);
        assert!(Path::new(&two.session).ends_with("2026-10-05_2145-2"));

        // photos already in the library are not copied again
        let again = import(&lib, "later", &one.files).unwrap();
        assert_eq!(again.files, one.files);
        assert!(again.session.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sessions_list_newest_first_with_their_photos() {
        let root = scratch("c");
        for (d, n) in [("2026-01-02_1000", 2), ("2026-03-04_0900", 1)] {
            std::fs::create_dir_all(root.join(d)).unwrap();
            for i in 0..n {
                std::fs::write(root.join(d).join(format!("p{i}.jpg")), b"x").unwrap();
            }
            std::fs::write(root.join(d).join("p0.jpg.drk.json"), b"{}").unwrap();
        }
        std::fs::create_dir_all(root.join("empty")).unwrap();
        let s = sessions(&root).unwrap();
        assert_eq!(s.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["2026-03-04_0900", "2026-01-02_1000"]);
        assert_eq!((s[0].count, s[1].count), (1, 2), "edit files must not be counted as photos");
        assert_eq!(photos_in(Path::new(&s[1].path)).unwrap().len(), 2);
        assert!(sessions(&root.join("nope")).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn two_photos_with_one_name_do_not_overwrite_each_other() {
        let root = scratch("b");
        for d in ["x", "y"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
            std::fs::write(root.join(d).join("IMG_1.jpg"), d.as_bytes()).unwrap();
        }
        let pics = vec![root.join("x/IMG_1.jpg").to_string_lossy().into_owned(), root.join("y/IMG_1.jpg").to_string_lossy().into_owned()];
        let got = import(&root.join("lib"), "s", &pics).unwrap();
        assert_ne!(got.files[0], got.files[1]);
        assert_eq!(std::fs::read(&got.files[0]).unwrap(), b"x");
        assert_eq!(std::fs::read(&got.files[1]).unwrap(), b"y");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn session_names_cannot_escape_the_library() {
        let n = clean("../../evil\\x:y");
        assert!(!n.contains('/') && !n.contains('\\') && !n.contains(':') && !n.starts_with('.'), "{n}");
    }
}
