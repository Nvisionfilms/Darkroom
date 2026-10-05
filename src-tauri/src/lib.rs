pub mod blend;
pub mod camlog;
#[cfg(test)]
mod checks;
pub mod color;
pub mod decode;
pub mod denoise;
pub mod detail;
pub mod export;
pub mod geometry;
pub mod grain;
pub mod heal;
pub mod icc;
pub mod import;
pub mod lensdb;
pub mod library;
pub mod lossless;
pub mod lut3d;
pub mod mask;
pub mod monitor;
pub mod pipeline;
pub mod preset;
pub mod profiles;
pub mod sidecar;
pub mod cube;
pub mod star;
pub mod tonematch;
pub mod vignette;
pub mod wmlib;
pub mod tether;
pub mod thumb;

use decode::{LinearImage, Metadata};
use pipeline::EditParams;
use serde::Serialize;
use std::path::Path;
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::Manager;
use tauri::State;

// RAW previews stay bounded because the WebGL develop pipeline keeps several
// float render targets alive at once. Already-developed bitmap files can use a
// somewhat larger preview so common 2K/3K JPEGs are not needlessly softened.
const RAW_PREVIEW_MAX_EDGE: usize = 2560;
const BITMAP_PREVIEW_MAX_EDGE: usize = 3200;
const THUMB_MAX_EDGE: usize = 240;
/// The second picture of a double exposure only has to look right on screen;
/// the export reads it again at full resolution.
const BLEND_PREVIEW_MAX_EDGE: usize = 1800;

pub struct Loaded {
    path: String,
    image: Arc<LinearImage>,
    preview_f16: Arc<Vec<u8>>,
    preview_w: usize,
    preview_h: usize,
    preview_sigma: f32,
    preview_shadow: f32,
}

