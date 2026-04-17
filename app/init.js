// ═══════════════════════════════════════════════════════════════
// APPLICATION STATE
// All mutable runtime state lives on these three objects so every
// mutation site is immediately obvious from the property namespace.
// ═══════════════════════════════════════════════════════════════

const library = {
  rootHandle: null,
  items:      [],      // was: library[]
  curSeries:  null,
  curChIdx:   0,
};

const reader = {
  pages:   [],
  curPage: 0,
  spread:  false,
  strip:   false,
  rtl:     true,
  zoom:    1,
  src:     'local',   // was: readerSrc
  panX:    0,         // was: _panX
  panY:    0,         // was: _panY
};

const ui = {
  activeView:     null,
  activeTab:      'library',
  freshLoad:      false,
  chSortAsc:      true,
  activeGenres:   new Set(),
  navBack:        false,
  navHistory:     [],
  barVisible:     true,
  theatreMode:    false,
  currentView:    null,  // was: bc._current
  libSort:        'az',
  selectMode:     false,
  selectedSeries: new Set(),
};


// ── PDF.js setup ──
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.js';
}

/**
 * Renders a PDF page to an off-screen canvas and returns a blob URL.
 * Scale chosen so page height ~1200px for crisp rendering.
 */
async function pdfPageToUrl(pdfPage) {
  const RENDER_HEIGHT = 1200;
  const vp0 = pdfPage.getViewport({ scale: 1 });
  const scale = RENDER_HEIGHT / vp0.height;
  const vp = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  return new Promise(res => canvas.toBlob(b => res(URL.createObjectURL(b)), 'image/jpeg', 0.93));
}

/**
 * Opens a PDF File and returns a pages[] compatible array (lazy).
 */
async function pdfFileToPages(file) {
  const ab = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: ab }).promise;
  const arr = [];
  for (let i = 1; i <= doc.numPages; i++)
    arr.push({ name: `Page ${i}`, url: null, revoke: true, pdfDoc: doc, pdfPageNum: i });
  return arr;
}

async function preloadPdfPage(entry) {
  if (entry.url || !entry.pdfDoc) return;
  const pg = await entry.pdfDoc.getPage(entry.pdfPageNum);
  entry.url = await pdfPageToUrl(pg);
}


// ═══════════════════════════════════════════════════════════════
// VIEW HELPERS
// ═══════════════════════════════════════════════════════════════

// Track the currently active view element so show() only touches
// two nodes per navigation instead of querying and iterating all views.

function show(id) {
  if (ui.activeView) ui.activeView.classList.remove('active');
  ui.activeView = $('view-' + id);
  if (ui.navBack) ui.activeView.style.animation = 'none';
  else            ui.activeView.style.animation = '';
  ui.navBack = false;
  ui.activeView.classList.add('active');
  const inLib = id === 'library';
  $('bc').style.display = inLib ? 'none' : '';
  // Exit select mode whenever we leave the library view
  if (!inLib && ui.selectMode) {
    ui.selectMode = false;
    ui.selectedSeries.clear();
    document.body.classList.remove('select-active');
    const btn = $('lib-select-btn');
    if (btn) { btn.textContent = 'SELECT'; btn.classList.remove('on'); }
    const bar = $('trash-action-bar');
    if (bar) bar.style.display = 'none';
  }
  if (id === 'chapters') requestAnimationFrame(() => { const el = $('view-chapters'); if (el) el.scrollTop = _savedChScroll; });
}

function setTab(tab) {
  ui.activeTab = tab;
  document.querySelectorAll('.lib-tab').forEach(b => b.classList.toggle('active', b.id === 'tab-' + tab));
  renderLibrary($('search').value);
}


// ═══════════════════════════════════════════════════════════════
// EVENT WIRING
// All static-HTML event handlers are registered here so the HTML
// contains no inline on*= attributes, allowing 'unsafe-inline' to
// be removed from script-src in tauri.conf.json.
// ═══════════════════════════════════════════════════════════════

