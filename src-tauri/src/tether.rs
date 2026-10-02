//! Tethered capture via a hot folder.
//!
//! Canon EOS Utility, Sony Imaging Edge Desktop and most camera Wi‑Fi/FTP
//! transfer modes all end the same way: a new file appears in a folder on this
//! machine. Darkroom watches that folder and announces each finished file to
//! the UI, which opens it. Watching the folder (rather than talking USB/PTP to
//! the camera directly) keeps every vendor's USB *and* Wi‑Fi path working
//! without their SDKs.

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Emitted to the webview for every new image once it has finished writing.
pub const EVENT_FILE: &str = "tether://file";

/// How long a file's size must stay unchanged before we treat it as complete.
const SETTLE_STABLE: Duration = Duration::from_millis(900);
const SETTLE_POLL: Duration = Duration::from_millis(300);
/// Give up on a file that never stops growing (a stalled transfer).
const SETTLE_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct TetherStatus {
    pub active: bool,
    pub folder: String,
    /// images announced since the watch started
    pub count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TetherFile {
    pub path: String,
    pub count: usize,
}

struct Shared {
    alive: AtomicBool,
    count: AtomicUsize,
    seen: Mutex<HashSet<PathBuf>>,
}

/// A running watch. Dropping it stops the watcher and any settle threads.
pub struct Active {
    _watcher: RecommendedWatcher,
    folder: String,
    shared: Arc<Shared>,
}

impl Drop for Active {
    fn drop(&mut self) {
        self.shared.alive.store(false, Ordering::SeqCst);
    }
}

impl Active {
    pub fn status(&self) -> TetherStatus {
        TetherStatus {
            active: true,
            folder: self.folder.clone(),
            count: self.shared.count.load(Ordering::SeqCst),
        }
    }
}

fn is_candidate(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    let ext = ext.as_str();
    if !(crate::decode::RAW_EXTENSIONS.contains(&ext) || crate::decode::IMAGE_EXTENSIONS.contains(&ext)) {
        return false;
    }
    // Ignore dot files and the hidden partial files some transfer tools write.
    !path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.starts_with('.') || n.starts_with("~$"))
        .unwrap_or(true)
}

pub fn start(app: tauri::AppHandle, folder: String) -> anyhow::Result<Active> {
    let dir = PathBuf::from(&folder);
    anyhow::ensure!(dir.is_dir(), "{folder} is not a folder");
    let shared = Arc::new(Shared {
        alive: AtomicBool::new(true),
        count: AtomicUsize::new(0),
        seen: Mutex::new(HashSet::new()),
    });
    let sh = shared.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // Creates, data writes and renames (temp file -> final name) all count.
        // Removals never do.
        if matches!(event.kind, EventKind::Remove(_) | EventKind::Access(_)) {
            return;
        }
        for path in event.paths {
            if !is_candidate(&path) || !path.is_file() {
                continue;
            }
            if !sh.seen.lock().unwrap().insert(path.clone()) {
                continue;
            }
            let app = app.clone();
            let sh = sh.clone();
            std::thread::spawn(move || settle_and_announce(app, sh, path));
        }
    })?;
    watcher.watch(&dir, RecursiveMode::NonRecursive)?;
    log::info!("tether: watching {folder}");
    Ok(Active {
        _watcher: watcher,
        folder,
        shared,
    })
}

/// Wait until the camera software has finished writing the file, then tell
/// the UI. A file that disappears (renamed away, deleted) is forgotten so the
/// final name can be announced instead.
fn settle_and_announce(app: tauri::AppHandle, sh: Arc<Shared>, path: PathBuf) {
    let start = Instant::now();
    let mut last_len = u64::MAX;
    let mut stable_since = Instant::now();
    loop {
        if !sh.alive.load(Ordering::SeqCst) {
            return;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            sh.seen.lock().unwrap().remove(&path);
            return;
        };
        let len = meta.len();
        if len != last_len {
            last_len = len;
            stable_since = Instant::now();
        } else if len > 0 && stable_since.elapsed() >= SETTLE_STABLE {
            // Writers that hold an exclusive lock make open() fail until done.
            if std::fs::File::open(&path).is_ok() {
                break;
            }
        }
        if start.elapsed() > SETTLE_TIMEOUT {
            log::warn!("tether: {} never finished writing", path.display());
            return;
        }
        std::thread::sleep(SETTLE_POLL);
    }
    let count = sh.count.fetch_add(1, Ordering::SeqCst) + 1;
    log::info!("tether: new shot {} ({count})", path.display());
    let _ = app.emit(
        EVENT_FILE,
        TetherFile {
            path: path.to_string_lossy().into_owned(),
            count,
        },
    );
}
