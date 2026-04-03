// Prevents a second console window from appearing on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, Manager};

// ═══════════════════════════════════════════════════════════════
// MANGAUPDATES SEARCH
// ═══════════════════════════════════════════════════════════════

#[derive(Serialize, Deserialize)]
struct MuSearchRequest {
    search: String,
    perpage: u32,
}

#[command]
async fn search_mu(search: String, perpage: u32) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("NeruYomi/0.48.3B")
        .build()
        .map_err(|e| e.to_string())?;

    let body = serde_json::json!({ "search": search, "perpage": perpage });

    let response = client
        .post("https://api.mangaupdates.com/v1/series/search")
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("MU request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("MU API returned {}", response.status()));
    }

    response
        .json::<Value>()
        .await
        .map_err(|e| format!("MU response parse failed: {e}"))
}

// ═══════════════════════════════════════════════════════════════
// MANGAUPDATES SERIES LOOKUP
// Fetches the full series record by ID — the search endpoint
// returns a slim result that omits authors and pub_status.
// ═══════════════════════════════════════════════════════════════

#[command]
async fn fetch_mu_series(series_id: u64) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("NeruYomi/0.48.3B")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(format!("https://api.mangaupdates.com/v1/series/{}", series_id))
        .send()
        .await
        .map_err(|e| format!("MU series request failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("MU API returned {}", response.status()));
    }

    response
        .json::<Value>()
        .await
        .map_err(|e| format!("MU series parse failed: {e}"))
}

// ═══════════════════════════════════════════════════════════════
// LIBRARY PATH PERSISTENCE
// ═══════════════════════════════════════════════════════════════

fn library_path_file(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    Ok(data_dir.join("library_path.txt"))
}

#[command]
async fn save_library_path(app: AppHandle, path: String) -> Result<(), String> {
    fs::write(library_path_file(&app)?, path).map_err(|e| e.to_string())
}

#[command]
async fn load_library_path(app: AppHandle) -> Result<Option<String>, String> {
    let p = library_path_file(&app)?;
    if p.exists() {
        Ok(Some(fs::read_to_string(p).map_err(|e| e.to_string())?))
    } else {
        Ok(None)
    }
}

#[command]
async fn clear_library_path(app: AppHandle) -> Result<(), String> {
    let p = library_path_file(&app)?;
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
// NATIVE FOLDER PICKER
// ═══════════════════════════════════════════════════════════════

#[command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // blocking_pick_folder must not run on the async executor thread —
    // move it to the blocking thread pool so the runtime stays responsive.
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .map(|p| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

// ═══════════════════════════════════════════════════════════════
// NATIVE FILE SYSTEM
// ═══════════════════════════════════════════════════════════════

#[derive(Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[command]
async fn read_dir(path: String) -> Result<Vec<FsEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("read_dir({path}): {e}"))?;
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        result.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    Ok(result)
}

/// Recursively sums the sizes of all files under a directory.
fn dir_size(path: &std::path::Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    total += dir_size(&entry.path());
                } else {
                    total += meta.len();
                }
            }
        }
    }
    total
}

#[command]
async fn get_series_size(path: String) -> Result<u64, String> {
    Ok(dir_size(std::path::Path::new(&path)))
}

#[command]
async fn read_file_as_data_url(path: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let bytes = fs::read(&path).map_err(|e| format!("read_file({path}): {e}"))?;

    let mime = match path.rsplit('.').next().unwrap_or("").to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png"          => "image/png",
        "webp"         => "image/webp",
        "gif"          => "image/gif",
        "avif"         => "image/avif",
        "pdf"          => "application/pdf",
        _              => "application/octet-stream",
    };

    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}

// ═══════════════════════════════════════════════════════════════
// PDF PAGE COUNTER
// Scans the raw PDF bytes for /Count entries without shipping the
// whole file over IPC as base64. The root Pages node always holds
// the largest /Count value, so we take the maximum found.
// ═══════════════════════════════════════════════════════════════

#[command]
async fn count_pdf_pages(path: String) -> Result<u32, String> {
    let bytes = fs::read(&path).map_err(|e| format!("read({path}): {e}"))?;
    let needle = b"/Count ";
    let mut max_count: u32 = 0;
    let mut i = 0;
    while i + needle.len() < bytes.len() {
        if bytes[i..i + needle.len()] == *needle {
            let digits: Vec<u8> = bytes[i + needle.len()..]
                .iter()
                .take_while(|&&b| b.is_ascii_digit())
                .copied()
                .collect();
            if let Ok(s) = std::str::from_utf8(&digits) {
                if let Ok(n) = s.parse::<u32>() {
                    if n > max_count {
                        max_count = n;
                    }
                }
            }
        }
        i += 1;
    }
    if max_count > 0 {
        Ok(max_count)
    } else {
        Err("PDF page count not found".into())
    }
}

// ═══════════════════════════════════════════════════════════════
// COVER IMAGE CACHE
// ═══════════════════════════════════════════════════════════════

