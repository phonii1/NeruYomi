// ═══════════════════════════════════════════════════════════════
// SETTINGS
// Theme engine, font management, settings panel.
// Depends on: $, esc, safeColor, clampInt, hexToHsl, hslToHex,
//             shiftL, hexAlpha, isDark (utils.js)
//             IS_TAURI, invoke (utils.js)
//             getData, saveData, patchSettings (store.js)
// ═══════════════════════════════════════════════════════════════

// Defaults — overwritten at the top of initSettings() after loadAllData() resolves.
let userSettings = {
  direction: 'rtl',
  layout:    'single',
  theme:     'default',
  density:   'normal',
};

function applyDensity(d) {
  const grid = $('series-grid');
  if (!grid) return;
  grid.classList.remove('density-compact', 'density-normal', 'density-comfortable');
  grid.classList.add('density-' + d);
}

// ═══════════════════════════════════════════════════════════════
// CUSTOM THEME SYSTEM
// ═══════════════════════════════════════════════════════════════

let _customThemes = (() => {
  const t = getData('custom_themes.json');
  return (t && typeof t === 'object' && !Array.isArray(t)) ? t : {};
})();
function _saveCustomThemes() {
  saveData('custom_themes.json', _customThemes);
}

/**
 * Derives the full 30-variable palette from 3 source colors + 3 sliders.
 * depth    = how dark/light the deepest surface is relative to ink (1-15)
 * steps    = lightness gap between each surface level (2-10)
 * contrast = lightness spread between text-primary and text-faint (10-60)
 */
const _deriveThemeCache = new Map();
function deriveTheme(ink, accent, paper, depth=5, steps=5, contrast=35) {
  const key = `${ink}|${accent}|${paper}|${depth}|${steps}|${contrast}`;
  if (_deriveThemeCache.has(key)) return _deriveThemeCache.get(key);
  const result = _deriveThemeImpl(ink, accent, paper, depth, steps, contrast);
  if (_deriveThemeCache.size > 50) _deriveThemeCache.delete(_deriveThemeCache.keys().next().value);
  _deriveThemeCache.set(key, result);
  return result;
}
function _deriveThemeImpl(ink, accent, paper, depth=5, steps=5, contrast=35) {
  const dark = isDark(ink);
  const sign = dark ? 1 : -1; // positive = lighter for dark themes, darker for light

  // Surface tier — deepest is `depth` steps away from ink, then each tier
  // adds `steps` more lightness steps toward the center.
  const deep    = shiftL(ink, sign * depth);
  const base    = shiftL(ink, sign * (depth + steps));
  const raised  = shiftL(ink, sign * (depth + steps * 2));
  const hover   = shiftL(ink, sign * (depth + steps * 3));
  const overlay = shiftL(ink, sign * (depth + steps * 1.5));

  // Text tiers — spaced by contrast/3 each
  const step = contrast / 3;
  const textDim   = shiftL(paper, -sign * step);
  const textMuted = shiftL(paper, -sign * step * 2);
  const textFaint = shiftL(paper, -sign * step * 3);

  return {
    '--ink':          ink,
    '--paper':        paper,
    '--accent':       accent,
    '--accent-dark':  shiftL(accent, dark ? -12 : 12),

    '--surface-deep':    deep,
    '--surface-base':    base,
    '--surface-raised':  raised,
    '--surface-hover':   hover,
    '--surface-overlay': overlay,

    '--text-primary': paper,
    '--text-dim':     textDim,
    '--text-muted':   textMuted,
    '--text-faint':   textFaint,

    '--border-color':  hexAlpha(paper, 0.15),
    '--border-input':  shiftL(paper, -sign * (contrast - 5)),
    '--border-btn':    shiftL(paper, -sign * contrast),

    '--accent-muted-text': shiftL(accent, dark ? 15 : -15),
    '--accent-border':     hexAlpha(accent, 0.25),
    '--accent-hover':      hexAlpha(accent, 0.55),

    '--hero-tint-dark':  hexAlpha(ink, 0.88),
    '--hero-tint-mid':   hexAlpha(ink, 0.60),
    '--hero-tint-light': hexAlpha(ink, 0.28),

    '--surface-card-name':       hexAlpha(raised, 0.95),
    '--surface-card-name-hover': hexAlpha(raised, 0.98),

    '--item-border':  hexAlpha(paper, dark ? 0.04 : 0.06),
    '--item-hover':   hexAlpha(paper, dark ? 0.03 : 0.04),
    '--ch-sub-color': hexAlpha(paper, 0.25),
    '--ch-arr-color': hexAlpha(paper, 0.15),
  };
}