#[derive(Default)]
pub struct AppState {
    loaded: Mutex<Option<Loaded>>,
    watermark: Mutex<Option<(String, Arc<pipeline::WatermarkImage>)>>,
    tether: Mutex<Option<tether::Active>>,
    monitor: Mutex<Option<monitor::Monitor>>,
    look: Mutex<Option<(String, Arc<lut3d::Lut3d>)>>,
    /// the second picture of a double exposure, downsampled for the preview
    blend: Mutex<Option<(String, Arc<Vec<u8>>)>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookInfo {
    path: String,
    name: String,
    size: usize,
}

/// Parse a .cube file and keep it for `get_look_pixels`.
#[tauri::command]
async fn open_look(path: String, state: State<'_, AppState>) -> Result<LookInfo, String> {
    let p = path.clone();
    let lut = tauri::async_runtime::spawn_blocking(move || lut3d::Lut3d::load(Path::new(&p)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)?;
    let info = LookInfo {
        path: path.clone(),
        name: lut.name.clone(),
        size: lut.size,
    };
    *state.look.lock().unwrap() = Some((path, Arc::new(lut)));
    Ok(info)
}

/// The loaded look as RGBA half floats, ready for a WebGL2 3D texture.
#[tauri::command]
fn get_look_pixels(state: State<'_, AppState>) -> Result<Response, String> {
    let guard = state.look.lock().unwrap();
    let (_, lut) = guard.as_ref().ok_or("no look loaded")?;
    Ok(Response::new(lut.to_rgba_f16()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendInfo {
    path: String,
    name: String,
    width: usize,
    height: usize,
}

/// Decode the second picture of a double exposure and keep a preview-sized
/// copy for `get_blend_pixels`. Any format the app can open works, RAW
/// included.
#[tauri::command]
async fn open_blend(path: String, state: State<'_, AppState>) -> Result<BlendInfo, String> {
    let p = path.clone();
    let (w, h, f16) = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let (image, _) = decode::load(Path::new(&p))?;
        let small = decode::downsample(&image, BLEND_PREVIEW_MAX_EDGE);
        let f16 = decode::to_f16_bytes(&small.data);
        Ok((small.width, small.height, f16))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)?;
    let name = Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    *state.blend.lock().unwrap() = Some((path.clone(), Arc::new(f16)));
    Ok(BlendInfo {
        path,
        name,
        width: w,
        height: h,
    })
}

/// The loaded second picture as linear RGB half floats (3 x u16 per pixel),
/// the same shape as `get_preview`.
#[tauri::command]
fn get_blend_pixels(state: State<'_, AppState>) -> Result<Response, String> {
    let guard = state.blend.lock().unwrap();
    let (_, b) = guard.as_ref().ok_or("no second picture loaded")?;
    Ok(Response::new(b.as_ref().clone()))
}

// ---- develop presets ----

#[tauri::command]
fn list_presets(app: tauri::AppHandle) -> Result<Vec<preset::Preset>, String> {
    preset::list(&app).map_err(err)
}

#[tauri::command]
fn save_preset(
    app: tauri::AppHandle,
    name: String,
    settings: serde_json::Value,
) -> Result<preset::Preset, String> {
    preset::save(&app, &name, &settings).map_err(err)
}

#[tauri::command]
fn delete_preset(app: tauri::AppHandle, name: String) -> Result<(), String> {
    preset::delete(&app, &name).map_err(err)
}

// ---- tethered capture (hot folder) ----

#[tauri::command]
fn start_tether(
    app: tauri::AppHandle,
    folder: String,
    state: State<'_, AppState>,
) -> Result<tether::TetherStatus, String> {
    let active = tether::start(app, folder).map_err(err)?;
    let status = active.status();
    *state.tether.lock().unwrap() = Some(active);
    Ok(status)
}

#[tauri::command]
fn stop_tether(state: State<'_, AppState>) -> tether::TetherStatus {
    let prev = state.tether.lock().unwrap().take();
    tether::TetherStatus {
        active: false,
        folder: prev.map(|a| a.status().folder).unwrap_or_default(),
        count: 0,
    }
}

#[tauri::command]
fn tether_status(state: State<'_, AppState>) -> tether::TetherStatus {
    state
        .tether
        .lock()
        .unwrap()
        .as_ref()
        .map(|a| a.status())
        .unwrap_or_default()
}

// ---- phone monitor (LAN web page) ----

fn monitor_off() -> monitor::MonitorInfo {
    monitor::MonitorInfo {
        active: false,
        url: String::new(),
        port: 0,
        qr_svg: String::new(),
        viewers: 0,
    }
}

#[tauri::command]
fn start_monitor(state: State<'_, AppState>) -> Result<monitor::MonitorInfo, String> {
    let mut guard = state.monitor.lock().unwrap();
    if let Some(m) = guard.as_ref() {
        return Ok(m.info());
    }
    let m = monitor::start().map_err(err)?;
    let info = m.info();
    *guard = Some(m);
    Ok(info)
}

#[tauri::command]
fn stop_monitor(state: State<'_, AppState>) -> monitor::MonitorInfo {
    let prev = state.monitor.lock().unwrap().take();
    drop(prev);
    monitor_off()
}

#[tauri::command]
fn monitor_status(state: State<'_, AppState>) -> monitor::MonitorInfo {
    state
        .monitor
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.info())
        .unwrap_or_else(monitor_off)
}

/// Current file name, metadata line and filmstrip for the phone page.
#[tauri::command]
fn publish_shot(shot: monitor::Shot, state: State<'_, AppState>) -> u64 {
    state
        .monitor
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.publish_shot(shot))
        .unwrap_or(0)
}

/// JPEG bytes of the developed image as the app currently shows it. The
/// webview sends the encoded picture as the raw request body.
#[tauri::command]
fn publish_frame(
    request: tauri::ipc::Request<'_>,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("publish_frame expects raw JPEG bytes".into());
    };
    Ok(state
        .monitor
        .lock()
        .unwrap()
        .as_ref()
        .map(|m| m.publish_frame(bytes.clone()))
        .unwrap_or(0))
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
    let wm =
        tauri::async_runtime::spawn_blocking(move || pipeline::WatermarkImage::load(Path::new(&p)))
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
    /// how fast noise rises into the shadows; see denoise::noise_factor
    noise_shadow: f32,
    metadata: Metadata,
    edits: Option<EditParams>,
    thumbnail: String,
    /// lens calibration found for this camera/lens, if any
    lens_profile: Option<geometry::LensProfile>,
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

/// A path the decoder can open for whatever the file picker returned. On the
/// desktop that is the path itself; on Android a picked photo is a content://
/// handle and is copied into the app's own storage first (see import.rs).
#[tauri::command]
async fn import_photo(
    app: tauri::AppHandle,
    uri: String,
    ext: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || import::resolve(&app, &uri, ext.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(err)
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
        let shadow = denoise::estimate_shadow(&preview.data, preview.width, preview.height);
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
                preview_shadow: shadow,
            },
            meta,
            thumb,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)?;

    let lens_profile = lensdb::lookup(
        meta.camera.as_deref(),
        meta.lens.as_deref(),
        meta.focal_length,
        meta.f_number,
    );
    let info = ImageInfo {
        path: loaded.path.clone(),
        width: loaded.image.width,
        height: loaded.image.height,
        preview_width: loaded.preview_w,
        preview_height: loaded.preview_h,
        noise_sigma: loaded.preview_sigma,
        noise_shadow: loaded.preview_shadow,
        metadata: meta,
        edits: sidecar::load(Path::new(&loaded.path)),
        thumbnail: thumb,
        lens_profile,
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

/// Copy photos into a new session folder inside the library folder.
#[tauri::command]
async fn import_to_library(library: String, session: String, paths: Vec<String>) -> Result<library::Imported, String> {
    tauri::async_runtime::spawn_blocking(move || library::import(Path::new(&library), &session, &paths))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

/// Write the current look as a .cube 3D LUT, for Resolve and anything else
/// that loads one. Returns the settings it could not carry, so the app can say
/// so rather than letting the photographer assume the file holds everything.
#[tauri::command]
async fn export_cube(
    out_path: String,
    params: pipeline::EditParams,
    lut: Vec<f32>,
    size: usize,
    title: String,
) -> Result<Vec<String>, String> {
    let left = cube::excluded(&params).iter().map(|s| s.to_string()).collect();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        let lut = if lut.len() == 1024 { lut } else { pipeline::identity_lut() };
        // the creative look is part of the colour, so it belongs in the cube; a
        // look that cannot be read is skipped with a warning, as on export
        let look = if params.look.is_active() {
            match lut3d::Lut3d::load(Path::new(&params.look.path)) {
                Ok(l) => Some(l),
                Err(e) => {
                    log::warn!("look: {e:#}");
                    None
                }
            }
        } else {
            None
        };
        cube::write(Path::new(&out_path), &params, &lut, size, &title, look.as_ref())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)?;
    Ok(left)
}

#[tauri::command]
async fn export_image(
    app: tauri::AppHandle,
    req: export::ExportRequest,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let image = {
        let guard = state.loaded.lock().unwrap();
        let loaded = guard.as_ref().ok_or("no image loaded")?;
        loaded.image.clone()
    };
    let out = req.out_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        if !import::is_handle(&req.out_path) {
            return export::export(&image, &req);
        }
        // a phone save location: render into app storage, then copy it out
        let handle = req.out_path.clone();
        let ext = match req.format.as_str() {
            "png" => "png",
            "tiff" | "tif" => "tif",
            _ => "jpg",
        };
        let tmp = app.path().app_cache_dir()?.join(format!("export.{ext}"));
        let mut req = req;
        req.out_path = tmp.to_string_lossy().into_owned();
        export::export(&image, &req)?;
        import::write_back(&app, &handle, &tmp)?;
        std::fs::remove_file(&tmp).ok();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)?;
    Ok(out)
}

/// The edits saved beside a photo, without decoding the photo itself. Batch
/// work needs every selected photo's settings, and opening each one to read
/// them would mean demosaicing a whole folder.
#[tauri::command]
fn read_edits(path: String) -> Option<EditParams> {
    sidecar::load(Path::new(&path))
}

/// Which of these photos are flagged for export. Reads the sidecars only,
/// so a whole folder can be checked without decoding anything.
#[tauri::command]
fn marked_photos(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| {
            sidecar::load(Path::new(p))
                .map(|e| e.marked)
                .unwrap_or(false)
        })
        .collect()
}

/// Save edits for several photos at once: used to apply a preset to a
/// selection. Each photo keeps everything the preset does not cover, so its
/// crop, masks and retouching survive.
#[tauri::command]
fn apply_edits(paths: Vec<String>, settings: serde_json::Value) -> Result<usize, String> {
    let Some(fields) = settings.as_object() else {
        return Err("a preset must be an object".into());
    };
    let mut done = 0;
    for path in &paths {
        let p = Path::new(path);
        let current = sidecar::load(p).unwrap_or_default();
        let mut merged = match serde_json::to_value(&current) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => continue,
        };
        for (k, v) in fields {
            merged.insert(k.clone(), v.clone());
        }
        let edits: EditParams = match serde_json::from_value(serde_json::Value::Object(merged)) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("preset does not fit {path}: {e}");
                continue;
            }
        };
        match sidecar::save(p, &edits) {
            Ok(()) => done += 1,
            Err(e) => log::warn!("could not save edits for {path}: {e:#}"),
        }
    }
    Ok(done)
}

