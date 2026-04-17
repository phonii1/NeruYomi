// Prevents a second console window from appearing on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, Manager};

// ═══════════════════════════════════════════════════════════════
// LIBRARY ROOT STATE
// Holds the trusted library root path set by the user so that
// file-system commands can verify callers haven't escaped it.
// ═══════════════════════════════════════════════════════════════

/// Managed state that stores the active library root.
/// Set when the user opens a library; cleared on forget.
struct LibraryRoot(Mutex<Option<PathBuf>>);

/// Returns `true` only when `path` canonicalises to something inside
/// `canonical_root`.  `canonical_root` must already be canonicalized
/// (done once at `set_library_root` time).  Rejects symlinks that escape
/// the tree and any path that can't be resolved at all.
fn is_within_library(path: &std::path::Path, canonical_root: &std::path::Path) -> bool {
    match path.canonicalize() {
        Ok(p) => p.starts_with(canonical_root),
        Err(_) => false,
    }
}

// ═══════════════════════════════════════════════════════════════
// MANGAUPDATES SEARCH
// ═══════════════════════════════════════════════════════════════

#[command]
async fn search_mu(
    client: tauri::State<'_, reqwest::Client>,
    search: String,
    perpage: u32,
) -> Result<Value, String> {
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
async fn fetch_mu_series(
    client: tauri::State<'_, reqwest::Client>,
    series_id: u64,
) -> Result<Value, String> {
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

/// Returns the path to the persisted library-path file.
/// Pure path computation — no I/O. Callers are responsible for creating the
/// directory if needed (always inside `spawn_blocking`).
fn library_path_file(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(data_dir.join("library_path.txt"))
}

#[command]
async fn save_library_path(app: AppHandle, path: String) -> Result<(), String> {
    let file_path = library_path_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        // Ensure the data dir exists before writing (pure I/O — belongs here).
        if let Some(dir) = file_path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        fs::write(file_path, path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
async fn load_library_path(app: AppHandle) -> Result<Option<String>, String> {
    let p = library_path_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        match fs::read_to_string(&p) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Removes the persisted library path so the app starts on the landing screen.
/// Exposed as a Tauri command for future use (e.g. a "forget library" button);
/// not currently called from the JS frontend.
#[command]
async fn clear_library_path(app: AppHandle) -> Result<(), String> {
    let p = library_path_file(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        match fs::remove_file(&p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
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
// LIBRARY ROOT REGISTRATION
// The frontend calls set_library_root once after the user picks
// (or auto-reopens) a library so that subsequent FS commands can
// validate paths against it.
// ═══════════════════════════════════════════════════════════════

#[command]
fn set_library_root(app: AppHandle, path: String) -> Result<(), String> {
    // Canonicalize once here so every subsequent containment check only needs
    // to canonicalize the input path, not the (unchanging) root.
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("cannot canonicalize library root: {e}"))?;
    *app.state::<LibraryRoot>().0.lock()
        .map_err(|e| format!("library-root mutex poisoned: {e}"))? =
        Some(canonical);
    Ok(())
}

#[command]
fn clear_library_root(app: AppHandle) -> Result<(), String> {
    *app.state::<LibraryRoot>().0.lock()
        .map_err(|e| format!("library-root mutex poisoned: {e}"))? = None;
    Ok(())
}

/// Checks that `path` is within the registered library root.
/// Returns Ok(()) if no root is set (browser mode) or path is inside root.
/// Returns Err if path escapes the root.
fn check_library_path(app: &AppHandle, path: &str) -> Result<(), String> {
    let root_opt = app.state::<LibraryRoot>().0.lock()
        .map_err(|e| format!("library-root mutex poisoned: {e}"))?.clone();
    if let Some(root) = root_opt {
        if !is_within_library(std::path::Path::new(path), &root) {
            return Err(format!("path is outside library root: {path}"));
        }
    }
    Ok(())
}



#[derive(Serialize)]
struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[command]
async fn read_dir(app: AppHandle, path: String) -> Result<Vec<FsEntry>, String> {
    check_library_path(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Iteratively sums the sizes of all files under a directory using BFS.
/// Symlinks are skipped to prevent infinite loops. Depth is capped at 32
/// (far deeper than any real manga library) to bound worst-case runtime.
fn dir_size(path: &std::path::Path) -> u64 {
    const MAX_DEPTH: usize = 32;
    let mut total = 0u64;
    let mut queue: std::collections::VecDeque<(std::path::PathBuf, usize)> = std::collections::VecDeque::new();
    queue.push_back((path.to_path_buf(), 0));
    while let Some((current, depth)) = queue.pop_front() {
        if let Ok(entries) = fs::read_dir(&current) {
            for entry in entries.flatten() {
                // file_type() does NOT follow symlinks, so is_symlink() works correctly
                // here. entry.metadata() would follow symlinks and always return false
                // for is_symlink(), leaving the loop vulnerable to symlink cycles.
                let Ok(ft) = entry.file_type() else { continue };
                if ft.is_symlink() { continue; }
                if ft.is_dir() {
                    if depth < MAX_DEPTH { queue.push_back((entry.path(), depth + 1)); }
                } else if ft.is_file() {
                    if let Ok(meta) = entry.metadata() {
                        total += meta.len();
                    }
                }
            }
        }
    }
    total
}

#[command]
async fn get_series_size(app: AppHandle, path: String) -> Result<u64, String> {
    check_library_path(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || Ok(dir_size(std::path::Path::new(&path))))
        .await
        .map_err(|e| e.to_string())?
}

// ═══════════════════════════════════════════════════════════════
// PDF PAGE COUNTER
// Scans the raw PDF bytes for /Count entries without shipping the
// whole file over IPC as base64. The root Pages node always holds
// the largest /Count value, so we take the maximum found.
// ═══════════════════════════════════════════════════════════════

#[command]
async fn count_pdf_pages(app: AppHandle, path: String) -> Result<u32, String> {
    check_library_path(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{BufReader, Read};

        const NEEDLE: &[u8] = b"/Count ";
        // Read 16 KiB at a time — fits comfortably in L1 on most CPUs and keeps
        // peak memory usage constant regardless of PDF size.
        const CHUNK: usize = 16 * 1024;
        // Retain (needle.len() - 1) bytes of overlap between chunks so a /Count
        // token that straddles a chunk boundary is never missed.
        let overlap = NEEDLE.len() - 1;

        let file = fs::File::open(&path).map_err(|e| format!("open({path}): {e}"))?;
        let mut reader = BufReader::new(file);

        // `window` = overlap tail of the previous chunk prepended to the new chunk.
        let mut window: Vec<u8> = Vec::with_capacity(CHUNK + overlap);
        let mut buf = vec![0u8; CHUNK];
        let mut max_count: u32 = 0;

        // Scan `slice` for /Count tokens; updates max_count via the captured reference.
        let mut scan = |slice: &[u8]| {
            let mut i = 0;
            while i + NEEDLE.len() <= slice.len() {
                if slice[i..i + NEEDLE.len()] == *NEEDLE {
                    let start = i + NEEDLE.len();
                    let digit_len = slice[start..]
                        .iter()
                        .take_while(|&&b| b.is_ascii_digit())
                        .count();
                    if digit_len > 0 {
                        if let Ok(s) = std::str::from_utf8(&slice[start..start + digit_len]) {
                            if let Ok(n) = s.parse::<u32>() {
                                if n > max_count { max_count = n; }
                            }
                        }
                        // Skip past the entire parsed token so we don't re-examine
                        // bytes we've already consumed.
                        i += NEEDLE.len() + digit_len;
                        continue;
                    }
                }
                i += 1;
            }
        };

        loop {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            window.extend_from_slice(&buf[..n]);

            // Only scan the part of the window that can't contain a split token.
            let safe_len = window.len().saturating_sub(overlap);
            if safe_len > 0 {
                scan(&window[..safe_len]);
                // Slide: keep only the overlap tail for next iteration.
                window.copy_within(safe_len.., 0);
                window.truncate(window.len() - safe_len);
            }
        }
        // Flush remainder (last chunk has no successor to carry the overlap).
        if !window.is_empty() { scan(&window); }
        // Release the mutable borrow of max_count before returning it.
        drop(scan);

        if max_count > 0 { Ok(max_count) } else { Err("PDF page count not found".into()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ═══════════════════════════════════════════════════════════════
// COVER IMAGE CACHE
// ═══════════════════════════════════════════════════════════════

/// Returns the path to the cover image cache directory.
/// Pure path computation — no I/O. The directory is created on first write
/// inside `cache_cover`'s `spawn_blocking` block.
fn covers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("covers");
    Ok(dir)
}

#[command]
async fn cache_cover(
    app: AppHandle,
    client: tauri::State<'_, reqwest::Client>,
    url: String,
    series_id: String,
) -> Result<String, String> {
    // Fix #4: only fetch HTTPS URLs — rejects file://, ftp://, etc.
    if !url.starts_with("https://") {
        return Err(format!("cover URL must use HTTPS: {url}"));
    }

    // Fix #7: series_id is used directly in a filename; reject anything that
    // isn't a plain numeric string to prevent path-traversal attacks.
    if series_id.is_empty() || !series_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("series_id must be numeric, got: {series_id}"));
    }

    // Strip query string / fragment before extracting the extension so that
    // "cover.jpg?v=2" doesn't produce "jpg?v=2" and fall through to the default.
    let ext = url.split('?').next().unwrap_or("")
        .split('#').next().unwrap_or("")
        .rsplit('.').next().unwrap_or("jpg")
        .to_lowercase();
    let safe_ext = match ext.as_str() {
        "png"  => "png",
        "webp" => "webp",
        "gif"  => "gif",
        _      => "jpg",
    };

    let cache_path = covers_dir(&app)?.join(format!("{}.{}", series_id, safe_ext));

    // Best-effort early exit before downloading. Not TOCTOU-safe on its own —
    // the definitive check happens inside the write closure below.
    let cache_path_clone = cache_path.clone();
    let hit = tauri::async_runtime::spawn_blocking(move || cache_path_clone.exists())
        .await
        .map_err(|e| e.to_string())?;
    if hit {
        return Ok(cache_path.to_string_lossy().into_owned());
    }

    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("cover download failed: {e}"))?;

    // Reject responses that advertise a body larger than 5 MiB before buffering
    // any bytes — prevents OOM if a server sends a huge payload.
    const MAX_COVER_BYTES: u64 = 5 * 1024 * 1024;
    if response.content_length().unwrap_or(0) > MAX_COVER_BYTES {
        return Err(format!("cover image too large (>{} bytes)", MAX_COVER_BYTES));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("cover read failed: {e}"))?;

    // Double-check actual body size in case Content-Length was absent or lying.
    if bytes.len() as u64 > MAX_COVER_BYTES {
        return Err(format!("cover image too large (>{} bytes)", MAX_COVER_BYTES));
    }

    // Fix #10: re-check existence inside the blocking closure so two concurrent
    // requests for the same series don't both write (last-write-wins is harmless
    // but wastes bandwidth; this makes the early winner short-circuit instead).
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(dir) = cache_path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        if cache_path.exists() {
            return Ok(cache_path.to_string_lossy().into_owned());
        }
        fs::write(&cache_path, &bytes).map_err(|e| e.to_string())?;
        Ok(cache_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
async fn delete_cached_cover(app: AppHandle, series_id: String) -> Result<(), String> {
    // Mirror the same guard used in cache_cover — series_id is used directly in
    // a filename, so reject anything that isn't a plain numeric string to prevent
    // path-traversal attacks (e.g. "../../important_file").
    if series_id.is_empty() || !series_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("series_id must be numeric, got: {series_id}"));
    }

    let dir = covers_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        for ext in &["jpg", "png", "webp", "gif"] {
            let p = dir.join(format!("{}.{}", series_id, ext));
            match fs::remove_file(&p) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ═══════════════════════════════════════════════════════════════
// UPDATE CHECKER
// Fetches all releases from GitHub and finds the latest -b tag.
// ═══════════════════════════════════════════════════════════════

/// Opens a folder path in the OS file manager (Explorer / Finder / Nautilus).
/// On Windows uses `explorer` which selects the folder itself.
/// On macOS uses `open` which opens the folder in Finder.
/// Opens a URL in the system's default web browser.
/// Uses platform-native launchers: start (Windows), open (macOS), xdg-open (Linux).
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

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err("open_url is not supported on this platform".into());

    Ok(())
}

/// On Linux uses `xdg-open` which opens the folder in the default file manager.
/// The path must exist and be a directory; anything else is rejected.
#[command]
async fn open_folder_path(path: String) -> Result<(), String> {
    // One metadata() call covers both the existence check and the is_dir check.
    match std::fs::metadata(&path) {
        Err(_) => return Err(format!("Path does not exist: {path}")),
        Ok(m) if !m.is_dir() => return Err(format!("Path is not a directory: {path}")),
        Ok(_) => {}
    }

    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    return Err("open_folder_path is not supported on this platform".into());

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
        .map_err(|e| format!("watcher mutex poisoned: {e}"))?
        .replace(watcher);

    Ok(())
}

/// Stops the library file watcher and drops it.
/// Exposed as a Tauri command for future use (e.g. when the user closes the
/// library without opening another); not currently called from the JS frontend.
#[command]
async fn stop_library_watcher(app: AppHandle) -> Result<(), String> {
    app.state::<WatcherState>()
        .0
        .lock()
        .map_err(|e| format!("watcher mutex poisoned: {e}"))?
        .take(); // drops the watcher, stopping it
    Ok(())
}

// ═══════════════════════════════════════════════════════════════
// FONT MANAGEMENT
// pick_font_file   — native file picker filtered to font formats
// list_system_fonts — scans platform font directories
// cache_font_file  — copies a font into appdata so the asset
//                    protocol can serve it (system font dirs are
//                    outside the $HOME scope)
// ═══════════════════════════════════════════════════════════════

#[command]
async fn pick_font_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};

    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Font files", &["ttf", "otf", "woff", "woff2"])
            .blocking_pick_file()
            .map(|p: FilePath| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct FontEntry {
    name: String,
    path: String,
}

/// Returns the platform-specific directories that typically contain
/// installed fonts.  Directories that don't exist are silently skipped.
fn system_font_dirs(home: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // System-wide fonts
        if let Ok(windir) = std::env::var("WINDIR") {
            dirs.push(std::path::PathBuf::from(&windir).join("Fonts"));
        } else {
            dirs.push(std::path::PathBuf::from(r"C:\Windows\Fonts"));
        }
        // Per-user fonts (Windows 10+)
        dirs.push(home
            .join("AppData")
            .join("Local")
            .join("Microsoft")
            .join("Windows")
            .join("Fonts"));
    }

    #[cfg(target_os = "macos")]
    {
        dirs.push(std::path::PathBuf::from("/Library/Fonts"));
        dirs.push(std::path::PathBuf::from("/System/Library/Fonts"));
        dirs.push(home.join("Library").join("Fonts"));
    }

    #[cfg(target_os = "linux")]
    {
        dirs.push(std::path::PathBuf::from("/usr/share/fonts"));
        dirs.push(std::path::PathBuf::from("/usr/local/share/fonts"));
        dirs.push(home.join(".local").join("share").join("fonts"));
        dirs.push(home.join(".fonts"));
    }

    dirs
}

#[command]
async fn list_system_fonts(app: AppHandle) -> Result<Vec<FontEntry>, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let font_exts = ["ttf", "otf", "woff", "woff2"];

    tauri::async_runtime::spawn_blocking(move || {
        let mut fonts: Vec<FontEntry> = Vec::new();
        let dirs = system_font_dirs(&home);

        for dir in dirs {
            if !dir.exists() { continue; }
            // Iterative BFS walk up to 4 levels deep — handles Linux font hierarchies
            // like /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf (3 levels)
            // without risk of stack overflow or infinite loops via symlinks.
            const MAX_DEPTH: usize = 4;
            let mut queue: std::collections::VecDeque<(std::path::PathBuf, usize)> = std::collections::VecDeque::new();
            queue.push_back((dir.clone(), 0));
            while let Some((current, depth)) = queue.pop_front() {
                if let Ok(entries) = fs::read_dir(&current) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        // Skip symlinks entirely to prevent loops
                        if entry.file_type().map(|t| t.is_symlink()).unwrap_or(false) { continue; }
                        if path.is_dir() {
                            if depth < MAX_DEPTH { queue.push_back((path, depth + 1)); }
                        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                            if font_exts.contains(&ext.to_lowercase().as_str()) {
                                if let Some(name) = path.file_stem().and_then(|n| n.to_str()) {
                                    fonts.push(FontEntry {
                                        name: name.to_string(),
                                        path: path.to_string_lossy().into_owned(),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        // Sort alphabetically and deduplicate by name+path
        fonts.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        fonts.dedup_by(|a, b| a.path == b.path);
        Ok(fonts)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copies a font file into `$APPDATA/neruyomi/fonts/` so it falls
/// within the asset-protocol scope and can be loaded by the WebView.
/// Returns the cached path.  No-ops if the file is already cached.
#[command]
async fn cache_font_file(app: AppHandle, src_path: String) -> Result<String, String> {
    let fonts_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fonts");

    tauri::async_runtime::spawn_blocking(move || {
        let src = std::path::Path::new(&src_path);

        // Only accept known font extensions
        let ext = src.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !["ttf", "otf", "woff", "woff2"].contains(&ext.as_str()) {
            return Err(format!("unsupported font extension: {ext}"));
        }

        // Reject paths that don't resolve to an actual file — catches "..",
        // non-existent paths, and anything the user didn't pick via the native picker.
        let canon = src.canonicalize()
            .map_err(|_| format!("font path could not be resolved: {src_path}"))?;
        if !canon.is_file() {
            return Err(format!("font path is not a file: {src_path}"));
        }

        let file_name = canon.file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| format!("invalid font path: {src_path}"))?;

        fs::create_dir_all(&fonts_dir).map_err(|e| e.to_string())?;

        let dest = fonts_dir.join(file_name);
        if !dest.exists() {
            fs::copy(&canon, &dest).map_err(|e| format!("font copy failed: {e}"))?;
        }
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
async fn pick_image_file(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::{DialogExt, FilePath};

    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Image files", &["jpg", "jpeg", "png", "webp", "gif"])
            .blocking_pick_file()
            .map(|p: FilePath| p.to_string())
    })
    .await
    .map_err(|e| e.to_string())
}

/// Copies a user-chosen image into the covers directory as a custom cover.
/// The destination filename is derived from the series name so it is stable
/// across re-launches and never clashes with MU-fetched covers.
#[command]
async fn cache_custom_cover(app: AppHandle, series_name: String, src_path: String) -> Result<String, String> {
    let dir = covers_dir(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let src = std::path::Path::new(&src_path);
        let ext = src.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg")
            .to_lowercase();
        if !["jpg", "jpeg", "png", "webp", "gif"].contains(&ext.as_str()) {
            return Err(format!("unsupported image extension: {ext}"));
        }

        // Build a safe filename from the series name: keep alphanumerics, split on
        // whitespace, collapse runs, limit length, prefix with "custom_".
        let safe = series_name
            .split_whitespace()
            .map(|word| word.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
            .filter(|w| !w.is_empty())
            .collect::<Vec<_>>()
            .join("_");
        let safe = safe.chars().take(64).collect::<String>();
        let filename = format!("custom_{}.{}", safe, ext);

        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dest = dir.join(&filename);
        fs::copy(src, &dest).map_err(|e| format!("copy failed: {e}"))?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ═══════════════════════════════════════════════════════════════
// DATA FILE STORAGE
// Persists app data as JSON files in $APPDATA/neruyomi/data/
// so it survives app reinstalls and is easily backed up.
// ═══════════════════════════════════════════════════════════════

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("data"))
}

#[command]
async fn read_data_file(app: AppHandle, filename: String) -> Result<Option<String>, String> {
    // Validate filename — no path separators or dots that could escape the data dir
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(format!("invalid filename: {filename}"));
    }
    let path = data_dir(&app)?.join(&filename);
    tauri::async_runtime::spawn_blocking(move || {
        match fs::read_to_string(&path) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
async fn write_data_file(app: AppHandle, filename: String, content: String) -> Result<(), String> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err(format!("invalid filename: {filename}"));
    }
    let dir  = data_dir(&app)?;
    let path = dir.join(&filename);
    tauri::async_runtime::spawn_blocking(move || {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// CBZ SUPPORT
// CBZ files are ZIP archives containing image pages.
// read_cbz_entries — returns a sorted list of image entry paths.
// read_cbz_entry   — decodes one entry and returns it as base64
//                    so the JS side can create a blob URL without
//                    extracting anything to disk.
// ═══════════════════════════════════════════════════════════════

const CBZ_IMG_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp"];

fn is_cbz_image(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    CBZ_IMG_EXTS.contains(&ext.as_str())
}

/// Returns a sorted list of image entry names found inside the CBZ.
/// Entry names preserve any subdirectory prefix so read_cbz_entry can
/// locate them; sorting is by basename only so directory names don't
/// affect chapter order.
#[command]
async fn read_cbz_entries(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    check_library_path(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let file = fs::File::open(&path).map_err(|e| format!("open({path}): {e}"))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("zip error: {e}"))?;
        let mut names: Vec<String> = (0..zip.len())
            .filter_map(|i| {
                let entry = zip.by_index(i).ok()?;
                if entry.is_file() && is_cbz_image(entry.name()) {
                    Some(entry.name().to_string())
                } else {
                    None
                }
            })
            .collect();
        // Sort by basename so subdirectory prefixes don't affect page order
        names.sort_by(|a, b| {
            let ba = a.rsplit('/').next().unwrap_or(a);
            let bb = b.rsplit('/').next().unwrap_or(b);
            ba.cmp(bb)
        });
        Ok(names)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reads a single entry from the CBZ and returns its raw bytes as a
/// base64 string. The JS side converts this to a blob URL — no temp
/// files are written to disk.
#[command]
async fn read_cbz_entry(
    app: AppHandle,
    path: String,
    name: String,
) -> Result<String, String> {
    check_library_path(&app, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        use base64::{Engine as _, engine::general_purpose};
        let file = fs::File::open(&path).map_err(|e| format!("open({path}): {e}"))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("zip error: {e}"))?;
        let mut entry = zip.by_name(&name).map_err(|e| format!("entry '{name}': {e}"))?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main() {
    // Build one shared HTTP client for the entire app lifetime.
    // reqwest::Client internally manages a connection pool — rebuilding it on
    // every command call throws away keep-alive connections and adds latency.
    // The 15-second timeout prevents hung API calls from blocking tasks forever.
    let http_client = reqwest::Client::builder()
        .user_agent(concat!("NeruYomi/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("failed to build shared HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(WatcherState(Mutex::new(None)))
        .manage(LibraryRoot(Mutex::new(None)))
        .manage(http_client)
        // ── Auto-open DevTools in debug builds (tauri dev) ───────────
        // In release builds DevTools are toggled via F12 / Ctrl+Shift+I.
        .setup(|app| {
            #[cfg(debug_assertions)]
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // MangaUpdates
            search_mu,
            fetch_mu_series,
            // Library persistence
            save_library_path,
            load_library_path,
            clear_library_path,
            // Library root registration (used for FS path containment checks)
            set_library_root,
            clear_library_root,
            // Native file system
            pick_folder,
            read_dir,
            count_pdf_pages,
            read_cbz_entries,
            read_cbz_entry,
            get_series_size,
            // Cover image cache
            cache_cover,
            delete_cached_cover,
            pick_image_file,
            cache_custom_cover,
            // Font management
            pick_font_file,
            list_system_fonts,
            cache_font_file,
            // Data file storage
            read_data_file,
            write_data_file,
            // Shell
            open_url,
            open_folder_path,
            // Library watcher
            start_library_watcher,
            stop_library_watcher,
        ])
        .run(tauri::generate_context!())
        .expect("error while running NeruYomi");
}