function _applyVars(vars) {
  const root = document.body;
  for (const [k,v] of Object.entries(vars)) root.style.setProperty(k, v);
}

function _clearInlineVars() {
  document.documentElement.removeAttribute('style');
  // Also clear vars set on body (where _applyVars writes to override theme classes)
  document.body.style.cssText = document.body.style.cssText
    .split(';')
    .filter(rule => !rule.trim().startsWith('--'))
    .join(';');
  // Re-apply font CSS variables — clearing inline styles wipes them
  Object.keys(FONT_SLOT_DEFAULTS).forEach(slot => {
    const cssVar = FONT_SLOT_DEFAULTS[slot]?.var;
    const theme  = userSettings.theme || 'default';
    const f = (_themeFontOverrides[theme] || {})[slot];
    if (f?.family && cssVar) {
      document.documentElement.style.setProperty(cssVar, `"${f.family}", sans-serif`);
    }
  });
}

function _readEditorValues() {
  return {
    ink:      $('ct-ink')?.value      || '#27252d',
    accent:   $('ct-accent')?.value   || '#b89ee8',
    paper:    $('ct-paper')?.value    || '#f3f1f9',
    depth:    parseInt($('ct-depth')?.value    || 5),
    steps:    parseInt($('ct-steps')?.value    || 5),
    contrast: parseInt($('ct-contrast')?.value || 35),
  };
}

/** Resets a single slider to its default value and re-previews the theme. */
function resetSlider(id, defaultVal) {
  const el = $(id);
  if (!el) return;
  el.value = defaultVal;
  previewCustomTheme();
}

function previewCustomTheme() {
  const { ink, accent, paper, depth, steps, contrast } = _readEditorValues();

  // Update hex labels
  if ($('ct-ink-hex'))    $('ct-ink-hex').textContent    = ink;
  if ($('ct-accent-hex')) $('ct-accent-hex').textContent = accent;
  if ($('ct-paper-hex'))  $('ct-paper-hex').textContent  = paper;

  // Update slider value labels
  if ($('ct-depth-val'))    $('ct-depth-val').textContent    = depth;
  if ($('ct-steps-val'))    $('ct-steps-val').textContent    = steps;
  if ($('ct-contrast-val')) $('ct-contrast-val').textContent = contrast;

  const vars = deriveTheme(ink, accent, paper, depth, steps, contrast);

  // Apply live to whatever theme is currently active — the editor is intentionally
  // a live modifier. Changes are reverted if settings is closed without saving.
  _applyVars(vars);

  // Always update the mini preview swatches regardless of active theme
  const sw = {
    'ct-sw-deep':   vars['--surface-deep'],
    'ct-sw-base':   vars['--surface-base'],
    'ct-sw-raised': vars['--surface-raised'],
    'ct-sw-hover':  vars['--surface-hover'],
    'ct-sw-accent': accent,
    'ct-sw-text':   paper,
  };
  for (const [id, color] of Object.entries(sw)) {
    const el = $(id); if (el) el.style.background = color;
  }
}

function saveCustomTheme() {
  const name = $('ct-name')?.value.trim();
  if (!name) { $('ct-name')?.focus(); return; }
  const { ink, accent, paper, depth, steps, contrast } = _readEditorValues();
  // Preserve existing font settings if re-saving an existing theme
  const existingFonts = _customThemes[name]?.fonts || {};
  // Merge with any fonts set since the editor was opened
  const fonts = Object.assign({}, existingFonts, _editorFonts);
  _customThemes[name] = { ink, accent, paper, depth, steps, contrast, fonts };
  _saveCustomThemes();
  renderCustomThemeList();
  _clearInlineVars();
  setSetting('theme', 'custom:' + name);
  const sel = $('theme-select');
  if (sel) sel.value = '';
}

