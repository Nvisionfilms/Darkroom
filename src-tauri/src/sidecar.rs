//! Non-destructive edit storage: `<image>.drk.json` next to the source file.

use crate::pipeline::EditParams;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Sidecar {
    version: u32,
    edits: EditParams,
}

pub fn sidecar_path(image: &Path) -> PathBuf {
    let mut s = image.as_os_str().to_owned();
    s.push(".drk.json");
    PathBuf::from(s)
}

pub fn load(image: &Path) -> Option<EditParams> {
    let p = sidecar_path(image);
    let text = std::fs::read_to_string(&p).ok()?;
    match serde_json::from_str::<Sidecar>(&text) {
        Ok(s) => Some(s.edits),
        Err(e) => {
            log::warn!("ignoring unreadable sidecar {}: {e}", p.display());
            None
        }
    }
}

pub fn save(image: &Path, edits: &EditParams) -> Result<()> {
    let p = sidecar_path(image);
    let text = serde_json::to_string_pretty(&Sidecar {
        version: VERSION,
        edits: edits.clone(),
    })?;
    std::fs::write(&p, text).with_context(|| format!("write {}", p.display()))
}
