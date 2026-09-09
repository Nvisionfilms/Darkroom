//! Develop presets: a named set of develop settings stored as JSON in the
//! app data folder, so they can be applied to any photo later.
//!
//! A preset deliberately leaves out everything that belongs to one particular
//! frame: crop, rotation, perspective, masks, retouch spots and the lens
//! calibration. Applying a preset never moves the picture around.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    pub name: String,
    /// the develop subset, as an EditParams-shaped object
    pub settings: serde_json::Value,
}

/// Fields a preset stores. Everything else stays as it is on the photo.
pub const PRESET_KEYS: &[&str] = &[
    "exposure",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "temperature",
    "tint",
    "vibrance",
    "saturation",
    "baseContrast",
    "sharpen",
    "texture",
    "clarity",
    "dehaze",
    "denoiseLuma",
    "denoiseChroma",
    "denoiseDetail",
    "grading",
    "hsl",
    "curves",
    "profile",
    "look",
    "lens",
];

fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "preset".into()
    } else {
        s.chars().take(60).collect()
    }
}

pub fn dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    let d = app.path().app_data_dir().context("app data dir")?.join("presets");
    std::fs::create_dir_all(&d).with_context(|| format!("create {}", d.display()))?;
    Ok(d)
}

pub fn list(app: &tauri::AppHandle) -> Result<Vec<Preset>> {
    let d = dir(app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&d)?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str::<Preset>(&t).ok()) {
            Some(preset) => out.push(preset),
            None => log::warn!("preset: skipping unreadable {}", p.display()),
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Keep only the develop keys, so a preset never carries frame-specific data.
pub fn filter(settings: &serde_json::Value) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    if let Some(obj) = settings.as_object() {
        for k in PRESET_KEYS {
            if let Some(v) = obj.get(*k) {
                out.insert((*k).to_string(), v.clone());
            }
        }
    }
    serde_json::Value::Object(out)
}

pub fn save(app: &tauri::AppHandle, name: &str, settings: &serde_json::Value) -> Result<Preset> {
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "a preset needs a name");
    let preset = Preset {
        name: name.to_string(),
        settings: filter(settings),
    };
    let path = dir(app)?.join(format!("{}.json", slug(name)));
    std::fs::write(&path, serde_json::to_string_pretty(&preset)?)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(preset)
}

pub fn delete(app: &tauri::AppHandle, name: &str) -> Result<()> {
    let path = dir(app)?.join(format!("{}.json", slug(name)));
    if Path::new(&path).exists() {
        std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}