// ═══════════════════════════════════════════════════════════════
// FONT MANAGEMENT
// Fonts are saved per-theme in _customThemes[name].fonts as:
//   { hdr: { family, cachedPath } | null,
//     body: { family, cachedPath } | null,
//     brand: { family, cachedPath } | null }
// Each font file is copied to appdata/fonts/ via cache_font_file
// so it's within the asset-protocol scope, then registered as a
// dynamic @font-face and applied via CSS variable.
// ═══════════════════════════════════════════════════════════════

// Fonts the user has picked in the current editor session (before saving)
let _editorFonts = {};

const FONT_SLOT_DEFAULTS = {
  hdr:   { family: 'League Spartan',     var: '--f-hdr'   },
  body:  { family: 'League Spartan',     var: '--f-body'  },
  brand: { family: 'Family And Friends', var: '--f-brand' },
};

/** Injects a @font-face rule and sets the CSS variable for a slot. */
function registerFont(slot, family, cachedPath) {
  const cssVar  = FONT_SLOT_DEFAULTS[slot]?.var;
  if (!cssVar) return;

  const styleId = `ny-font-${slot}`;
  let el = document.getElementById(styleId);
  if (!el) { el = document.createElement('style'); el.id = styleId; document.head.appendChild(el); }

  const src = IS_TAURI ? convertFileSrc(cachedPath) : cachedPath;
  el.textContent = `@font-face { font-family: "${family}"; src: url("${src}"); font-weight: 100 900; font-display: swap; }`;
  document.documentElement.style.setProperty(cssVar, `"${family}", sans-serif`);
}

/** Removes a custom font registration and restores the default. */
function unregisterFont(slot) {
  const cssVar = FONT_SLOT_DEFAULTS[slot]?.var;
  if (!cssVar) return;
  const el = document.getElementById(`ny-font-${slot}`);
  if (el) el.textContent = '';
  document.documentElement.style.removeProperty(cssVar);
}

/** Applies all fonts saved in a theme object. */
function applyThemeFonts(t) {
  // Fonts embedded in the theme object (custom themes)
  const embedded = t?.fonts || {};
  // Per-theme overrides (all themes, including built-ins)
  const theme    = userSettings.theme || 'default';
  const override = _themeFontOverrides[theme] || {};
  // Override wins over embedded
  Object.keys(FONT_SLOT_DEFAULTS).forEach(slot => {
    const f = override[slot] || embedded[slot];
    if (f?.family && f?.cachedPath) registerFont(slot, f.family, f.cachedPath);
    else unregisterFont(slot);
  });
  // Sync editor labels to show active fonts
  const merged = Object.assign({}, embedded, override);
  _syncFontEditorLabels(Object.keys(merged).length ? merged : null);
}

/** Opens a font picker for the given slot (editor session only — saved on SAVE). */
async function pickThemeFont(slot) {
  if (!IS_TAURI) return;
  const btn = $(`ct-font-${slot}-btn`);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }

  try {
    // First show system fonts in a quick-pick modal, with a fallback to file picker
    const fonts = await invoke('list_system_fonts');
    _showFontPicker(slot, fonts);
  } catch(e) {
    console.warn('[fonts] list_system_fonts failed, falling back to file picker:', e);
    await _pickFontFromFile(slot);
  } finally {
    const btn2 = $(`ct-font-${slot}-btn`);
    if (btn2) { btn2.disabled = false; btn2.innerHTML = ICON.identify + ' PICK'; }
  }
}

/** Opens the native file picker as a fallback font source. */
async function _pickFontFromFile(slot) {
  const path = await invoke('pick_font_file');
  if (!path) return;
  await _applyPickedFont(slot, path);
}

