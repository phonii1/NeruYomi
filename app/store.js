// ═══════════════════════════════════════════════════════════════
// STORE
// Data persistence layer — file-backed in Tauri, localStorage
// fallback in browser. All app data lives in one place.
//
// Depends on: IS_TAURI, invoke (utils.js)
// ═══════════════════════════════════════════════════════════════

// ── MangaUpdates API shims ────────────────────────────────────────────────────
// These live here rather than in mu.js because store.js is loaded before mu.js,
// and the browser dev-mode fallbacks need to be available early.

async function muSearch(search, perpage = 5) {
  if (IS_TAURI) {
    return invoke('search_mu', { search, perpage });
  }
  // Browser dev mode only — requires a local proxy server on port 3005
  const res = await fetch(`http://127.0.0.1:3005/mu/series/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ search, perpage }),
  });
  if (!res.ok) throw new Error(`MU search failed: ${res.status}`);
  return res.json();
}

/** Fetches the full series record by ID — the search endpoint omits authors and pub_status. */
async function muFetchSeries(seriesId) {
  if (IS_TAURI) {
    return invoke('fetch_mu_series', { seriesId });
  }
  // Browser dev mode only — requires a local proxy server on port 3005
  const res = await fetch(`http://127.0.0.1:3005/mu/series/${seriesId}`);
  if (!res.ok) throw new Error(`MU series fetch failed: ${res.status}`);
  return res.json();
}

// ── File list & migration map ─────────────────────────────────────────────────

const DATA_FILES = [
  'settings.json', 'bookmarks.json', 'progress.json',
  'mu_overrides.json', 'mu_cache.json', 'custom_themes.json', 'theme_fonts.json',
  'cover_index.json',
];

// Migration map: old localStorage key → new data file
const LS_MIGRATION = {
  'ny_bookmarks':     'bookmarks.json',
  'ny_progress':      'progress.json',
  'ny_mu_overrides':  'mu_overrides.json',
  'ny_mu_cache':      'mu_cache.json',
  'ny_custom_themes': 'custom_themes.json',
  'ny_theme_fonts':   'theme_fonts.json',
};
// Reverse map: data file → localStorage key (built once for O(1) lookups in saveData)
const LS_MIGRATION_REVERSE = Object.fromEntries(
  Object.entries(LS_MIGRATION).map(([k, v]) => [v, k])
);

// ── In-memory store ───────────────────────────────────────────────────────────

let _store = {}; // filename → parsed object/array

/** Saves data to the in-memory store and asynchronously writes to disk. */
function saveData(filename, data) {
  _store[filename] = data;
  if (IS_TAURI) {
    invoke('write_data_file', { filename, content: JSON.stringify(data) })
      .catch(e => console.error('[store] write failed:', filename, e));
  } else {
    // Browser fallback — map filenames back to legacy localStorage keys
    const lsKey = LS_MIGRATION_REVERSE[filename] || filename.replace('.json', '');
    try { localStorage.setItem(lsKey, JSON.stringify(data)); } catch(e) {}
  }
}

/** Returns the stored value for a file, defaulting to an empty object. */
function getData(filename, defaultVal = {}) {
  return _store[filename] ?? defaultVal;
}

/**
 * Loads all data files at startup. In Tauri: reads from disk, migrating any
 * legacy localStorage data to files on first run. In browser: reads localStorage.
 * Must be awaited before initSettings() runs.
 */
async function loadAllData() {
  if (!IS_TAURI) {
    // Browser: load from localStorage
    for (const [lsKey, filename] of Object.entries(LS_MIGRATION)) {
      try { _store[filename] = JSON.parse(localStorage.getItem(lsKey) || '{}'); }
      catch(e) { _store[filename] = {}; }
    }
    // Settings as a synthetic object
    _store['settings.json'] = {
      direction: localStorage.getItem('pref_direction') || 'rtl',
      layout:    localStorage.getItem('pref_layout')    || 'single',
      theme:     localStorage.getItem('pref_theme')     || 'default',
      density:   localStorage.getItem('pref_density')   || 'normal',
    };
    return;
  }

  // Tauri: read all data files in parallel
  const reads = await Promise.allSettled(
    DATA_FILES.map(f => invoke('read_data_file', { filename: f }).then(raw => ({ f, raw })))
  );
  for (const r of reads) {
    if (r.status === 'fulfilled') {
      const { f, raw } = r.value;
      try { _store[f] = raw ? JSON.parse(raw) : null; }
      catch(e) { _store[f] = null; }
    }
  }

  // Migrate from localStorage on first run (any file missing from disk)
  let migrated = false;
  for (const [lsKey, filename] of Object.entries(LS_MIGRATION)) {
    if (_store[filename] == null) {
      const raw = localStorage.getItem(lsKey);
      if (raw) {
        try {
          _store[filename] = JSON.parse(raw);
          await invoke('write_data_file', { filename, content: raw });
          localStorage.removeItem(lsKey);
          migrated = true;
        } catch(e) {}
      }
      if (_store[filename] == null) _store[filename] = {};
    }
  }

  // Settings: stored as a single object in settings.json
  if (_store['settings.json'] == null) {
    // Migrate from individual pref_* keys
    _store['settings.json'] = {
      direction: localStorage.getItem('pref_direction') || 'rtl',
      layout:    localStorage.getItem('pref_layout')    || 'single',
      theme:     localStorage.getItem('pref_theme')     || 'default',
      density:   localStorage.getItem('pref_density')   || 'normal',
    };
    await invoke('write_data_file', {
      filename: 'settings.json',
      content: JSON.stringify(_store['settings.json']),
    }).catch(() => {});
    ['pref_direction','pref_layout','pref_theme','pref_density'].forEach(k => localStorage.removeItem(k));
    migrated = true;
  }

  if (migrated) console.info('[store] migrated legacy localStorage data to files');
}

// ── Persistent data variables ─────────────────────────────────────────────────
// Declared here as empty objects; assigned from _store in init() after loadAllData().

let bookmarks    = {};
let muOverrides  = {};
let readProgress = {};
let coverIndex   = {};

function saveCoverIndex() { saveData('cover_index.json', coverIndex); }

// Per-theme font overrides
let _themeFontOverrides = {};
function _saveThemeFontOverrides() {
  saveData('theme_fonts.json', _themeFontOverrides);
}

function saveBookmarks()  { saveData('bookmarks.json',   bookmarks); }
function saveOverrides()  { saveData('mu_overrides.json', muOverrides); }
function isBookmarked(k)  { return !!bookmarks[k]; }

/**
 * Merges `patch` into the current settings object and persists.
 * Use this instead of accessing _store directly from other modules.
 */
function patchSettings(patch) {
  const current = getData('settings.json') || {};
  saveData('settings.json', { ...current, ...patch });
}
