# NeruYomi

**ねるよみ** — A local manga reader built with Tauri and vanilla JavaScript.

NeruYomi runs as a desktop application on Windows, macOS, and Linux. It reads manga directly from your local filesystem with no cloud sync, no accounts, and no network requirement for reading. MangaUpdates integration is optional and used only to fetch cover images and series metadata.

---

## Disclaimer

NeruYomi was developed with significant assistance from Claude, an AI assistant made by Anthropic. The majority of the codebase — architecture decisions, feature implementation, bug fixes, and iterative improvements — was written collaboratively through Claude. The project would not exist in its current form without that assistance.

---

## Requirements

- [Node.js](https://nodejs.org/) 18 or later
- [Rust](https://rustup.rs/) stable toolchain
- [Tauri CLI](https://tauri.app/start/prerequisites/) v2

---

## Getting Started

```bash
npm install
npm run tauri dev
```

To build a release binary:

```bash
npm run tauri build
```

### Version bumping

The version is defined once in `src-tauri/Cargo.toml`. After changing it there, run the bump script to propagate it to the frontend files:

```bash
node scripts/bump-version.js
```

This patches `src/update.js` and `index.html` automatically. The `b` display suffix in the title is preserved.

Also update `package.json` manually — Tauri reads `Cargo.toml` for the binary version, but `npm run dev` reads `package.json` for the console output.

---

## Folder Structure

NeruYomi expects your library to be organised as follows.

For image-based chapters:

```
LIBRARY/
  Series Name/
    Chapter 001/
      001.jpg
      002.jpg
    Chapter 002/
```

For PDF chapters:

```
LIBRARY/
  Series Name/
    Chapter 001.pdf
    Chapter 002.pdf
```

Chapter folders and filenames are sorted using natural ordering, so `Chapter 2` sorts before `Chapter 10` correctly. Volume and chapter numbers are parsed from folder names in formats such as `Vol.02 Ch.006`, `Chapter 001`, `Ch.6.5 - Title`, and plain numeric names.

---

## Features

### Library

- Opens a local folder as a library. In the Tauri desktop app, the last-used library path is restored automatically on launch.
- File system watcher detects new series folders added by external downloaders (such as HakuNeko) and refreshes the grid automatically after a short debounce.
- Library grid supports three density presets: compact, normal, and comfortable.
- Search filters the grid live as you type, with a cover preview row appearing below the search bar.
- Genre filter dropdown populated from MangaUpdates metadata, allowing multi-genre filtering.
- Sort options: A to Z, Z to A, folder size ascending/descending, volume count ascending/descending, chapter count ascending/descending. Sort preference is persisted between sessions.
- Bookmarks tab shows only bookmarked series.
- Multi-select mode for bulk operations. Enter it via the SELECT button in the toolbar, tap series to toggle selection, then move selected series to a `_trash` subfolder within the library root. The trash folder is excluded from the library grid and can be opened in the system file explorer for manual deletion. Nothing is permanently deleted by the app.
- Rescan button rescans the library folder for new or removed series and chapters. When used from a series info page, it also force-refreshes MangaUpdates metadata for that series.

### Series Info

- Hero panel with blurred cover background, title, chapter count, publication year, rating, and publication status (when available from MangaUpdates).
- Author, description, and genre tags sourced from MangaUpdates.
- Continue button resumes reading from the last read page or starts from the beginning.
- Reading progress bar showing chapters read out of total.
- Chapter list with volume grouping, read/unread state, and ascending/descending sort toggle.
- Custom cover image support via the context menu on each series card.
- Series identification override for when the automatic MangaUpdates match is wrong.

### Reader

- Single page, spread (two-page), and long strip (webtoon) layout modes.
- Long strip mode is auto-detected from image aspect ratios and applied per-chapter without changing the saved layout preference.
- RTL and LTR reading direction.
- Zoom and pan with mouse wheel, pinch, or keyboard shortcuts (`+`, `-`, `0`).
- Drag to pan when zoomed in.
- Theatre mode (double-click or double-tap the center zone) hides the header and reader bar.
- Header auto-hides after 2.5 seconds of inactivity during reading.
- Swipe gestures for page navigation on touch devices.
- Mouse back/forward buttons (buttons 3 and 4) navigate back through the view stack.
- Chapter boundary navigation: reaching the first or last page of a chapter offers to jump to the adjacent chapter.
- Reading progress is saved per-chapter and per-page and restored on re-open.

**Keyboard shortcuts (reader)**

| Key | Action |
|-----|--------|
| Arrow Right / Arrow Down | Next page (LTR) |
| Arrow Left / Arrow Up | Previous page (LTR) |
| `+` or `=` | Zoom in |
| `-` | Zoom out |
| `0` | Reset zoom and pan |

### MangaUpdates Integration

- Searches MangaUpdates by series folder name and fetches cover image, description, genres, authors, rating, publication year, and publication status.
- Results are cached locally in `mu_cache.json` with a 30-day TTL so metadata loads instantly without network access after the first fetch.
- All API requests are serialised through a global throttle (500ms minimum gap) to avoid rate limiting.
- Series with incorrect automatic matches can be manually identified via the context menu.
- Title overrides per series are stored in `mu_overrides.json`.
- Cache can be refreshed or cleared from the Settings panel.

### Themes and Appearance

Six built-in themes: Default Dark, Default Light, Arctic, Paper, Mist, and Lilac. A custom theme editor allows defining accent, ink, and paper colours with adjustable depth, contrast, and step parameters. Custom themes are saved and persist between sessions. Per-theme font overrides are supported.

### Updates

- Silent update check on launch. If an update is available, a banner appears at the top of the window.
- Manual check available from the Settings panel.
- In-app download and install when a platform-specific installer is found in the release assets. Falls back to a Download link pointing to the releases page if no installer is available for the current platform.
- Version is read from the Tauri backend at runtime so the displayed version always matches the compiled binary.

---

## Data Storage

In the Tauri desktop app, all persistent data is stored as JSON files in the app data directory:

| File | Contents |
|------|----------|
| `settings.json` | Layout, direction, theme, density, library path, sort preference |
| `bookmarks.json` | Bookmarked series keys |
| `progress.json` | Per-chapter reading progress |
| `mu_cache.json` | Cached MangaUpdates metadata |
| `mu_overrides.json` | Manual series identification overrides |
| `cover_index.json` | Cached cover file paths |
| `custom_themes.json` | User-created custom themes |
| `theme_fonts.json` | Per-theme font overrides |

Legacy localStorage data from earlier versions is migrated to files automatically on first launch.

In browser mode (development), all data falls back to localStorage.

---

## Changelog

### v0.49.0

**Library**
- Added library sort options: A to Z, Z to A, folder size, volume count, chapter count. Persisted between sessions.
- Added multi-select mode with bulk move-to-trash functionality. The `_trash` folder is created inside the library root, excluded from the grid, and can be opened from the action bar.
- Rescan from a series info page now also refreshes MangaUpdates metadata for that series.

**Series Info**
- Publication status (Ongoing, Completed, Hiatus, Cancelled) now shown inline in the stat row when available from MangaUpdates.
- Hero panel readability improvements: tint overlay opacity increased, description text contrast raised, genre pill contrast improved, MangaUpdates/Open Folder button spacing increased.
- Fixed the Settings panel updates section incorrectly highlighting on hover.

**MangaUpdates**
- Global API throttle (500ms) applied to all MU requests to prevent 429 rate-limit errors when opening multiple series quickly.
- Fixed a cache eviction bug that was discarding cached metadata on every launch for series where MangaUpdates returned no publication status, causing unnecessary re-fetches.

**Reader**
- Long strip mode now uses an IntersectionObserver to defer image loading to a rolling 5-page buffer rather than decoding the entire chapter upfront.
- Paged mode preload expanded: 4 pages ahead and 2 pages behind in both single and spread layouts.
- PDF render height reduced from 1400px to 1200px per page, reducing per-page memory usage by approximately 26%.
- PDF sliding window: rendered PDF page bitmaps are evicted from memory when more than 2 pages away from the current position, keeping a maximum of 5 decoded PDF pages in memory at once.
- `pdfDoc.destroy()` is now called when leaving a PDF chapter, releasing PDF.js document memory immediately rather than waiting for garbage collection.

**Update system**
- Rewrote update checker to use a custom Rust backend. The update banner now always shows a Download fallback link regardless of whether an in-app installer is available.
- Manual check now correctly distinguishes between no update available and a failed network check.
- Check failed state flashes for 1 second then reverts to the current version label.

**Memory**
- Fixed `_muThrottle` promise chain accumulation: the chain resets when the queue drains so it does not grow unbounded over a session.
- Fixed stale async closures in `loadCoverTauri` and `loadSeriesSize`: both now bail out if the library was replaced while their async operations were in flight.
- IntersectionObserver in strip mode is now properly disconnected on navigation.

---

## Browser Support

| Environment | Support |
|-------------|---------|
| Tauri (desktop) | Full — recommended |
| Chrome / Edge | Full via File System Access API |
| Firefox / Safari | Partial via `webkitdirectory` fallback — no persistent library path, no cover caching |

---

## License

See `LICENSE` for details.