/** Caches and applies a font file path for the given slot. */
async function _applyPickedFont(slot, srcPath) {
  try {
    const cachedPath = await invoke('cache_font_file', { srcPath });
    const raw    = srcPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    const family = raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    registerFont(slot, family, cachedPath);

    // Save into _editorFonts (for custom theme SAVE) and into _themeFontOverrides
    // (persists immediately for the current theme, built-in or custom)
    _editorFonts[slot] = { family, cachedPath };
    const theme = userSettings.theme || 'default';
    if (!_themeFontOverrides[theme]) _themeFontOverrides[theme] = {};
    _themeFontOverrides[theme][slot] = { family, cachedPath };
    _saveThemeFontOverrides();

    const nameEl    = $(`ct-font-${slot}-name`);
    const previewEl = $(`ct-font-${slot}-preview`);
    if (nameEl)    nameEl.textContent        = family;
    if (previewEl) previewEl.style.fontFamily = `'${family}', serif`;
  } catch(e) {
    console.error('[fonts] apply failed:', e);
  }
}

/** Shows a modal listing installed system fonts for the user to pick from. */
const FONT_PREVIEW_TEXT = 'Aa Bb Cc — The quick brown fox';

function _showFontPicker(slot, fonts) {
  let modal = $('font-pick-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'font-pick-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:420px;max-height:85vh">
        <div class="modal-head" style="display:flex;align-items:center;justify-content:space-between">
          <div class="modal-title">PICK FONT</div>
          <button id="font-pick-close" class="nav-icon-btn" style="color:var(--text-muted)">${ICON.dots}</button>
        </div>
        <div class="modal-search-row">
          <input type="text" class="modal-input" id="font-pick-search" placeholder="Search fonts…" oninput="_filterFontList()" autocomplete="off" spellcheck="false">
          <button id="font-pick-file-btn" class="btn" style="font-size:10px;padding:4px 10px">FROM FILE</button>
        </div>
        <div class="modal-body" id="font-pick-list" style="padding:0"></div>
        <div id="font-pick-preview">
          <div id="font-pick-preview-name">hover to preview</div>
          <div id="font-pick-preview-sample">${FONT_PREVIEW_TEXT}</div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    document.getElementById('font-pick-close').addEventListener('click', () => modal.classList.remove('open'));
    document.getElementById('font-pick-file-btn').addEventListener('click', _fontPickFromFile);
  }

  modal.dataset.slot = slot;
  modal._fonts = fonts;

  // Populate list
  const list = $('font-pick-list');
  list.innerHTML = '';
  fonts.forEach(f => {
    const item = document.createElement('div');
    item.className = 'font-list-item';
    item.innerHTML = `
      <div class="font-item-name">${esc(f.name)}</div>
      <div class="font-item-sample" data-font-path="${esc(f.path)}">Aa Bb 0123</div>`;

    let _hoverTimer = null;

    item.addEventListener('mouseenter', () => {
      // Debounce so rapid scrolling doesn't fire dozens of cache calls
      clearTimeout(_hoverTimer);
      _hoverTimer = setTimeout(() => _lazyPreviewFont(f, item), 120);
    });
    item.addEventListener('mouseleave', () => {
      clearTimeout(_hoverTimer);
    });

    item.onclick = async () => {
      modal.classList.remove('open');
      await _applyPickedFont(modal.dataset.slot, f.path);
    };
    list.appendChild(item);
  });

  // Reset preview bar to neutral
  const prevSample = $('font-pick-preview-sample');
  const prevName   = $('font-pick-preview-name');
  if (prevSample) { prevSample.style.fontFamily = ''; prevSample.textContent = FONT_PREVIEW_TEXT; }
  if (prevName)   { prevName.textContent = 'hover to preview'; }

  const search = $('font-pick-search');
  if (search) search.value = '';
  modal.classList.add('open');
}

// Cache: path → preview family name (once registered, never re-injected)
const _fontPreviewCache = new Map();
const _FONT_PREVIEW_MAX = 80; // max @font-face rules before evicting oldest

function _fontPreviewCacheSet(path, family) {
  // Evict the oldest entry if at capacity to keep the style tag manageable
  if (_fontPreviewCache.size >= _FONT_PREVIEW_MAX) {
    const oldest = _fontPreviewCache.keys().next().value;
    _fontPreviewCache.delete(oldest);
  }
  _fontPreviewCache.set(path, family);
}