/// Export a photo that is not the one open in the viewer. The open photo is
/// already decoded and kept in memory; this decodes the file first, which is
/// what a batch export needs for each of its photos.
#[tauri::command]
async fn export_path(
    app: tauri::AppHandle,
    path: String,
    req: export::ExportRequest,
) -> Result<String, String> {
    let out = req.out_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        let (image, _) = decode::load(Path::new(&path))?;
        if !import::is_handle(&req.out_path) {
            return export::export(&image, &req);
        }
        let handle = req.out_path.clone();
        let ext = match req.format.as_str() {
            "png" => "png",
            "tiff" | "tif" => "tif",
            _ => "jpg",
        };
        let tmp = app.path().app_cache_dir()?.join(format!("export.{ext}"));
        let mut req = req;
        req.out_path = tmp.to_string_lossy().into_owned();
        export::export(&image, &req)?;
        import::write_back(&app, &handle, &tmp)?;
        std::fs::remove_file(&tmp).ok();
        Ok(())
    })
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

/// Pick a source patch for an object-remover spot, from the loaded photo.
/// Deterministic patch search; it copies existing pixels, nothing generated.
#[tauri::command]
async fn find_heal_source(
    x: f32,
    y: f32,
    radius: f32,
    avoid: Vec<(f32, f32, f32)>,
    state: State<'_, AppState>,
) -> Result<(f32, f32), String> {
    let image = {
        let guard = state.loaded.lock().unwrap();
        guard.as_ref().ok_or("no image loaded")?.image.clone()
    };
    tauri::async_runtime::spawn_blocking(move || {
        heal::find_source(&image.data, image.width, image.height, x, y, radius, &avoid)
    })
    .await
    .map_err(|e| e.to_string())
}