fn covers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("covers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[command]
async fn cache_cover(
    app: AppHandle,
    url: String,
    series_id: String,
) -> Result<String, String> {
    let ext = url.rsplit('.').next().unwrap_or("jpg").to_lowercase();
    let safe_ext = match ext.as_str() {
        "png"  => "png",
        "webp" => "webp",
        "gif"  => "gif",
        _      => "jpg",
    };

    let cache_path = covers_dir(&app)?.join(format!("{}.{}", series_id, safe_ext));

    // Cache hit — return the path directly, no need to read the file at all.
    if cache_path.exists() {
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let client = reqwest::Client::builder()
        .user_agent("NeruYomi/0.48.3B")
        .build()
        .map_err(|e| e.to_string())?;

    let bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("cover download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("cover read failed: {e}"))?;

    fs::write(&cache_path, &bytes).map_err(|e| e.to_string())?;

    Ok(cache_path.to_string_lossy().into_owned())
}

#[command]
async fn delete_cached_cover(app: AppHandle, series_id: String) -> Result<(), String> {
    let dir = covers_dir(&app)?;
    for ext in &["jpg", "png", "webp", "gif"] {
        let p = dir.join(format!("{}.{}", series_id, ext));
        if p.exists() {
            fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
// UPDATE CHECKER
// Fetches all releases from GitHub and finds the latest -b tag.
// ═══════════════════════════════════════════════════════════════

/// Returns the running app version directly from the Cargo manifest.
/// CARGO_PKG_VERSION is set at compile time, so it always matches
/// Cargo.toml without needing the tauri-plugin-app.
#[command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Parses a "X.Y.Z" version string into a comparable (major, minor, patch) tuple.
/// Returns None if the string isn't a valid three-part version.
fn parse_ver(s: &str) -> Option<(u32, u32, u32)> {
    let mut parts = s.trim().splitn(3, '.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    let patch = parts.next()?.parse::<u32>().ok()?;
    Some((major, minor, patch))
}

#[command]
async fn check_for_updates(current_version: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("NeruYomi")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get("https://api.github.com/repos/phonii1/NeruYomi/releases")
        .send()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("GitHub API returned {}", response.status()));
    }

    let releases: serde_json::Value = response
        .json()
        .await
        .map_err(|e| e.to_string())?;

    // Find the latest non-draft tag ending in "-b" (pre-releases included —
    // full 1.0 release is the first non-pre-release build)
    let latest = releases
        .as_array()
        .and_then(|arr| {
            arr.iter().find(|r| {
                r["tag_name"].as_str().unwrap_or("").ends_with("-b")
                    && !r["draft"].as_bool().unwrap_or(false)
            })
        });

    let Some(release) = latest else {
        return Ok(serde_json::json!({
            "hasUpdate":      false,
            "latestVersion":  current_version,
            "currentVersion": current_version,
            "releaseUrl":     "",
            "releaseNotes":   "",
        }));
    };

    let tag         = release["tag_name"].as_str().unwrap_or("");
    let latest_ver  = tag.trim_start_matches('v').trim_end_matches("-b");
    let current_ver = current_version.trim_start_matches('v').trim_end_matches("-b");

    // Compare as (major, minor, patch) tuples so "0.10.0" > "0.9.0" correctly.
    // Fall back to inequality check if either string doesn't parse.
    let has_update = match (parse_ver(latest_ver), parse_ver(current_ver)) {
        (Some(l), Some(c)) => l > c,
        _ => !latest_ver.is_empty() && latest_ver != current_ver,
    };

    Ok(serde_json::json!({
        "hasUpdate":      has_update,
        "latestVersion":  latest_ver,
        "currentVersion": current_ver,
        "releaseUrl":     release["html_url"].as_str().unwrap_or(""),
        "releaseNotes":   release["body"].as_str().unwrap_or(""),
    }))
}

/// Opens a URL in the user's default system browser.
#[command]
async fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &url])
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
}

// ═══════════════════════════════════════════════════════════════
// LIBRARY FILE WATCHER
// Watches the library root folder for new subdirectories.
// When a new series folder appears (e.g. downloaded by HakuNeko
// or copied in manually), emits "library-changed" to the JS
// frontend so it can refresh automatically — no manual reload.
// ═══════════════════════════════════════════════════════════════

/// Holds the watcher so it isn't dropped (which would stop watching).
struct WatcherState(Mutex<Option<notify::RecommendedWatcher>>);

#[command]
async fn start_library_watcher(app: AppHandle, path: String) -> Result<(), String> {
    use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
    use std::time::Duration;

    let app_clone = app.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                // Only care about new folders being created
                let is_create = matches!(event.kind, EventKind::Create(_));
                if is_create {
                    let has_new_dir = event.paths.iter().any(|p: &std::path::PathBuf| p.is_dir());
                    if has_new_dir {
                        // Emit to JS — debounce happens on the JS side
                        let _ = app_clone.emit("library-changed", ());
                    }
                }
            }
        },
        Config::default().with_poll_interval(Duration::from_secs(2)),
    )
    .map_err(|e| format!("watcher init failed: {e}"))?;

    watcher
        .watch(std::path::Path::new(&path), RecursiveMode::NonRecursive)
        .map_err(|e| format!("watcher start failed: {e}"))?;

    // Store in app state so it isn't dropped
    app.state::<WatcherState>()
        .0
        .lock()
        .unwrap()
        .replace(watcher);

    Ok(())
}

#[command]
async fn stop_library_watcher(app: AppHandle) -> Result<(), String> {
    app.state::<WatcherState>()
        .0
        .lock()
        .unwrap()
        .take(); // drops the watcher, stopping it
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(WatcherState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            // MangaUpdates
            search_mu,
            fetch_mu_series,
            // Library persistence
            save_library_path,
            load_library_path,
            clear_library_path,
            // Native file system
            pick_folder,
            read_dir,
            read_file_as_data_url,
            count_pdf_pages,
            get_series_size,
            // Cover image cache
            cache_cover,
            delete_cached_cover,
            // Updates
            get_app_version,
            check_for_updates,
            open_url,
            // Library watcher
            start_library_watcher,
            stop_library_watcher,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NeruYomi");
}