/**
 * Lazily registers a font file as a @font-face with a unique preview family
 * name, then applies it to the hover preview bar and the item's sample span.
 * Uses cache_font_file to copy the font into appdata so the asset protocol
 * can serve it — result is cached so subsequent hovers are instant.
 */
async function _lazyPreviewFont(f, item) {
  const label   = $('font-pick-preview-name');
  const preview = $('font-pick-preview-sample');

  // Optimistically show the name while the font loads
  if (label)   label.textContent = f.name;
  if (preview) preview.style.fontFamily = 'inherit';

  try {
    let previewFamily = _fontPreviewCache.get(f.path);

    if (!previewFamily) {
      // Copy to appdata so the asset protocol can serve it
      const cachedPath  = await invoke('cache_font_file', { srcPath: f.path });
      const src         = convertFileSrc(cachedPath);
      // Use a deterministic unique name so the same font is never re-injected
      const stem        = f.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
      previewFamily     = `ny-prev-${stem}`;

      let styleEl = document.getElementById('ny-font-previews');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'ny-font-previews';
        document.head.appendChild(styleEl);
      }
      styleEl.textContent += `@font-face{font-family:"${previewFamily}";src:url("${src}");font-display:swap;}\n`;
      _fontPreviewCacheSet(f.path, previewFamily);
    }

    // Wait for the font to actually be available before applying
    await document.fonts.load(`16px "${previewFamily}"`).catch(() => {});

    // Apply to preview bar
    if (preview) preview.style.fontFamily = `"${previewFamily}", serif`;

    // Apply to the item's own sample span so the list is self-previewing
    const sampleEl = item.querySelector('.font-item-sample');
    if (sampleEl) sampleEl.style.fontFamily = `"${previewFamily}", serif`;

  } catch(e) {
    // cache_font_file failed (e.g. permission error) — fall back to filename
    if (preview) preview.style.fontFamily = `"${f.name}", serif`;
    console.warn('[font preview] failed for', f.name, e);
  }
}

function _filterFontList() {
  const modal = $('font-pick-modal');
  if (!modal) return;
  const q = $('font-pick-search')?.value.toLowerCase() || '';
  modal.querySelectorAll('.font-list-item').forEach((item, i) => {
    const f = modal._fonts[i];
    item.style.display = (!q || f.name.toLowerCase().includes(q)) ? '' : 'none';
  });
}

async function _fontPickFromFile() {
  const modal = $('font-pick-modal');
  const slot = modal?.dataset.slot;
  if (!slot) return;
  modal?.classList.remove('open');
  await _pickFontFromFile(slot);
}

/** Resets a font slot to its default and removes the saved entry. */
function resetThemeFont(slot) {
  unregisterFont(slot);
  delete _editorFonts[slot];
  // Also clear the per-theme override so the reset persists on reload
  const theme = userSettings.theme || 'default';
  if (_themeFontOverrides[theme]) {
    delete _themeFontOverrides[theme][slot];
    if (!Object.keys(_themeFontOverrides[theme]).length) delete _themeFontOverrides[theme];
    _saveThemeFontOverrides();
  }
  const nameEl    = $(`ct-font-${slot}-name`);
  const previewEl = $(`ct-font-${slot}-preview`);
  const cssVar    = FONT_SLOT_DEFAULTS[slot]?.var || '';
  if (nameEl)    nameEl.textContent        = FONT_SLOT_DEFAULTS[slot]?.family || 'Default';
  if (previewEl) previewEl.style.fontFamily = `var(${cssVar})`;
}

/** Restores font label displays when loading a theme into the editor. */
function _syncFontEditorLabels(fonts) {
  Object.keys(FONT_SLOT_DEFAULTS).forEach(slot => {
    const nameEl    = $(`ct-font-${slot}-name`);
    const previewEl = $(`ct-font-${slot}-preview`);
    const f = fonts?.[slot];
    if (nameEl)    nameEl.textContent        = f?.family || FONT_SLOT_DEFAULTS[slot].family;
    if (previewEl) previewEl.style.fontFamily = f?.family ? `'${f.family}', serif` : `var(${FONT_SLOT_DEFAULTS[slot].var})`;
  });
}