/// A filmstrip thumbnail for a file that has not been opened yet. Cheap
/// enough to run for a whole folder: RAW files use the camera preview.
#[tauri::command]
async fn get_thumbnail(path: String) -> Result<String, String> {
    let p = path.clone();
    tauri::async_runtime::spawn_blocking(move || thumb::thumbnail(Path::new(&p)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

/// Ids of the built-in picture profiles.
#[tauri::command]
fn picture_profiles() -> Vec<String> {
    profiles::IDS.iter().map(|s| s.to_string()).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    os: String,
    /// Whether this build can update itself. Phones cannot: iOS forbids it,
    /// and the Android build leaves updates to however it was installed.
    updates: bool,
}

#[tauri::command]
fn platform() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS.to_string(),
        updates: cfg!(desktop),
    }
}

/// Where a phone looks for its own release.
const MOBILE_MANIFEST: &str = "https://updates.nvisionfilms.com/darkroom/assets/android.json";

/// The release a phone could install, or None where the app updates itself.
///
/// This is read here rather than in the page because the webview is served from
/// tauri.localhost: a fetch to the update domain is cross-origin, and without
/// CORS headers the browser refuses it before it reaches the network. Asking
/// from Rust has no such rule, and keeps the release assets from being readable
/// by any web page that cares to ask.
#[tauri::command]
async fn mobile_update() -> Result<Option<serde_json::Value>, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        tauri::async_runtime::spawn_blocking(|| -> anyhow::Result<Option<serde_json::Value>> {
            let body = ureq::get(MOBILE_MANIFEST)
                .timeout(std::time::Duration::from_secs(15))
                .call()?
                .into_string()?;
            Ok(Some(serde_json::from_str(&body)?))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = MOBILE_MANIFEST;
        Ok(None)
    }
}

/// Find the sliders that make the open photo look like a reference picture.
///
/// Both pictures are shrunk to a couple of hundred pixels and the real develop
/// pipeline is run over the small copy of the photo while the solver searches,
/// so the answer is what the app would actually produce, not an estimate of it.
/// The result is nine ordinary slider values; nothing is written into pixels.
#[tauri::command]
async fn match_tone(
    path: String,
    params: pipeline::EditParams,
    lut: Vec<f32>,
    state: State<'_, AppState>,
) -> Result<tonematch::Match, String> {
    let image = {
        let guard = state.loaded.lock().unwrap();
        guard.as_ref().ok_or("no image loaded")?.image.clone()
    };
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<tonematch::Match> {
        let lut = if lut.len() == 1024 { lut } else { pipeline::identity_lut() };
        let p = Path::new(&path);
        let (reference_image, _) = decode::load(p)?;
        let reference_small = decode::downsample(&reference_image, tonematch::PROXY_EDGE);
        drop(reference_image);
        let reference = tonematch::reference_stats(&reference_small, decode::is_raw(p), &lut);
        let small = decode::downsample(&image, tonematch::PROXY_EDGE);
        Ok(tonematch::run(&small, &params, &lut, &reference))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)
}

/// Work out how to look after the open photo, from the photo itself.
///
/// The same solver as Tone Match, aimed at a target built from the photo's own
/// measurements instead of a reference picture's: it reads where the tones sit
/// and moves them to where a well-exposed photo would, by as much as is needed.
#[tauri::command]
async fn auto_look(
    params: pipeline::EditParams,
    lut: Vec<f32>,
    state: State<'_, AppState>,
) -> Result<tonematch::Match, String> {
    let image = {
        let guard = state.loaded.lock().unwrap();
        guard.as_ref().ok_or("no image loaded")?.image.clone()
    };
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<tonematch::Match> {
        let lut = if lut.len() == 1024 { lut } else { pipeline::identity_lut() };
        let small = decode::downsample(&image, tonematch::PROXY_EDGE);
        Ok(tonematch::auto(&small, &params, &lut))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(err)
}

/// The watermarks saved for reuse.
#[tauri::command]
fn watermark_library(app: tauri::AppHandle) -> Result<Vec<wmlib::Mark>, String> {
    let d = wmlib::dir(&app).map_err(err)?;
    wmlib::list_in(&d).map_err(err)
}

/// Save an image into the library, by copy, and return the saved mark.
#[tauri::command]
fn watermark_save(app: tauri::AppHandle, path: String, name: Option<String>) -> Result<wmlib::Mark, String> {
    let d = wmlib::dir(&app).map_err(err)?;
    wmlib::save_in(&d, Path::new(&path), name.as_deref()).map_err(err)
}

#[tauri::command]
fn watermark_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let d = wmlib::dir(&app).map_err(err)?;
    wmlib::delete_in(&d, &name).map_err(err)
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
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // reads the content:// handles Android's photo picker returns
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init());
    // phones update through their app stores, so the updater is desktop-only
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    builder
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            import_photo,
            open_image,
            get_preview,
            save_edits,
            export_image,
            export_cube,
            import_to_library,
            mobile_update,
            match_tone,
            auto_look,
            watermark_library,
            watermark_save,
            watermark_delete,
            export_path,
            read_edits,
            marked_photos,
            apply_edits,
            open_watermark,
            get_watermark_pixels,
            startup_file,
            load_session,
            save_session,
            platform,
            supported_extensions,
            start_tether,
            stop_tether,
            tether_status,
            start_monitor,
            stop_monitor,
            monitor_status,
            publish_shot,
            publish_frame,
            find_heal_source,
            picture_profiles,
            get_thumbnail,
            open_look,
            get_look_pixels,
            open_blend,
            get_blend_pixels,
            list_presets,
            save_preset,
            delete_preset
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