function _wireEvents() {
  // ── Header nav ──────────────────────────────────────────────
  $('nav-back-btn').addEventListener('click', mobileBack);
  $('nav-forward-btn').addEventListener('click', mobileForward);
  $('nav-rescan-btn').addEventListener('click', rescanLibrary);

  // ── Search ──────────────────────────────────────────────────
  $('search-clear').addEventListener('click', clearSearch);

  // ── Settings panel ──────────────────────────────────────────
  $('settings-btn').addEventListener('click', toggleSettings);
  $('settings-overlay').addEventListener('click', toggleSettings);
  $('settings-close-btn').addEventListener('click', toggleSettings);

  // ── Library tabs ────────────────────────────────────────────
  $('tab-library').addEventListener('click', () => setTab('library'));
  $('tab-bookmarks').addEventListener('click', () => setTab('bookmarks'));

  // ── Library toolbar ─────────────────────────────────────────
  $('genre-dropdown-btn').addEventListener('click', toggleGenreDropdown);
  $('lib-sort-select').addEventListener('change', function() { setLibSort(this.value); });
  $('lib-select-btn').addEventListener('click', toggleSelectMode);

  // ── Trash bar ───────────────────────────────────────────────
  $('trash-open-btn').addEventListener('click', openTrashFolder);
  $('trash-move-btn').addEventListener('click', moveSelectedToTrash);

  // ── Series / chapters view ───────────────────────────────────
  $('hero-open-folder').addEventListener('click', openCurrentSeriesFolder);
  $('ch-sort-btn').addEventListener('click', toggleChSort);

  // ── Reader nav buttons ───────────────────────────────────────
  $('nav-prev').addEventListener('click', () => reader.rtl ? goNext() : goPrev());
  $('nav-next').addEventListener('click', () => reader.rtl ? goPrev() : goNext());
  $('strip-prev-ch').addEventListener('click', goPrevChapter);
  $('strip-next-ch').addEventListener('click', goNextChapter);

  // ── Settings: reading direction ──────────────────────────────
  document.querySelectorAll('input[name="direction"]').forEach(r =>
    r.addEventListener('change', function() { setSetting('direction', this.value); }));

  // ── Settings: page layout ────────────────────────────────────
  document.querySelectorAll('input[name="layout"]').forEach(r =>
    r.addEventListener('change', function() { setSetting('layout', this.value); }));

  // ── Settings: theme select ───────────────────────────────────
  $('theme-select').addEventListener('change', function() { setSetting('theme', this.value); });

  // ── Custom theme editor ──────────────────────────────────────
  $('ct-collapsible-hdr').addEventListener('click', toggleCustomThemeEditor);
  $('ct-ink').addEventListener('input', previewCustomTheme);
  $('ct-accent').addEventListener('input', previewCustomTheme);
  $('ct-paper').addEventListener('input', previewCustomTheme);
  $('ct-depth-reset').addEventListener('click', () => resetSlider('ct-depth', 5));
  $('ct-depth').addEventListener('input', previewCustomTheme);
  $('ct-steps-reset').addEventListener('click', () => resetSlider('ct-steps', 5));
  $('ct-steps').addEventListener('input', previewCustomTheme);
  $('ct-contrast-reset').addEventListener('click', () => resetSlider('ct-contrast', 35));
  $('ct-contrast').addEventListener('input', previewCustomTheme);
  $('ct-font-hdr-btn').addEventListener('click', () => pickThemeFont('hdr'));
  $('ct-font-hdr-reset').addEventListener('click', () => resetThemeFont('hdr'));
  $('ct-font-body-btn').addEventListener('click', () => pickThemeFont('body'));
  $('ct-font-body-reset').addEventListener('click', () => resetThemeFont('body'));
  $('ct-font-brand-btn').addEventListener('click', () => pickThemeFont('brand'));
  $('ct-font-brand-reset').addEventListener('click', () => resetThemeFont('brand'));
  $('ct-theme-save').addEventListener('click', saveCustomTheme);
  $('ct-theme-reset').addEventListener('click', resetCustomEditor);

  // ── Settings: library grid density ──────────────────────────
  document.querySelectorAll('input[name="density"]').forEach(r =>
    r.addEventListener('change', function() { setSetting('density', this.value); }));

  // ── Settings: updates ────────────────────────────────────────
  // ── Settings: MangaUpdates cache ─────────────────────────────
  // ── Split chapter modal ─────────────────────────────────────
  $('split-ch-modal').addEventListener('click', closeSplitModal);
  $('split-ch-modal').querySelector('.modal-box').addEventListener('click', e => e.stopPropagation());
  $('split-ch-cancel').addEventListener('click', closeSplitModal);
  $('split-ch-confirm').addEventListener('click', confirmSplit);
  $('split-add-range-btn').addEventListener('click', _addRangeRow);

  $('mu-cache-refresh-btn')?.addEventListener('click', refreshAllMuCache);
  $('mu-cache-clear-btn')?.addEventListener('click', clearAllMuCache);

  $('check-updates-btn').addEventListener('click', manualCheckUpdate);

  // ── Card context menu ────────────────────────────────────────
  $('ctx-bookmark-btn').addEventListener('click', ctxBookmark);
  $('ctx-identify-btn').addEventListener('click', ctxIdentify);
  $('ctx-cover-btn').addEventListener('click', ctxSetCover);
  $('ctx-cover-reset-btn').addEventListener('click', ctxResetCover);
  $('ctx-folder-btn').addEventListener('click', ctxOpenFolder);

  // ── Identify modal ───────────────────────────────────────────
  $('identify-modal').addEventListener('click', closeIdentifyModal);
  $('identify-modal').querySelector('.modal-box').addEventListener('click', e => e.stopPropagation());
  $('identify-search').addEventListener('keydown', e => { if (e.key === 'Enter') runIdentifySearch(); });
  $('identify-search-btn').addEventListener('click', runIdentifySearch);
  $('identify-clear-btn').addEventListener('click', clearMuOverride);
  $('identify-close-btn').addEventListener('click', closeIdentifyModal);

  // ── DevTools: F12 / Ctrl+Shift+I ────────────────────────────
  if (IS_TAURI) {
    document.addEventListener('keydown', e => {
      if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) {
        e.preventDefault();
        invoke('toggle_devtools');
      }
    });
  }
}


// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════
(async function init() {
  // Load all persisted data from files (or localStorage in browser) before
  // anything else runs — initSettings reads from _store synchronously.
  await loadAllData();

  // Assign data variables directly from the loaded store
  bookmarks           = getData('bookmarks.json');
  muOverrides         = getData('mu_overrides.json');
  readProgress        = getData('progress.json');
  coverIndex          = getData('cover_index.json');
  _themeFontOverrides = getData('theme_fonts.json');
  _customThemes       = getData('custom_themes.json');
  _initMuCache(); // must run after loadAllData so muCache reads from populated _store

  initSettings();

  // Wire all static-HTML event handlers via addEventListener (no inline on*=).
  _wireEvents();

  $('land-open').addEventListener('click', openLibrary);
  document.querySelector('.logo').addEventListener('click', () => {
    if (!library.items.length) { show('landing'); bc('landing'); return; }
    const v = ui.currentView;
    if (v === 'library') return;
    if (v === 'reader') {
      ui.navHistory.push('reader');
      ui.navHistory.push('chapters');
    } else if (v === 'chapters') {
      ui.navHistory.push('chapters');
    }
    ui.navBack = true;
    show('library');
    bc('library');
  });
  bc('landing');
  show('landing');

  // ── TAURI: Version + silent update check on launch ─────────────────────
  if (IS_TAURI) {
    try {
      _appVersion = await getAppVersion();
      $('update-status').textContent = `CURRENT: v${_appVersion}`;
    } catch(_) {}
    checkForUpdates(true).then(update => {
      if (update) showUpdateBanner(update);
    }).catch(() => {});
  }

  // ── TAURI: Auto-reopen library on launch ───────────────────────────────
  if (IS_TAURI) {
    // Read library path from settings.json (data layer) with fallback to the
    // old library_path.txt via Rust command for users upgrading from older builds.
    const _settings = getData('settings.json');
    const savedPath = _settings.libraryPath
      || await invoke('load_library_path').catch(() => null);
    if (savedPath) {
      // Migrate: if path came from the old Rust command, write it to settings.json
      if (!_settings.libraryPath) {
        patchSettings({ libraryPath: savedPath });
      }
      try {
        await _loadLibraryFromPath(savedPath);
      } catch(e) {
        console.warn('Saved library path no longer accessible:', savedPath);
      }
    }
  }
})(); // end init()