function loadCustomTheme(name) {
  const t = _customThemes[name];
  if (!t) return;
  if ($('ct-ink'))      $('ct-ink').value      = t.ink;
  if ($('ct-accent'))   $('ct-accent').value   = t.accent;
  if ($('ct-paper'))    $('ct-paper').value    = t.paper;
  if ($('ct-depth'))    $('ct-depth').value    = t.depth    ?? 5;
  if ($('ct-steps'))    $('ct-steps').value    = t.steps    ?? 5;
  if ($('ct-contrast')) $('ct-contrast').value = t.contrast ?? 35;
  if ($('ct-name'))     $('ct-name').value     = name;
  _editorFonts = {};  // clear session fonts — loaded theme is the source of truth
  _syncFontEditorLabels(t.fonts);
  previewCustomTheme();
  setSetting('theme', 'custom:' + name);
  const sel = $('theme-select');
  if (sel) sel.value = '';
  renderCustomThemeList();
}

function deleteCustomTheme(name) {
  delete _customThemes[name];
  _saveCustomThemes();
  if (userSettings.theme === 'custom:' + name) {
    _clearInlineVars();
    setSetting('theme', 'default');
    if ($('theme-select')) $('theme-select').value = 'default';
  }
  renderCustomThemeList();
}

function resetCustomEditor() {
  if ($('ct-ink'))      $('ct-ink').value      = '#27252d';
  if ($('ct-accent'))   $('ct-accent').value   = '#b89ee8';
  if ($('ct-paper'))    $('ct-paper').value    = '#f3f1f9';
  if ($('ct-depth'))    $('ct-depth').value    = 5;
  if ($('ct-steps'))    $('ct-steps').value    = 5;
  if ($('ct-contrast')) $('ct-contrast').value = 35;
  if ($('ct-name'))     $('ct-name').value     = '';
  _editorFonts = {};
  _syncFontEditorLabels(null); // resets labels to defaults
  Object.keys(FONT_SLOT_DEFAULTS).forEach(unregisterFont);
  _clearInlineVars();
  previewCustomTheme();
}

function toggleCustomThemeEditor() {
  const body    = $('ct-body');
  const chevron = $('ct-chevron');
  if (!body) return;
  const collapsed = body.classList.toggle('collapsed');
  if (chevron) chevron.style.transform = collapsed ? 'rotate(-90deg)' : '';

  if (!collapsed) {
    // Re-seed from current theme each time the editor expands so colors
    // stay in sync if the user switched presets while the editor was closed.
    if (!userSettings.theme?.startsWith('custom:')) {
      _seedEditorFromCurrentTheme();
    }
  } else {
    // Collapsing without saving — revert any live preview changes made while
    // the editor was open on a built-in theme
    if (!userSettings.theme?.startsWith('custom:')) {
      _revertPreviewChanges();
    }
  }
}

/**
 * Reads the current active theme's colors and populates the custom theme
 * editor inputs. Uses a hardcoded map of preset colors (matching the CSS)
 * since getComputedStyle on CSS-class-defined variables is unreliable.
 */
function _seedEditorFromCurrentTheme() {
  // Colors must match the CSS preset definitions exactly
  const PRESET_COLORS = {
    'default':       { ink: '#27252d', accent: '#b89ee8', paper: '#f3f1f9' },
    'default-light': { ink: '#f3f1f9', accent: '#9b85d4', paper: '#27252d' },
    'arctic':        { ink: '#090d12', accent: '#7eb8d4', paper: '#d6eaf8' },
    'paper':         { ink: '#f5f0e8', accent: '#8b6530', paper: '#2a1f14' },
    'mist':          { ink: '#eef3f8', accent: '#3a7ca5', paper: '#1a2a3a' },
    'lilac':         { ink: '#f0ebff', accent: '#7a60c0', paper: '#1e1830' },
  };

  const theme  = userSettings.theme || 'default';
  const colors = PRESET_COLORS[theme] || PRESET_COLORS['default'];

  if ($('ct-ink'))    $('ct-ink').value    = colors.ink;
  if ($('ct-accent')) $('ct-accent').value = colors.accent;
  if ($('ct-paper'))  $('ct-paper').value  = colors.paper;

  // Sliders reset to defaults — built-in themes don't store slider values
  if ($('ct-depth'))    $('ct-depth').value    = 5;
  if ($('ct-steps'))    $('ct-steps').value    = 5;
  if ($('ct-contrast')) $('ct-contrast').value = 35;
  if ($('ct-name'))     $('ct-name').value     = '';

  previewCustomTheme();
}

