pub mod color;
pub mod decode;
pub mod denoise;
pub mod detail;
pub mod export;
pub mod pipeline;
pub mod sidecar;

use decode::{LinearImage, Metadata};
use pipeline::EditParams;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::State;

// RAW previews stay bounded because the WebGL develop pipeline keeps several
// float render targets alive at once. Already-developed bitmap files can use a
// somewhat larger preview so common 2K/3K JPEGs are not needlessly softened.
const RAW_PREVIEW_MAX_EDGE: usize = 2560;
const BITMAP_PREVIEW_MAX_EDGE: usize = 3200;
const THUMB_MAX_EDGE: usize = 240;

pub struct Loaded {
    path: String,
    image: Arc<LinearImage>,
    preview_f16: Arc<Vec<u8>>,
    preview_w: usize,
    preview_h: usize,
    preview_sigma: f32,
}

#[derive(Default)]
pub struct AppState {
    loaded: Mutex<Option<Loaded>>,
    watermark: Mutex<Option<(String, Arc<pipeline::WatermarkImage>)>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatermarkInfo {
    path: String,
    width: usize,
    height: usize,
}

/// Decode a watermark overlay image and keep it for `get_watermark_pixels`.
#[tauri::command]
async fn open_watermark(path: String, state: State<'_, AppState>) -> Result<WatermarkInfo, String> {
    let p = path.clone();
    let wm = tauri::async_runtime::spawn_blocking(move || pipeline::WatermarkImage::load(Path::new(&p)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)?;
    let info = WatermarkInfo {
        path: path.clone(),
        width: wm.width,
        height: wm.height,
    };
    *state.watermark.lock().unwrap() = Some((path, Arc::new(wm)));
    Ok(info)
}

/// RGBA8 pixels of the watermark loaded with `openWatermark`.
#[tauri::command]
fn get_watermark_pixels(state: State<'_, AppState>) -> Result<Response, String> {
    let guard = state.watermark.lock().unwrap();
    let (_, wm) = guard.as_ref().ok_or("no watermark loaded")?;
    Ok(Response::new(wm.rgba.clone()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInfo {
    path: String,
    width: usize,
    height: usize,
    preview_width: usize,
    preview_height: usize,
    /// noise sigma of the preview in the sqrt-luma domain (see denoise.rs)
    noise_sigma: f32,
    metadata: Metadata,
    edits: Option<EditParams>,
    thumbnail: String,
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
async fn open_image(path: String, state: State<'_, AppState>) -> Result<ImageInfo, String> {
    let p = path.clone();
    let (loaded, meta, thumb) = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let t0 = std::time::Instant::now();
        let preview_max = if decode::is_raw(Path::new(&p)) {
            RAW_PREVIEW_MAX_EDGE
        } else {
            BITMAP_PREVIEW_MAX_EDGE
        };
        let (image, meta) = decode::load(Path::new(&p))?;
        let t1 = t0.elapsed();
        let preview = decode::downsample(&image, preview_max);
        let t2 = t0.elapsed();
        let thumb = export::thumbnail_data_url(&preview, THUMB_MAX_EDGE)?;
        let t3 = t0.elapsed();
        let sigma = denoise::estimate_sigma(&preview.data, preview.width, preview.height);
        let t4 = t0.elapsed();
        let f16 = decode::to_f16_bytes(&preview.data);
        log::info!(
            "open {}x{}: decode {:.2}s, preview {:.2}s, thumb {:.2}s, sigma {:.2}s ({sigma:.5}), f16 {:.2}s",
            image.width,
            image.height,
            t1.as_secs_f32(),
            (t2 - t1).as_secs_f32(),
            (t3 - t2).as_secs_f32(),
            (t4 - t3).as_secs_f32(),
            (t0.elapsed() - t4).as_secs_f32()
        );
        Ok((
            Loaded {
                path: p,
                image: Arc::new(image),
                preview_f16: Arc::new(f16),
                preview_w: preview.width,
                preview_h: preview.height,
                preview_sigma: sigma,
            },
            meta,
            thumb,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)?;

    let info = ImageInfo {
        path: loaded.path.clone(),
        width: loaded.image.width,
        height: loaded.image.height,
        preview_width: loaded.preview_w,
        preview_height: loaded.preview_h,
        noise_sigma: loaded.preview_sigma,
        metadata: meta,
        edits: sidecar::load(Path::new(&loaded.path)),
        thumbnail: thumb,
    };
    *state.loaded.lock().unwrap() = Some(loaded);
    Ok(info)
}

/// Returns the preview as raw little-endian RGB half floats (3 x u16 per pixel).
#[tauri::command]
fn get_preview(state: State<'_, AppState>) -> Result<Response, String> {
    let guard = state.loaded.lock().unwrap();
    let loaded = guard.as_ref().ok_or("no image loaded")?;
    Ok(Response::new(loaded.preview_f16.as_ref().clone()))
}

#[tauri::command]
fn save_edits(path: String, edits: EditParams) -> Result<(), String> {
    sidecar::save(Path::new(&path), &edits).map_err(err)
}

#[tauri::command]
async fn export_image(req: export::ExportRequest, state: State<'_, AppState>) -> Result<String, String> {
    let image = {
        let guard = state.loaded.lock().unwrap();
        let loaded = guard.as_ref().ok_or("no image loaded")?;
        loaded.image.clone()
    };
    let out = req.out_path.clone();
    tauri::async_runtime::spawn_blocking(move || export::export(&image, &req))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)?;
    Ok(out)
}

/// What was open when the app last closed, restored on the next launch.
#[derive(Serialize, serde::Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    files: Vec<String>,
    current: Option<String>,
}

fn session_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("session.json"))
}

#[tauri::command]
fn load_session(app: tauri::AppHandle) -> Result<Session, String> {
    let p = session_path(&app)?;
    let Ok(text) = std::fs::read_to_string(&p) else {
        return Ok(Session::default());
    };
    let mut s: Session = serde_json::from_str(&text).unwrap_or_default();
    // drop photos that no longer exist
    s.files.retain(|f| Path::new(f).is_file());
    if let Some(c) = &s.current {
        if !Path::new(c).is_file() {
            s.current = None;
        }
    }
    Ok(s)
}

#[tauri::command]
fn save_session(app: tauri::AppHandle, session: Session) -> Result<(), String> {
    let p = session_path(&app)?;
    let text = serde_json::to_string_pretty(&session).map_err(|e| e.to_string())?;
    std::fs::write(&p, text).map_err(|e| e.to_string())
}

/// Image path passed on the command line (`darkroom photo.CR3`), if any.
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_file())
}

#[tauri::command]
fn supported_extensions() -> Vec<String> {
    decode::RAW_EXTENSIONS
        .iter()
        .chain(decode::IMAGE_EXTENSIONS.iter())
        .map(|s| s.to_string())
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_image,
            get_preview,
            save_edits,
            export_image,
            open_watermark,
            get_watermark_pixels,
            startup_file,
            load_session,
            save_session,
            supported_extensions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
