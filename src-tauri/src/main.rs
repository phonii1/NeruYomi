// Prevents a second console window from appearing on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use tauri::{command, AppHandle, Manager};

// ═══════════════════════════════════════════════════════════════
// MANGAUPDATES SEARCH
// Two JS call sites: fetchMuInfo() and runIdentifySearch()
// Both POST to /v1/series/search with { search, perpage }
// ═══════════════════════════════════════════════════════════════

#[derive(Serialize, Deserialize)]
struct MuSearchRequest {
    search: String,
    perpage: u32,
}

/// Searches MangaUpdates directly — no proxy needed, Rust bypasses CORS.
/// Returns the raw JSON from the MU API so the existing JS parsing is untouched.
#[command]
async fn search_mu(search: String, perpage: u32) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent("NeruYomi/0.48B")
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
// LIBRARY PATH PERSISTENCE
// Saves the folder path to the OS app-data directory so the
// library reopens automatically on the next launch — no permission
// dance, no IndexedDB, no "Re-open folder?" banner.
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
// Replaces window.showDirectoryPicker() — returns the chosen
// folder path as a string. Tauri saves and can reopen it without
// asking for permission again.
// ═══════════════════════════════════════════════════════════════

#[command]
async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // blocking_send() is fine here — this runs off the main thread
    let path = app
        .dialog()
        .file()
        .blocking_pick_folder();

    Ok(path.map(|p| p.to_string()))
}

// ═══════════════════════════════════════════════════════════════
// NATIVE FILE SYSTEM — read directory & file contents
// Replaces the File System Access API handles. The JS sends a
// path string; Rust reads the actual filesystem and returns data.
// ═══════════════════════════════════════════════════════════════

#[derive(Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Lists immediate children of a directory path.
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

/// Reads a file and returns it as a base64-encoded data URL.
/// Used for cover images and PDF pages — the JS can set img.src directly.
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
// COVER IMAGE CACHE
// Downloads MU cover images to app-data/covers/ on first fetch.
// Returns a base64 data URL so the WebView never hits the network
// again for the same cover. Survives app restarts indefinitely.
// The identify override calls delete_cached_cover to force a
// fresh download when the user switches to a different series.
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

/// Downloads a cover image and caches it to disk.
/// On subsequent calls for the same series_id the cached file is
/// returned immediately without any network request.
#[command]
async fn cache_cover(
    app: AppHandle,
    url: String,
    series_id: String,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};

    let ext = url.rsplit('.').next().unwrap_or("jpg").to_lowercase();
    let safe_ext = match ext.as_str() {
        "png" => "png",
        "webp" => "webp",
        "gif" => "gif",
        _ => "jpg",
    };

    let cache_path = covers_dir(&app)?.join(format!("{}.{}", series_id, safe_ext));

    // Return cached version if it already exists on disk
    if cache_path.exists() {
        let bytes = fs::read(&cache_path).map_err(|e| e.to_string())?;
        let mime = mime_for_ext(safe_ext);
        return Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)));
    }

    // Download from MU CDN
    let client = reqwest::Client::builder()
        .user_agent("NeruYomi/0.48B")
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

    // Write to disk
    fs::write(&cache_path, &bytes).map_err(|e| e.to_string())?;

    let mime = mime_for_ext(safe_ext);
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(&bytes)))
}

/// Deletes a cached cover so it will be re-downloaded on next open.
/// Called by the identify override when the user picks a different series.
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

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png"  => "image/png",
        "webp" => "image/webp",
        "gif"  => "image/gif",
        _      => "image/jpeg",
    }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            // MangaUpdates
            search_mu,
            // Library persistence
            save_library_path,
            load_library_path,
            clear_library_path,
            // Native file system
            pick_folder,
            read_dir,
            read_file_as_data_url,
            // Cover image cache
            cache_cover,
            delete_cached_cover,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NeruYomi");
}