/**
 * Reverts any live preview changes made by the custom theme editor on a
 * built-in theme, by re-applying the theme from scratch.
 */
function _revertPreviewChanges() {
  _clearInlineVars();
  const t = userSettings.theme;
  if (t && t !== 'default') {
    document.body.className = document.body.className.replace(/\btheme-\S+/g, '').trim();
    document.body.classList.add('theme-' + t);
  }
  // Re-apply font overrides since _clearInlineVars wiped the CSS variable values
  applyThemeFonts(null);
}

function renderCustomThemeList() {
  const list = $('ct-saved-list');
  if (!list) return;
  list.innerHTML = '';
  const names = Object.keys(_customThemes);
  if (!names.length) return;
  for (const name of names) {
    const t = _customThemes[name];
    const isActive = userSettings.theme === 'custom:' + name;
    const item = document.createElement('div');
    item.className = 'ct-saved-item' + (isActive ? ' active' : '');
    item.innerHTML = `
      <div class="ct-saved-swatches">
        <div class="ct-saved-swatch" style="background:${safeColor(t.ink)}"></div>
        <div class="ct-saved-swatch" style="background:${safeColor(t.accent)}"></div>
        <div class="ct-saved-swatch" style="background:${safeColor(t.paper)}"></div>
      </div>
      <span class="ct-saved-name">${esc(name)}</span>
      <button class="ct-saved-del" title="Delete">✕</button>`;
    item.querySelector('.ct-saved-name').onclick = () => loadCustomTheme(name);
    item.querySelector('.ct-saved-del').onclick  = e => { e.stopPropagation(); deleteCustomTheme(name); };
    list.appendChild(item);
  }
}

/**
 * Populates userSettings from the store, then wires up all reader/theme/DOM
 * state. Must be called after loadAllData() has resolved so _store is populated.
 */
function initSettings() {
  // Load persisted values — _store is guaranteed populated at this point.
  const _s = getData('settings.json');
  userSettings.direction = _s.direction || 'rtl';
  userSettings.layout    = _s.layout    || 'single';
  userSettings.theme     = _s.theme     || 'default';
  userSettings.density   = _s.density   || 'normal';

  reader.rtl    = userSettings.direction === 'rtl';
  reader.spread = userSettings.layout    === 'spread';
  reader.strip  = userSettings.layout    === 'strip';
  document.querySelector('input[name="direction"][value="' + userSettings.direction + '"]').checked = true;
  const layoutVal = ['single', 'spread', 'strip'].includes(userSettings.layout) ? userSettings.layout : 'single';
  document.querySelector('input[name="layout"][value="' + layoutVal + '"]').checked = true;
  document.querySelector('input[name="density"][value="' + userSettings.density + '"]').checked = true;
  // Theme select — blank if a custom theme is active
  const themeIsCustom = userSettings.theme?.startsWith('custom:');
  if ($('theme-select')) $('theme-select').value = themeIsCustom ? '' : (userSettings.theme || 'default');
  if (!themeIsCustom && userSettings.theme !== 'default') {
    document.body.classList.add('theme-' + userSettings.theme);
  }
  // Apply font overrides for built-in themes on startup
  if (!themeIsCustom) {
    applyThemeFonts(null);
  }
  // Restore custom theme if one was active
  if (themeIsCustom) {
    const name = userSettings.theme.slice(7);
    const t = _customThemes[name];
    if (t) {
      if ($('ct-ink'))      $('ct-ink').value      = t.ink;
      if ($('ct-accent'))   $('ct-accent').value   = t.accent;
      if ($('ct-paper'))    $('ct-paper').value    = t.paper;
      if ($('ct-depth'))    $('ct-depth').value    = t.depth    ?? 5;
      if ($('ct-steps'))    $('ct-steps').value    = t.steps    ?? 5;
      if ($('ct-contrast')) $('ct-contrast').value = t.contrast ?? 35;
      if ($('ct-name'))     $('ct-name').value     = name;
      _applyVars(deriveTheme(
        safeColor(t.ink), safeColor(t.accent), safeColor(t.paper),
        clampInt(t.depth,    1, 20, 5),
        clampInt(t.steps,    1, 20, 5),
        clampInt(t.contrast, 5, 60, 35)
      ));
      applyThemeFonts(t);
    }
  }
  // Always seed the editor inputs from whatever theme is currently active
  // so _readEditorValues never falls back to hardcoded dark-theme defaults.
  if (!themeIsCustom) {
    _seedEditorFromCurrentTheme();
  }
  previewCustomTheme();
  renderCustomThemeList();
  applyDensity(userSettings.density);
}

function setSetting(key, value) {
  userSettings[key] = value;
  patchSettings({ [key]: value });

  if (key === 'direction') {
    reader.rtl = (value === 'rtl');
    if ($('view-reader').classList.contains('active')) {
      renderProgressSegs();
      renderPage();
      stat();
    }
  } else if (key === 'layout') {
    reader.spread = (value === 'spread');
    reader.strip  = (value === 'strip');
    const badge = $('strip-auto-badge');
    if (badge) badge.classList.remove('show');
    if ($('view-reader').classList.contains('active')) {
      _disconnectStripScroll(); renderThumbs(); renderPage(); stat();
    }
  } else if (key === 'theme') {
    document.body.className = document.body.className.replace(/\btheme-\S+/g, '').trim();
    _clearInlineVars();
    // Clear any custom fonts from the previous theme before applying new one
    Object.keys(FONT_SLOT_DEFAULTS).forEach(unregisterFont);
    if (value.startsWith('custom:')) {
      const name = value.slice(7);
      const t = _customThemes[name];
      if (t) {
        _applyVars(deriveTheme(
          safeColor(t.ink), safeColor(t.accent), safeColor(t.paper),
          clampInt(t.depth,    1, 20, 5),
          clampInt(t.steps,    1, 20, 5),
          clampInt(t.contrast, 5, 60, 35)
        ));
        applyThemeFonts(t);
        // Sync editor inputs with this custom theme's values
        if ($('ct-ink'))      $('ct-ink').value      = safeColor(t.ink);
        if ($('ct-accent'))   $('ct-accent').value   = safeColor(t.accent);
        if ($('ct-paper'))    $('ct-paper').value    = safeColor(t.paper);
        if ($('ct-depth'))    $('ct-depth').value    = clampInt(t.depth,    1, 20, 5);
        if ($('ct-steps'))    $('ct-steps').value    = clampInt(t.steps,    1, 20, 5);
        if ($('ct-contrast')) $('ct-contrast').value = clampInt(t.contrast, 5, 60, 35);
        if ($('ct-name'))     $('ct-name').value     = name;
        previewCustomTheme();
      }
    } else {
      if (value !== 'default') document.body.classList.add('theme-' + value);
      applyThemeFonts(null);
    }
    // Keep editor in sync with the newly active theme
    if (!value.startsWith('custom:')) _seedEditorFromCurrentTheme();
    renderCustomThemeList();
  } else if (key === 'density') {
    applyDensity(value);
  }
}

function toggleSettings() {
  const panel = $('settings-panel');
  const overlay = $('settings-overlay');
  const wasOpen = panel.classList.contains('open');
  panel.classList.toggle('open');
  overlay.classList.toggle('show');
  if (panel.classList.contains('open')) {
    updateMuCacheStats();
  } else if (wasOpen && !userSettings.theme?.startsWith('custom:')) {
    // Settings closed without saving — revert any live preview changes
    _revertPreviewChanges();
  }
}
