// ═══════════════════════════════════════════════════════════════
// LIBRARY
// Library grid, series view, chapter list, search, nav, rescan.
// Depends on: $, esc, natCmp, isImg, isPdf, chapterCmp,
//             parseChapterKey, cleanChTitle, extractGroup,
//             formatBytes, badgeText, HAS_FSAPI,
//             IS_TAURI, invoke, convertFileSrc (utils.js)
//             saveData, getData, bookmarks, muOverrides,
//             coverIndex, readProgress, saveBookmarks,
//             saveCoverIndex, isBookmarked (store.js)
//             fetchMuInfo, enqueueMuCover, applyMuInfoToPanel (mu.js)
//             library, reader, ui (state)
// ═══════════════════════════════════════════════════════════════

async function openLibrary() {
  if (HAS_FSAPI) await openLibraryFSAPI();
  else           openLibraryFallback();
}

// FSAPI path (Chrome/Edge)
async function openLibraryFSAPI() {
  if (IS_TAURI) { await openLibraryTauri(); return; }
  // Browser fallback — use File System Access API
  try {
    library.rootHandle = await window.showDirectoryPicker({ mode:'read' });
    freeLibrary();
    library.items = [];
    const dirs = [];
    for await (const [name, handle] of library.rootHandle.entries())
      if (handle.kind==='directory' && name !== '_trash') dirs.push({name, handle});
    dirs.sort((a,b)=>natCmp(a.name,b.name));
    for (const {name, handle} of dirs) {
      const chapters = await getChaptersFSAPI(handle);
      library.items.push({name, handle, chapters, coverUrl:null});
    }
    renderLibrary(); show('library'); bc('library');
    library.items.forEach(loadCoverFSAPI);
  } catch(e) { if(e.name!=='AbortError') console.error(e); }
}

// ── TAURI NATIVE LIBRARY ─────────────────────────────────────────────────────

async function openLibraryTauri() {
  const folderPath = await invoke('pick_folder');
  if (!folderPath) return;
  ui.freshLoad = true;
  await _loadLibraryFromPath(folderPath);
  // Persist library path via the data layer
  patchSettings({ libraryPath: folderPath });
}

async function _loadLibraryFromPath(folderPath) {
  library.rootHandle = { name: folderPath.split(/[\\/]/).pop(), _path: folderPath };
  if (IS_TAURI) await invoke('set_library_root', { path: folderPath }).catch(() => {});
  freeLibrary();
  library.items = [];
  // Load persisted sort preference
  ui.libSort = getData('settings.json').libSort || 'az';
  const topEntries = await invoke('read_dir', { path: folderPath });
  const dirs = topEntries
    .filter(e => e.is_dir && e.name !== '_trash')  // exclude trash folder
    .sort((a, b) => natCmp(a.name, b.name));
  for (const dir of dirs) {
    const chapters = await getChaptersTauri(dir.path);
    library.items.push({ name: dir.name, path: dir.path, chapters, coverUrl: null, size: null });
  }
  renderLibrary(); show('library'); bc('library');
  library.items.forEach(loadCoverTauri);
  library.items.forEach(loadSeriesSize);
  // Show select button only in Tauri (requires filesystem access)
  const selBtn = $('lib-select-btn');
  if (selBtn) selBtn.style.display = '';
  // Start watching for new series folders
  if (IS_TAURI) invoke('start_library_watcher', { path: folderPath }).catch(() => {});
}

async function getChaptersTauri(seriesPath) {
  const entries = await invoke('read_dir', { path: seriesPath });
  const chapters = [];
  for (const e of entries) {
    const lo = e.name.toLowerCase();
    if (e.is_dir) {
      chapters.push({ name: e.name, path: e.path, isPdf: false });
    } else if (lo.endsWith('.pdf')) {
      chapters.push({ name: e.name.replace(/\.pdf$/i, ''), path: e.path, isPdf: true, pdfPath: e.path });
    } else if (lo.endsWith('.cbz')) {
      chapters.push({ name: e.name.replace(/\.cbz$/i, ''), path: e.path, isCbz: true, cbzPath: e.path });
    }
  }
  chapters.sort((a, b) => chapterCmp(a.name, b.name));
  return chapters;
}

async function loadCoverTauri(series) {
  if (!series.chapters.length) return;

  // Fast path: cover was cached on a previous launch — apply immediately
  if (IS_TAURI && coverIndex[series.name]) {
    const entry = coverIndex[series.name];
    const cachedPath = typeof entry === 'string' ? entry : entry.cachedPath;
    const url = convertFileSrc(cachedPath);
    if (!library.items.includes(series)) return; // library replaced while awaiting
    setCoverUrl(series, url);
    const card = getSeriesCard(series.name);
    if (card) { rebuildCoverEl(card, 'local:'+series.name, series, 'local'); }
    // Fetch MU metadata only (no cover re-download) unless it's a custom cover
    if (!entry?.custom) _applyMuMetadataOnly(series).catch(() => {});
    return;
  }

  const ch = series.chapters[0];
  const localFallback = async () => {
    try {
      if (ch.isCbz && ch.cbzPath) {
        const cbzEntries = await invoke('read_cbz_entries', { path: ch.cbzPath });
        if (!cbzEntries.length || !library.items.includes(series)) return;
        const b64 = await invoke('read_cbz_entry', { path: ch.cbzPath, name: cbzEntries[0] });
        setCoverUrl(series, _base64ToUrl(b64, _imgMimeType(cbzEntries[0])));
        const card = getSeriesCard(series.name);
        if (card) { rebuildCoverEl(card, 'local:'+series.name, series, 'local'); }
        return;
      }
      const entries = await invoke('read_dir', { path: ch.path });
      if (!library.items.includes(series)) return; // library replaced while awaiting
      const imgs = entries
        .filter(e => !e.is_dir && isImg(e.name))
        .sort((a, b) => natCmp(a.name, b.name));
      if (!imgs.length) return;
      setCoverUrl(series, convertFileSrc(imgs[0].path));
      const card = getSeriesCard(series.name);
      if (card) { rebuildCoverEl(card, 'local:'+series.name, series, 'local'); }
    } catch(e) { console.warn('Tauri cover error', e); }
  };
  enqueueMuCover(series, localFallback);
}

async function loadSeriesSize(series) {
  if (!IS_TAURI || !series.path) return;
  try {
    const size = await invoke('get_series_size', { path: series.path });
    if (!library.items.includes(series)) return; // library replaced while awaiting
    series.size = size;
    const badge = document.querySelector(`[data-series="${CSS.escape(series.name)}"] .s-badge`);
    if (badge) badge.innerHTML = `<span class="s-badge-ch">${series.chapters.length} CH</span><span class="s-badge-sz">${formatBytes(series.size)}</span>`;
    updateLibraryInfo();
  } catch(e) { /* non-critical — badge stays as chapter count only */ }
}
async function getChaptersFSAPI(h) {
  const dirs = [], pdfs = [];
  for await (const [name, handle] of h.entries()) {
    if (handle.kind==='directory') dirs.push({name, handle});
    else if (handle.kind==='file' && isPdf(name)) pdfs.push({name, handle});
  }
  dirs.sort((a,b)=>chapterCmp(a.name,b.name));
  pdfs.sort((a,b)=>chapterCmp(a.name,b.name));
  const pdfChapters = pdfs.map(({name, handle}) => ({
    name: name.replace(/\.pdf$/i, ''),
    handle: makePdfDirHandle(handle),
    pdfHandle: handle,
  }));
  return [...dirs, ...pdfChapters];
}
function makePdfDirHandle(fileHandle) {
  return {
    _isPdfChapter: true,
    _fileHandle: fileHandle,
    entries: async function*() {},
  };
}
async function loadCoverFSAPI(series) {
  if (!series.chapters.length) return;
  const ch = series.chapters[0];

  // Build a fallback that reads the first image/PDF page locally.
  // This runs only when MU has no cover art for the series.
  const localFallback = async () => {
    if (ch.pdfHandle) {
      try {
        const file  = await ch.pdfHandle.getFile();
        const pdfPages = await pdfFileToPages(file);
        if (pdfPages.length) {
          await preloadPdfPage(pdfPages[0]);
          setCoverUrl(series, pdfPages[0].url);
          const card = getSeriesCard(series.name);
          if (card) { rebuildCoverEl(card, 'local:'+series.name, series, 'local'); }
        }
      } catch(e) { console.warn('PDF cover error', e); }
      return;
    }
    const imgs = [];
    for await (const [name, handle] of ch.handle.entries())
      if (handle.kind === 'file' && isImg(name)) imgs.push({name, handle});
    imgs.sort((a,b) => natCmp(a.name, b.name));
    if (!imgs.length) return;
    const file = await imgs[0].handle.getFile();
    setCoverUrl(series, URL.createObjectURL(file));
    const card = getSeriesCard(series.name);
    if (card) { rebuildCoverEl(card, 'local:'+series.name, series, 'local'); }
  };

  // Always try MU first; local page is only used when MU has nothing.
  enqueueMuCover(series, localFallback);
}

// Firefox/Safari fallback
function openLibraryFallback() { $('folder-input').value=''; $('folder-input').click(); }
$('folder-input').addEventListener('change', function() {
  if (this.files && this.files.length) buildLibraryFallback(this.files);
});
async function buildLibraryFallback(fileList) {
  library.items=[];
  const smap={};
  for (const file of fileList) {
    const p=file.webkitRelativePath.split('/');
    if (p.length<3) continue;
    const [,sn]=p;
    if (isPdf(file.name) && p.length===3) {
      // PDF at series level: series/chapter.pdf
      const cn=file.name.replace(/\.pdf$/i,'');
      if (!smap[sn]) smap[sn]={};
      smap[sn][cn]=smap[sn][cn]||[];
      smap[sn][cn].__pdfFile=file;
    } else if (isImg(file.name) && p.length>=4) {
      const cn=p[2];
      if (!smap[sn]) smap[sn]={};
      if (!smap[sn][cn]) smap[sn][cn]=[];
      smap[sn][cn].push({name:file.name, file});
    }
  }
  for (const sn of Object.keys(smap).sort(natCmp)) {
    const chapters = Object.keys(smap[sn]).sort(chapterCmp).map(cn=>{
      const entry = smap[sn][cn];
      if (entry.__pdfFile) {
        const pf = entry.__pdfFile;
        return { name:cn, handle:null, pdfHandle:{getFile:async()=>pf} };
      }
      return { name:cn, handle:makeFallbackDirHandle(entry.sort((a,b)=>natCmp(a.name,b.name))) };
    });
    library.items.push({name:sn, handle:null, chapters, coverUrl:null});
  }
  if (fileList.length) library.rootHandle={name:fileList[0].webkitRelativePath.split('/')[0]};
  renderLibrary(); show('library'); bc('library');
  library.items.forEach(loadCoverFallback);
}
function makeFallbackDirHandle(files) {
  return { entries: async function*() {
    for (const {name,file} of files) yield [name,{kind:'file',getFile:async()=>file}];
  }};
}
async function loadCoverFallback(series) {
  if (!series.chapters.length) return;
  const ch = series.chapters[0];

  const localFallback = async () => {
    if (ch.pdfHandle) {
      try {
        const file = await ch.pdfHandle.getFile();
        const pgs  = await pdfFileToPages(file);
        if (pgs.length) {
          await preloadPdfPage(pgs[0]);
          setCoverUrl(series, pgs[0].url);
          const card = getSeriesCard(series.name);
          if (card) { rebuildCoverEl(card, 'local:'+series.name, series, 'local'); }
        }
      } catch(e) { console.warn('PDF cover error', e); }
      return;
    }
    const imgs = [];
    for await (const [name, handle] of ch.handle.entries())
      if (handle.kind === 'file' && isImg(name)) imgs.push({name, handle});
    imgs.sort((a,b) => natCmp(a.name, b.name));
    if (!imgs.length) return;
    const file = await imgs[0].handle.getFile();
    setCoverUrl(series, URL.createObjectURL(file));
    const card = getSeriesCard(series.name);
    if (card) { rebuildCoverEl(card, 'local:'+series.name, series, 'local'); }
  };

  enqueueMuCover(series, localFallback);
}

function localCoverHTML(s) {
  return `<img src="${esc(s.coverUrl)}" loading="lazy" alt="${esc(s.name)}">`;
}

/**
 * Rebuilds the full contents of a .s-cover element: image/placeholder,
 * info badge, play overlay, bookmark badge, dots button, progress bar.
 * Call this wherever a cover URL changes instead of cover.innerHTML = ...
 */
function rebuildCoverEl(coverEl, key, series, src) {
  coverEl.innerHTML = series.coverUrl
    ? localCoverHTML(series)
    : `<div class="s-cover-ph">📖<small>LOADING</small></div>`;
  const badge = document.createElement('div'); badge.className = 's-badge';
  badge.innerHTML = `<span class="s-badge-ch">${series.chapters.length} CH</span><span class="s-badge-sz">${series.size != null ? formatBytes(series.size) : ''}</span>`;
  coverEl.appendChild(badge);
  attachCardExtras(coverEl, key, series, src);
}

/**
 * Appends (or re-appends after innerHTML wipe) the bookmark badge and ⋮ button
 * to a .s-cover element. Safe to call multiple times — removes old copies first.
 */
function attachCardExtras(coverEl, key, series, src) {
  // Remove stale copies left over from a previous innerHTML assignment
  coverEl.querySelectorAll('.bm-badge, .card-dots-btn').forEach(el => el.remove());

  const bmBadge = document.createElement('span');
  bmBadge.className = 'bm-badge' + (isBookmarked(key) ? ' on' : '');
  bmBadge.innerHTML = `<svg viewBox="0 0 24 24" fill="white" width="11" height="11" xmlns="http://www.w3.org/2000/svg"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;
  coverEl.appendChild(bmBadge);

  const dotsBtn = document.createElement('button');
  dotsBtn.className = 'card-dots-btn';
  dotsBtn.title = 'Options';
  dotsBtn.innerHTML = ICON.dots;
  dotsBtn.onclick = e => {
    e.stopPropagation();
    openCardMenu(e, key, { name: series.name, title: series.name, coverUrl: series.coverUrl }, src, series);
  };
  coverEl.appendChild(dotsBtn);
  // Re-attach progress bar so it survives innerHTML wipes
  const _totalChs = coverEl.closest('[data-card-key]')?.dataset?.totalChs;
  if (_totalChs) attachCardProgressBar(coverEl, coverEl.closest('[data-card-key]').dataset.cardKey, parseInt(_totalChs));
}

// ═══════════════════════════════════════════════════════════════
// READING PROGRESS
// ═══════════════════════════════════════════════════════════════

function saveReadProgress() { saveData('progress.json', readProgress); }

function getChProg(seriesKey, chKey) {
  return readProgress[seriesKey]?.chapters?.[chKey] || null;
}

function setChProg(seriesKey, chKey, page, total, persist = true) {
  if (!readProgress[seriesKey]) readProgress[seriesKey] = { chapters: {} };
  const prev = readProgress[seriesKey].chapters[chKey] || {};
  // In RTL mode page 0 is the last page to read; in LTR it's total-1
  const atEnd = reader.rtl ? page <= 0 : page >= total - 1;
  const read  = prev.read || atEnd;
  readProgress[seriesKey].chapters[chKey] = { page, total, read, updatedAt: Date.now() };
  if (persist) saveReadProgress();
}

function markRead(seriesKey, chKey, total) {
  if (!readProgress[seriesKey]) readProgress[seriesKey] = { chapters: {} };
  readProgress[seriesKey].chapters[chKey] = {
    page: Math.max(0, (total || 1) - 1), total: total || 0,
    read: true, updatedAt: Date.now()
  };
  saveReadProgress();
}

function toggleChRead(seriesKey, chKey, total, btn) {
  const p = getChProg(seriesKey, chKey);
  if (p?.read) {
    // unmark
    if (readProgress[seriesKey]?.chapters?.[chKey]) {
      readProgress[seriesKey].chapters[chKey].read = false;
    }
    saveReadProgress();
    if (btn) { btn.textContent = '○'; btn.closest('.ch-item')?.classList.remove('ch-read'); }
  } else {
    markRead(seriesKey, chKey, total);
    if (btn) { btn.textContent = '✓'; btn.closest('.ch-item')?.classList.add('ch-read'); }
  }
  // refresh card progress bar
  const cover = document.querySelector(`[data-card-key="${CSS.escape(seriesKey)}"] .s-cover`);
  if (cover && library.curSeries?.chapters.length) attachCardProgressBar(cover, seriesKey, library.curSeries.chapters.length);
}

function seriesReadStats(seriesKey, total) {
  const chs = readProgress[seriesKey]?.chapters || {};
  const readCount = Object.values(chs).filter(c => c.read).length;
  return { readCount, pct: total ? readCount / total : 0 };
}

let _saveProgressTimer = null;
function saveCurrentProgress() {
  if (!reader.pages.length || !library.curSeries) return;
  const sKey  = 'local:' + library.curSeries.name;
  const chKey = library.curSeries.chapters[library.curChIdx]?.name;
  if (!chKey) return;
  // persist=false — skip the immediate disk write inside setChProg.
  // The debounced timer below owns the actual disk write so we don't hit
  // storage on every page turn.
  setChProg(sKey, chKey, reader.curPage, reader.pages.length, false);
  const cover = document.querySelector(`[data-card-key="${CSS.escape(sKey)}"] .s-cover`);
  if (cover) attachCardProgressBar(cover, sKey, library.curSeries.chapters.length);
  // Debounce the disk write — in-memory state was updated synchronously above.
  clearTimeout(_saveProgressTimer);
  _saveProgressTimer = setTimeout(() => saveReadProgress(), 1000);
}

/** Returns { idx, page, state } for the continue/start button. */
function findContinueIdx(seriesKey, chapters, getKey) {
  const chs = readProgress[seriesKey]?.chapters || {};
  for (let i = 0; i < chapters.length; i++) {
    const p = chs[getKey(chapters[i])];
    if (p && !p.read && p.page > 0) return { idx: i, page: p.page, state: 'progress' };
  }
  for (let i = 0; i < chapters.length; i++) {
    const p = chs[getKey(chapters[i])];
    if (!p || !p.read) return { idx: i, page: 0, state: 'unread' };
  }
  return { idx: chapters.length - 1, page: 0, state: 'complete' };
}

function renderContinueBtn(wrapEl, labelText, sub, onclickFn) {
  wrapEl.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'continue-btn';
  btn.innerHTML = `▶ ${labelText}<span class="continue-sub">${sub}</span>`;
  btn.onclick = onclickFn;
  wrapEl.appendChild(btn);
}

/** Attaches (or refreshes) the thin progress bar at the bottom of a cover element. */
function attachCardProgressBar(coverEl, seriesKey, totalChs) {
  coverEl.querySelectorAll('.card-progress-bar').forEach(el => el.remove());
  if (!totalChs) return;
  const { pct } = seriesReadStats(seriesKey, totalChs);
  if (pct <= 0) return;
  const bar  = document.createElement('div'); bar.className  = 'card-progress-bar';
  const fill = document.createElement('div'); fill.className = 'card-progress-fill';
  fill.style.width = (pct * 100) + '%';
  bar.appendChild(fill);
  const bm = coverEl.querySelector('.bm-badge');
  bm ? coverEl.insertBefore(bar, bm) : coverEl.appendChild(bar);
}

// Library grid render
/** Updates the folder name and total size in the library toolbar. */
function updateLibraryInfo() {
  const folderEl  = $('lib-folder');
  const folderDot = $('lib-folder-dot');
  const sizeEl    = $('lib-size');
  const sizeDot   = $('lib-size-dot');
  if (!folderEl) return;

  // Folder name
  if (library.rootHandle?.name) {
    folderEl.innerHTML = `FOLDER: <b>${esc(library.rootHandle.name)}</b>`;
    folderDot.style.display = '';
  } else {
    folderEl.innerHTML = '';
    folderDot.style.display = 'none';
  }

  // Total library size — accumulate as individual series sizes load in
  const sized = library.items.filter(s => s.size != null);
  if (!IS_TAURI || !library.items.length) {
    sizeEl.innerHTML = '';
    sizeDot.style.display = 'none';
  } else if (!sized.length) {
    sizeEl.innerHTML = `SIZE: <b>---</b>`;
    sizeDot.style.display = '';
  } else {
    const total  = sized.reduce((sum, s) => sum + s.size, 0);
    const approx = sized.length < library.items.length ? '~' : '';
    sizeEl.innerHTML = `SIZE: <b>${approx}${formatBytes(total)}</b>`;
    sizeDot.style.display = '';
  }
}

// ═══════════════════════════════════════════════════════════════
// LIBRARY SORT
// ═══════════════════════════════════════════════════════════════

/** Returns the number of distinct volumes in a series (min 1 if chapters exist). */
function getVolumeCount(s) {
  const vols = new Set();
  for (const ch of s.chapters) {
    const [v] = parseChapterKey(ch.name);
    if (v > 0) vols.add(v);
  }
  return vols.size || (s.chapters.length > 0 ? 1 : 0);
}

/** Sorts a list of series in-place according to the current ui.libSort value. */
function applySortToList(list) {
  switch (ui.libSort) {
    case 'za':
      list.sort((a, b) => natCmp(b.name, a.name));
      break;
    case 'size-asc':
      list.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
      break;
    case 'size-desc':
      list.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
      break;
    case 'vol-asc':
      list.sort((a, b) => getVolumeCount(a) - getVolumeCount(b) || natCmp(a.name, b.name));
      break;
    case 'vol-desc':
      list.sort((a, b) => getVolumeCount(b) - getVolumeCount(a) || natCmp(a.name, b.name));
      break;
    case 'ch-asc':
      list.sort((a, b) => a.chapters.length - b.chapters.length || natCmp(a.name, b.name));
      break;
    case 'ch-desc':
      list.sort((a, b) => b.chapters.length - a.chapters.length || natCmp(a.name, b.name));
      break;
    default: // 'az'
      list.sort((a, b) => natCmp(a.name, b.name));
  }
  return list;
}

function setLibSort(val) {
  ui.libSort = val;
  patchSettings({ libSort: val });
  renderLibrary($('search')?.value || '');
}

// ═══════════════════════════════════════════════════════════════
// MULTI-SELECT + TRASH
// ═══════════════════════════════════════════════════════════════

function toggleSelectMode() {
  ui.selectMode = !ui.selectMode;
  if (!ui.selectMode) {
    ui.selectedSeries.clear();
  }
  document.body.classList.toggle('select-active', ui.selectMode);
  const btn = $('lib-select-btn');
  if (btn) {
    btn.textContent = ui.selectMode ? 'CANCEL' : 'SELECT';
    btn.classList.toggle('on', ui.selectMode);
  }
  _updateTrashBar();
  renderLibrary($('search')?.value || '');
}

function toggleSeriesSelect(name) {
  if (ui.selectedSeries.has(name)) ui.selectedSeries.delete(name);
  else ui.selectedSeries.add(name);
  _updateTrashBar();
  // Update the visual state of just this card without full re-render
  const card = document.querySelector(`.series-card[data-series="${CSS.escape(name)}"]`);
  if (card) card.classList.toggle('selected', ui.selectedSeries.has(name));
}

function _updateTrashBar() {
  const bar   = $('trash-action-bar');
  const count = $('trash-select-count');
  if (!bar) return;
  const n = ui.selectedSeries.size;
  bar.style.display = ui.selectMode ? 'flex' : 'none';
  if (count) count.textContent = n === 0 ? 'SELECT SERIES TO MOVE'
    : n === 1 ? '1 SERIES SELECTED'
    : `${n} SERIES SELECTED`;
  const moveBtn = $('trash-move-btn');
  if (moveBtn) moveBtn.disabled = n === 0;
}

async function moveSelectedToTrash() {
  if (!ui.selectedSeries.size || !library.rootHandle?._path) return;
  const btn = $('trash-move-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'MOVING…'; }

  const sep       = library.rootHandle._path.includes('\\') ? '\\' : '/';
  const trashPath = library.rootHandle._path + sep + '_trash';
  const names     = [...ui.selectedSeries];
  const failed    = [];

  for (const name of names) {
    const series = library.items.find(s => s.name === name);
    if (!series?.path) continue;
    try {
      await invoke('move_to_trash_folder', {
        seriesPath:  series.path,
        libraryPath: library.rootHandle._path,
      });
      library.items = library.items.filter(s => s.name !== name);
    } catch(e) {
      console.error('[trash] failed to move', name, e);
      failed.push(name);
    }
  }

  ui.selectedSeries.clear();
  toggleSelectMode(); // exits select mode, hides bar, re-renders
  if (failed.length) {
    showWatcherToast(`Moved to trash — ${failed.length} failed: ${failed.join(', ')}`);
  } else {
    showWatcherToast(`Moved ${names.length} series to _trash`);
  }

  if (btn) { btn.textContent = 'MOVE TO TRASH'; }
}

function openTrashFolder() {
  if (!library.rootHandle?._path) return;
  const sep       = library.rootHandle._path.includes('\\') ? '\\' : '/';
  const trashPath = library.rootHandle._path + sep + '_trash';
  invoke('open_folder_path', { path: trashPath }).catch(() => {
    showWatcherToast('Trash folder not found — nothing moved to trash yet');
  });
}

function renderLibrary(q='') {
  const fl = q.trim().toLowerCase();
  let list = fl ? library.items.filter(s => s.name.toLowerCase().includes(fl)) : [...library.items];
  // Apply tab filter
  if (ui.activeTab === 'bookmarks') list = list.filter(s => isBookmarked('local:' + s.name));
  // Apply genre filter — series must have at least one of the selected genres
  if (ui.activeGenres.size) {
    list = list.filter(s => (s.muInfo?.genres || []).some(g => ui.activeGenres.has(g)));
  }
  // Apply sort
  applySortToList(list);

  $('lib-count').innerHTML = ui.activeTab === 'bookmarks'
    ? `<b>${list.length}</b> BOOKMARKED`
    : `<b>${list.length}</b> SERIES`;
  updateLibraryInfo();

  // Sync sort dropdown to current value
  const sortEl = $('lib-sort-select');
  if (sortEl && sortEl.value !== ui.libSort) sortEl.value = ui.libSort;

  // Sync trash bar visibility
  _updateTrashBar();

  const grid=$('series-grid'); grid.innerHTML='';
  if (!list.length) {
    const emptyIcon = ui.activeTab === 'bookmarks' ? ICON.bookmark : ICON.identify;
    grid.innerHTML=`<div class="empty" style="grid-column:1/-1"><div class="ei">${emptyIcon}</div>NO RESULTS</div>`;
    return;
  }
  const doStagger = ui.freshLoad;
  ui.freshLoad = false; // consumed — subsequent renders (filter, back nav) skip stagger

  list.forEach((s, idx)=>{
    const key = 'local:'+s.name;
    const card=document.createElement('div');
    card.className='series-card' + (ui.selectMode && ui.selectedSeries.has(s.name) ? ' selected' : '');
    card.dataset.series=s.name; card.dataset.cardKey=key; card.dataset.totalChs=s.chapters.length;
    // In select mode, clicking toggles selection instead of opening series
    if (ui.selectMode) {
      card.onclick = () => toggleSeriesSelect(s.name);
    } else {
      card.onclick = () => openSeries(s);
    }
    if (doStagger) card.style.animationDelay = `${Math.min(idx, 24) * 0.03}s`;
    const cover=document.createElement('div'); cover.className='s-cover';
    cover.innerHTML=s.coverUrl?localCoverHTML(s):`<div class="s-cover-ph">📖<small>LOADING</small></div>`;
    // Badge pinned to bottom of cover image
    const badge=document.createElement('div'); badge.className='s-badge';
    badge.innerHTML=`<span class="s-badge-ch">${s.chapters.length} CH</span><span class="s-badge-sz">${s.size!=null?formatBytes(s.size):''}</span>`;
    cover.appendChild(badge);
    // Select mode checkmark overlay
    if (ui.selectMode) {
      const chk=document.createElement('div'); chk.className='select-check';
      chk.innerHTML='✓';
      cover.appendChild(chk);
    } else {
      attachCardExtras(cover, key, s, 'local');
    }
    attachCardProgressBar(cover, key, s.chapters.length);
    const name=document.createElement('div'); name.className='s-name'; name.textContent=s.name;
    card.appendChild(cover); card.appendChild(name); grid.appendChild(card);
  });
}

/**
 * Rebuilds the genre dropdown panel from all MU genres currently loaded
 * across the library. Shows the trigger button once any genre exists.
 * Called after each series' MU info resolves and on library load/clear.
 */
function renderGenreBar() {
  const bar  = $('genre-bar');
  const wrap = $('genre-dropdown-wrap');
  if (!bar || !wrap) return;

  // Collect every unique genre present in loaded muInfo across the library
  const allGenres = new Set();
  library.items.forEach(s => { if (s.muInfo?.genres) s.muInfo.genres.forEach(g => allGenres.add(g)); });

  if (!allGenres.size) {
    bar.innerHTML = '';
    bar.classList.remove('open');
    $('genre-dropdown-btn')?.classList.remove('open');
    wrap.style.display = 'none';
    return;
  }

  wrap.style.display = '';

  // Update active-count badge on the trigger button
  const badge = $('genre-active-count');
  if (badge) {
    badge.textContent = ui.activeGenres.size || '';
    badge.style.display = ui.activeGenres.size ? '' : 'none';
  }

  bar.innerHTML = '';

  // Alphabetical order so the list is stable as more series load in
  [...allGenres].sort().forEach(g => {
    const pill = document.createElement('button');
    pill.className = 'genre-pill' + (ui.activeGenres.has(g) ? ' on' : '');
    pill.textContent = g;
    pill.onclick = () => toggleGenre(g);
    bar.appendChild(pill);
  });

  // Clear button — only shown when at least one genre is active
  if (ui.activeGenres.size) {
    const clear = document.createElement('button');
    clear.className = 'genre-clear';
    clear.textContent = '✕ CLEAR ALL';
    clear.onclick = () => { ui.activeGenres.clear(); renderGenreBar(); renderLibrary($('search').value); };
    bar.appendChild(clear);
  }
}

function toggleGenre(g) {
  if (ui.activeGenres.has(g)) ui.activeGenres.delete(g);
  else ui.activeGenres.add(g);
  renderGenreBar();
  renderLibrary($('search').value);
}

function toggleGenreDropdown() {
  const bar = $('genre-bar');
  const btn = $('genre-dropdown-btn');
  if (!bar || !btn) return;
  const opening = !bar.classList.contains('open');
  bar.classList.toggle('open', opening);
  btn.classList.toggle('open', opening);
  if (opening) {
    // Close the dropdown when the user clicks anywhere outside it
    setTimeout(() => {
      document.addEventListener('click', function _closeGenre(e) {
        if (!bar.contains(e.target) && !btn.contains(e.target)) {
          bar.classList.remove('open');
          btn.classList.remove('open');
          document.removeEventListener('click', _closeGenre);
        }
      });
    }, 0);
  }
}

// ── Local search with preview strip ──
let _searchFocused = false;

$('search').oninput = e => {
  const q = e.target.value;
  $('search-clear').classList.toggle('show', q.length > 0);
  renderLibrary(q);
  if (_searchFocused) renderSearchOverlay(q);
};
$('search').addEventListener('focus', () => {
  _searchFocused = true;
  renderSearchOverlay($('search').value);
});
$('search').addEventListener('blur', () => {
  setTimeout(() => {
    if (!$('search-preview').matches(':hover')) {
      _searchFocused = false;
      $('search-preview').classList.remove('show');
    }
  }, 180);
});
$('search-preview')?.addEventListener('mousedown', e => e.preventDefault());

function clearSearch() {
  $('search').value = '';
  $('search-clear').classList.remove('show');
  $('search-preview').classList.remove('show');
  _searchFocused = false;
  renderLibrary('');
  $('search').focus();
}

function _statusBadgeClass(status) {
  if (!status) return '';
  const s = status.toLowerCase();
  if (s.includes('complete')) return 'complete';
  if (s.includes('hiatus'))   return 'hiatus';
  if (s.includes('cancel'))   return 'cancelled';
  if (s.includes('ongoing'))  return 'ongoing';
  return '';
}

function renderSearchOverlay(q) {
  const prev = $('search-preview');
  const fl = q.trim().toLowerCase();

  if (!fl) {
    prev.innerHTML = `<div class="search-prompt">Enter a search query…</div>`;
    prev.classList.add('show');
    return;
  }

  const hits = library.items.filter(s => s.name.toLowerCase().includes(fl));

  if (!hits.length) {
    prev.innerHTML = `<div class="search-prompt">No results for "<strong>${esc(q)}</strong>"</div>`;
    prev.classList.add('show');
    return;
  }

  // Reuse existing DOM where possible — only rebuild if the hit count changed
  // so we avoid thrashing the layout on every keystroke.
  const displayed = hits.slice(0, 12);
  const existingRows = prev.querySelectorAll('.search-result-row');

  if (existingRows.length !== displayed.length || !prev.querySelector('.search-section-hdr')) {
    // Structure changed — full rebuild
    prev.innerHTML = '';
    const hdr = document.createElement('div');
    hdr.className = 'search-section-hdr';
    hdr.innerHTML = `<span>Manga</span><span class="search-section-arrow">→</span>`;
    prev.appendChild(hdr);
    displayed.forEach(s => prev.appendChild(_buildSearchRow(s)));
  } else {
    // Same number of results — update existing rows in place
    displayed.forEach((s, i) => _updateSearchRow(existingRows[i], s));
  }

  prev.classList.add('show');
}

function _buildSearchRow(s) {
  const mu = s.muInfo;
  const row = document.createElement('div');
  row.className = 'search-result-row';
  row.onclick = () => { $('search-preview').classList.remove('show'); _searchFocused = false; openSeries(s); };

  const cover = document.createElement('div');
  cover.className = 'search-result-cover';
  if (s.coverUrl) { const img = document.createElement('img'); img.src = s.coverUrl; img.alt = ''; cover.appendChild(img); }
  else { cover.textContent = '📖'; }

  const meta = document.createElement('div');
  meta.className = 'search-result-meta';

  const title = document.createElement('div');
  title.className = 'search-result-title';
  title.textContent = s.name;

  const stats = document.createElement('div');
  stats.className = 'search-result-stats';
  if (mu?.rating) { const r = document.createElement('span'); r.className = 'search-result-stat'; r.textContent = `★ ${mu.rating}`; stats.appendChild(r); }
  const ch = document.createElement('span'); ch.className = 'search-result-stat'; ch.textContent = `${s.chapters.length} CH`; stats.appendChild(ch);

  const bottomRow = document.createElement('div');
  bottomRow.className = 'search-result-bottom';
  bottomRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';
  if (mu?.status) {
    const badge = document.createElement('span');
    badge.className = `search-result-badge ${_statusBadgeClass(mu.status)}`;
    badge.textContent = mu.status;
    bottomRow.appendChild(badge);
  }

  meta.appendChild(title); meta.appendChild(stats); meta.appendChild(bottomRow);
  row.appendChild(cover); row.appendChild(meta);
  return row;
}

function _updateSearchRow(row, s) {
  const mu = s.muInfo;
  // Update cover
  const cover = row.querySelector('.search-result-cover');
  if (cover) {
    const img = cover.querySelector('img');
    if (s.coverUrl) {
      if (img) { img.src = s.coverUrl; }
      else { cover.innerHTML = ''; const i = document.createElement('img'); i.src = s.coverUrl; i.alt = ''; cover.appendChild(i); }
    } else { cover.innerHTML = '📖'; }
  }
  // Update title
  const title = row.querySelector('.search-result-title');
  if (title) title.textContent = s.name;
  // Update onclick
  row.onclick = () => { $('search-preview').classList.remove('show'); _searchFocused = false; openSeries(s); };
  // Update stats
  const stats = row.querySelector('.search-result-stats');
  if (stats) {
    stats.innerHTML = '';
    if (mu?.rating) { const r = document.createElement('span'); r.className = 'search-result-stat'; r.textContent = `★ ${mu.rating}`; stats.appendChild(r); }
    const ch = document.createElement('span'); ch.className = 'search-result-stat'; ch.textContent = `${s.chapters.length} CH`; stats.appendChild(ch);
  }
  // Update badge
  const bottomRow = row.querySelector('.search-result-bottom');
  if (bottomRow) {
    bottomRow.innerHTML = '';
    if (mu?.status) {
      const badge = document.createElement('span');
      badge.className = `search-result-badge ${_statusBadgeClass(mu.status)}`;
      badge.textContent = mu.status;
      bottomRow.appendChild(badge);
    }
  }
}

/** Updates the blurred cover image used as the hero background. */
function _updateHeroBg(coverUrl) {
  const bg = $('ch-hero-bg');
  if (!bg) return;
  bg.style.backgroundImage = coverUrl ? `url("${coverUrl.replace(/"/g, '\\"')}")` : '';
}

// Local series → chapter list
/**
 * Inspects CBZ and PDF chapters in a series and, when pagesPerChapter > 0,
 * replaces flat single-file chapters with an array of virtual page-range
 * chapters. Mutates series.chapters in place. Safe to call multiple times —
 * already-expanded chapters (those with a _virtual flag) are skipped.
 */
async function _expandVirtualChapters(series) {
  const ppc = userSettings.pagesPerChapter;
  if (!ppc || ppc <= 0) return;

  const expanded = [];
  for (const ch of series.chapters) {
    if (ch._virtual) { expanded.push(ch); continue; } // already split

    if (ch.isCbz && ch.cbzPath) {
      let entries;
      try { entries = await invoke('read_cbz_entries', { path: ch.cbzPath }); }
      catch(e) { expanded.push(ch); continue; }

      // Only split if flat (no subfolder separators in entry names)
      const isFlat = entries.every(e => !e.includes('/') || e.split('/').length <= 2);
      if (!isFlat || entries.length <= ppc) { expanded.push(ch); continue; }

      for (let i = 0; i < entries.length; i += ppc) {
        const slice = entries.slice(i, i + ppc);
        const start = i + 1, end = Math.min(i + ppc, entries.length);
        expanded.push({
          name:       `${ch.name} — p.${start}–${end}`,
          isCbz:      true,
          cbzPath:    ch.cbzPath,
          cbzEntries: slice,
          _virtual:   true,
        });
      }
    } else if (ch.isPdf && ch.pdfPath) {
      let total;
      try { total = await invoke('count_pdf_pages', { path: ch.pdfPath }); }
      catch(e) { expanded.push(ch); continue; }

      if (total <= ppc) { expanded.push(ch); continue; }

      for (let i = 0; i < total; i += ppc) {
        const startPage = i + 1;
        const endPage   = Math.min(i + ppc, total);
        expanded.push({
          name:         `${ch.name} — p.${startPage}–${endPage}`,
          isPdf:        true,
          pdfPath:      ch.pdfPath,
          pdfStartPage: startPage,
          pdfEndPage:   endPage,
          _virtual:     true,
        });
      }
    } else {
      expanded.push(ch);
    }
  }
  series.chapters = expanded;
}

async function openSeries(series) {
  // Forward navigation — any accumulated back/forward history is now stale.
  ui.navHistory.length = 0;
  library.curSeries = series; show('chapters'); bc('chapters');
  $('stitle').textContent = series.name;
  $('sstat').innerHTML = `<b>${series.chapters.length}</b> <span style="color:var(--text-muted)">CHAPTERS</span>`;
  $('hero').innerHTML = series.coverUrl ? `<img src="${esc(series.coverUrl)}" alt="">` : '📖';
  _updateHeroBg(series.coverUrl);

  // Reset MU meta
  $('mu-meta').style.display    = 'none';
  $('mu-fetching').style.display = 'none';
  $('mu-author').textContent  = '';
  $('mu-status').innerHTML  = '';
  $('mu-desc').textContent    = '';
  $('mu-genres').innerHTML    = '';
  $('mu-link').removeAttribute('href');
  const folderEl = $('hero-open-folder');
  if (folderEl) folderEl.style.display = (IS_TAURI && series.path) ? '' : 'none';

  const sKey = 'local:' + series.name;

  // Continue / progress button
  const { readCount, pct } = seriesReadStats(sKey, series.chapters.length);
  const localCW = $('local-continue-wrap'); localCW.innerHTML = '';
  if (series.chapters.length) {
    const { idx: contIdx, page: contPage, state: contState } = findContinueIdx(sKey, series.chapters, ch => ch.name);
    const contCh    = series.chapters[contIdx];
    const contLabel = contState === 'complete' ? '↩ REREAD' : contState === 'progress' ? 'CONTINUE' : 'START READING';
    const contSub   = contState === 'progress' ? ` — Ch.${contIdx + 1} · p.${contPage + 1}` : '';
    renderContinueBtn(localCW, contLabel, contSub, () => openLocalChapter(contIdx));
    if (readCount > 0) {
      const row = document.createElement('div'); row.className = 'series-prog-row';
      row.innerHTML = `<div class="series-prog-bar"><div class="series-prog-fill" style="width:${pct*100}%"></div></div><span class="series-prog-txt">${readCount} / ${series.chapters.length} READ</span>`;
      localCW.appendChild(row);
    }
  }

  renderChapterList(series, sKey);

  // Fetch MangaUpdates
  const cached = Object.prototype.hasOwnProperty.call(muCache, series.name) ? muCache[series.name] : undefined;
  if (cached === undefined) $('mu-fetching').style.display = '';
  fetchMuInfo(series.name).then(info => {
    if (library.curSeries !== series) return;
    $('mu-fetching').style.display = 'none';
    if (!info) return;
    applyMuInfoToPanel(info, series, !coverIndex[series.name]);
  });
}

function toggleChSort() {
  ui.chSortAsc = !ui.chSortAsc;
  const btn = $('ch-sort-btn');
  if (btn) {
    btn.textContent = ui.chSortAsc ? '↑ ASC' : '↓ DESC';
    btn.classList.toggle('desc', !ui.chSortAsc);
  }
  if (library.curSeries) renderChapterList(library.curSeries, 'local:' + library.curSeries.name);
}

/** Renders the chapter list with volume group headers */
// ─── Chapter split ──────────────────────────────────────────────────────────

let _splitTarget = null; // { series, ch, chIdx, isPdf, totalPages }

/**
 * Opens the split modal. For PDFs, fetches the total page count and shows
 * the range editor. For CBZ, shows the pages-per-chapter input.
 */
async function openSplitModal(series, ch, chIdx) {
  _splitTarget = { series, ch, chIdx };
  $('split-ch-name').textContent = ch.name;

  if (ch.isPdf && ch.pdfPath) {
    let total = 0;
    try { total = await invoke('count_pdf_pages', { path: ch.pdfPath }); } catch(e) {}
    _splitTarget.totalPages = total;
    $('split-ch-total').textContent = total ? `${total} pages total` : '— pages total';
    _renderRangeRows([{ name: 'Chapter 1', start: 1, end: total || '' }], 'p.');
  } else if (ch.isCbz && ch.cbzPath) {
    // CBZ: fetch entries, use entry indices as the range unit
    let entries = [];
    try { entries = await invoke('read_cbz_entries', { path: ch.cbzPath }); } catch(e) {}
    _splitTarget.cbzEntries = entries;
    $('split-ch-total').textContent = entries.length ? `${entries.length} images total` : '— images total';
    _renderRangeRows([{ name: 'Chapter 1', start: 1, end: entries.length || '' }], 'img.');
  }

  $('split-pdf-panel').style.display = '';
  $('split-ch-modal').classList.add('open');
}

function closeSplitModal() {
  $('split-ch-modal').classList.remove('open');
  _splitTarget = null;
}

/** Renders the list of range input rows inside the PDF panel.
 * label — unit label shown between the inputs (e.g. "p." or "img.")
 */
function _renderRangeRows(rows, label = "p.") {
  $("split-range-unit-lbl").textContent = label;
  const list = $('split-ranges-list');
  list.innerHTML = '';
  rows.forEach((r, idx) => {
    const card = document.createElement('div');
    card.className = 'split-range-card';
    card.dataset.idx = idx;
    card.innerHTML =
      `<input class="modal-input split-range-name" type="text" placeholder="Chapter name…" value="${esc(r.name || '')}">`+
      `<div class="split-range-fields">`+
        `<span class="split-range-unit">${label}</span>`+
        `<span class="split-range-lbl">START</span>`+
        `<input class="modal-input split-range-num" type="number" min="1" placeholder="1" value="${r.start || ''}">`+
        `<span class="split-range-sep">→</span>`+
        `<span class="split-range-lbl">END</span>`+
        `<input class="modal-input split-range-num" type="number" min="1" placeholder="—" value="${r.end || ''}">`+
      `</div>`+
      `<button class="split-range-del" title="Remove">✕</button>`;
    card.querySelector('.split-range-del').addEventListener('click', () => {
      card.remove();
    });
    list.appendChild(card);
  });
}

/** Reads current row values from the range editor. */
function _readRangeRows() {
  return [...$('split-ranges-list').querySelectorAll('.split-range-card')].map(row => ({
    name:  row.querySelector('.split-range-name').value.trim(),
    start: parseInt(row.querySelectorAll('input[type=number]')[0].value),
    end:   parseInt(row.querySelectorAll('input[type=number]')[1].value),
  }));
}

/** Adds a blank row to the range editor, pre-filling start from the last row's end+1. */
function _addRangeRow() {
  const rows = _readRangeRows();
  const lastEnd = rows.length ? (rows[rows.length - 1].end || 0) : 0;
  // totalPages for PDF, cbzEntries.length for CBZ
  const total = _splitTarget?.totalPages || _splitTarget?.cbzEntries?.length || '';
  const currentLabel = $('split-range-unit-lbl')?.textContent || 'p.';
  _renderRangeRows([...rows, {
    name:  `Chapter ${rows.length + 1}`,
    start: lastEnd + 1,
    end:   total,
  }], currentLabel);
  // Scroll to bottom and focus the new name field
  const list = $('split-ranges-list');
  list.scrollTop = list.scrollHeight;
  list.querySelector('.split-range-card:last-child .split-range-name')?.focus();
}

async function confirmSplit() {
  if (!_splitTarget) return;
  const { series, ch, chIdx } = _splitTarget;

  const rows = _readRangeRows();
  if (!rows.length) return;
  const invalid = rows.some(r => !r.name || isNaN(r.start) || isNaN(r.end) || r.start < 1 || r.end < r.start);
  if (invalid) {
    $('split-ranges-list').querySelectorAll('.split-range-card').forEach((row, i) => {
      const r = rows[i];
      if (!r.name || isNaN(r.start) || isNaN(r.end) || r.start < 1 || r.end < r.start)
        row.style.outline = '1px solid var(--status-error)';
    });
    return;
  }
  closeSplitModal();

  let virtual = [];
  if (ch.isPdf && ch.pdfPath) {
    virtual = rows.map(r => ({
      name:         r.name,
      isPdf:        true,
      pdfPath:      ch.pdfPath,
      pdfStartPage: r.start,
      pdfEndPage:   r.end,
      _virtual:     true,
      _parentName:  ch.name,
    }));
  } else if (ch.isCbz && ch.cbzPath) {
    const entries = _splitTarget.cbzEntries || [];
    virtual = rows.map(r => ({
      name:        r.name,
      isCbz:       true,
      cbzPath:     ch.cbzPath,
      cbzEntries:  entries.slice(r.start - 1, r.end),
      _virtual:    true,
      _parentName: ch.name,
    }));
  }

  if (!virtual.length) return;
  series.chapters.splice(chIdx, 1, ...virtual);
  renderChapterList(series, 'local:' + series.name);
}



function renderChapterList(series, sKey) {
  const list = $('ch-list'); list.innerHTML = '';
  if (!series.chapters.length) {
    list.innerHTML = `<div class="empty"><div class="ei"></div>NO CHAPTERS FOUND</div>`;
    return;
  }

  // Group by volume; cache parsed keys alongside each entry so the per-item
  // render below doesn't need to call parseChapterKey a second time.
  const volMap = new Map();
  series.chapters.forEach((ch, i) => {
    const parsed = parseChapterKey(ch.name);
    const key = parsed[0] > 0 ? parsed[0] : 0;
    if (!volMap.has(key)) volMap.set(key, []);
    volMap.get(key).push({ ch, i, parsed });
  });

  // Sort volumes numerically; vol=0 (no volume prefix) goes last since those
  // are typically the latest ungrouped chapters rather than the earliest ones.
  const volKeys = [...volMap.keys()].sort((a, b) => {
    if (ui.chSortAsc) {
      if (a === 0) return 1;
      if (b === 0) return -1;
      return a - b;
    } else {
      if (a === 0) return -1;
      if (b === 0) return 1;
      return b - a;
    }
  });

  // Update toolbar range label: "Ch. 1 – 40 · 40"
  const rangeEl = $('ch-toolbar-range');
  if (rangeEl && series.chapters.length) {
    // Reuse the parsed values already stored in volMap — no need to re-parse.
    const allChNums = [...volMap.values()]
      .flatMap(entries => entries.map(e => e.parsed[1]))
      .filter(Number.isFinite);
    if (allChNums.length) {
      const minCh = Math.min(...allChNums);
      const maxCh = Math.max(...allChNums);
      const fmt = n => n % 1 === 0 ? String(n) : n.toFixed(1);
      rangeEl.textContent = minCh === maxCh ? `Ch. ${fmt(minCh)} · ${series.chapters.length}` : `Ch. ${fmt(minCh)} – ${fmt(maxCh)} · ${series.chapters.length}`;
    }
  }

  volKeys.forEach(vol => {
    const rawEntries = volMap.get(vol);
    const entries = ui.chSortAsc ? rawEntries : [...rawEntries].reverse();
    const firstNum = entries[0].parsed[1];
    const lastNum  = entries[entries.length - 1].parsed[1];
    const fmtNum   = n => Number.isFinite(n) ? (n % 1 === 0 ? String(n) : n.toFixed(1)) : '?';
    const chRange  = entries.length > 1
      ? `Ch. ${fmtNum(firstNum)} – ${fmtNum(lastNum)}`
      : `Ch. ${fmtNum(firstNum)}`;

    const group = document.createElement('div');
    group.className = 'vol-group';

    const header = document.createElement('div');
    header.className = 'vol-header';
    header.innerHTML = `
      <span class="vol-header-label">${vol > 0 ? `Volume ${vol}` : 'Chapters'}</span>
      <span class="vol-header-range">${esc(chRange)}</span>
      <span class="vol-header-count">${entries.length}</span>
      <span class="vol-chevron">▲</span>`;
    header.onclick = () => group.classList.toggle('collapsed');
    group.appendChild(header);

    entries.forEach(({ ch, i, parsed }) => {
      const p       = getChProg(sKey, ch.name);
      const isRead  = p?.read;
      const inProg  = p && !p.read && p.page > 0;

      const chNum = parsed[1];
      const chStr = Number.isFinite(chNum) && chNum >= 0
        ? (chNum % 1 === 0 ? String(chNum) : chNum.toFixed(1))
        : String(i + 1);
      const label = vol > 0 ? `V${vol} CH ${chStr}` : `CH ${chStr}`;
      const title = cleanChTitle(ch.name) || (Number.isFinite(chNum) && chNum >= 0 ? `Chapter ${chStr}` : `Chapter ${i + 1}`);
      const group_ = extractGroup(ch.name);

      const item = document.createElement('div');
      item.className = 'ch-item' + (isRead ? ' ch-read' : '') + (inProg ? ' ch-in-progress' : '');
      item.innerHTML = `
        <span class="ch-num">${esc(label)}</span>
        <div class="ch-text">
          <div class="ch-title-text">${esc(title)}</div>
          <div class="ch-sub">${group_ ? esc(group_) + ' · ' : ''}<span class="ch-pg-count">—</span> pgs</div>
        </div>
        <div class="ch-top-right">
          ${inProg ? `<span class="ch-prog-badge">p.${p.page + 1}</span>` : ''}
          ${isRead ? `<span class="ch-read-badge read-done">✓ read</span>` : ''}
          <span class="ch-read-dot"></span>
          <button class="ch-mark-btn" title="Toggle read">${isRead ? '✓' : '○'}</button>
          ${(ch.isCbz || ch.isPdf) && !ch._virtual ? `<button class="ch-dots-btn" title="Split into chapters">⋯</button>` : ''}
          <span class="ch-arr">▶</span>
        </div>`;

      const markBtn = item.querySelector('.ch-mark-btn');
      markBtn.onclick = e => { e.stopPropagation(); toggleChRead(sKey, ch.name, ch._pageCount ?? null, markBtn); };
      const dotsBtn = item.querySelector('.ch-dots-btn');
      if (dotsBtn) dotsBtn.onclick = e => { e.stopPropagation(); openSplitModal(series, ch, i); };
      item.onclick = () => openLocalChapter(i);
      group.appendChild(item);
      // Capture the span directly — avoids a stale id lookup if the list is
      // re-rendered before the async countPages() promise resolves.
      const pgCountEl = item.querySelector('.ch-pg-count');
      countPages(ch).then(n => { pgCountEl.textContent = n; });
    });

    list.appendChild(group);
  });
}
async function countPages(ch) {
  // Return the cached value if we've counted this chapter before.
  if (ch._pageCount !== undefined) return ch._pageCount;
  let n = 0;
  if (ch.pdfHandle) {
    try {
      const file = await ch.pdfHandle.getFile();
      const ab = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: ab }).promise;
      n = doc.numPages;
    } catch(e) { n = 0; }
  } else if (IS_TAURI && ch.isCbz && ch.cbzPath) {
    try {
      const cbzPages = await invoke('read_cbz_entries', { path: ch.cbzPath });
      n = cbzPages.length;
    } catch(e) { n = 0; }
  } else if (IS_TAURI && ch.isPdf && ch.pdfPath) {
    try {
      // count_pdf_pages scans bytes in Rust — no base64 roundtrip needed.
      n = await invoke('count_pdf_pages', { path: ch.pdfPath });
    } catch(e) { n = 0; }
  } else if (IS_TAURI && ch.path) {
    try {
      const entries = await invoke('read_dir', { path: ch.path });
      n = entries.filter(e => !e.is_dir && isImg(e.name)).length;
    } catch(e) { n = 0; }
  } else if (ch.handle) {
    for await (const [nm, hh] of ch.handle.entries()) if (hh.kind==='file' && isImg(nm)) n++;
  }
  ch._pageCount = n;
  return n;
}


// ═══════════════════════════════════════════════════════════════
// CARD CONTEXT MENU
// ═══════════════════════════════════════════════════════════════

let _cardMenuTarget = null; // { key, data, src, series }

function openCardMenu(e, key, data, src, series) {
  e.stopPropagation();
  const menu = $('card-ctx-menu');
  // Toggle: if this card's menu is already open, close it.
  if (menu.style.display === 'flex' && _cardMenuTarget?.key === key) {
    closeCardMenu();
    return;
  }
  _cardMenuTarget = { key, data, src, series };
  const bmBtn = $('ctx-bookmark-btn');
  bmBtn.innerHTML = `${ICON.bookmark} ${isBookmarked(key) ? 'UNBOOKMARK' : 'BOOKMARK'}`;
  document.querySelectorAll('.ctx-local-only').forEach(el => el.style.display = src === 'local' ? '' : 'none');
  // Show RESET COVER only when a custom cover has been set for this series
  const hasCustomCover = series && coverIndex[series.name]?.custom;
  const resetBtn = $('ctx-cover-reset-btn');
  if (resetBtn) resetBtn.style.display = (src === 'local' && hasCustomCover) ? '' : 'none';
  $('ctx-title').textContent = (data.title || data.name || 'SERIES').toUpperCase().slice(0, 28);
  // Position near button
  const rect = e.currentTarget.getBoundingClientRect();
  menu.style.display = 'flex';
  menu.classList.remove('open');
  requestAnimationFrame(() => menu.classList.add('open'));
  const mw = menu.offsetWidth || 170;
  let left = rect.right - mw;
  if (left < 4) left = 4;
  menu.style.top  = (rect.bottom + 4) + 'px';
  menu.style.left = left + 'px';
  setTimeout(() => document.addEventListener('click', closeCardMenu, { once: true }), 0);
}

function closeCardMenu() {
  const m = $('card-ctx-menu'); if (m) m.style.display = 'none';
}

function ctxBookmark() {
  if (!_cardMenuTarget) return;
  const { key, data, src } = _cardMenuTarget;
  if (isBookmarked(key)) {
    delete bookmarks[key];
  } else {
    bookmarks[key] = { key, title: data.title || data.name, coverUrl: data.coverUrl || null, src };
  }
  saveBookmarks();
  // Refresh badge on card
  const card = document.querySelector(`[data-card-key="${CSS.escape(key)}"]`);
  if (card) { const b = card.querySelector('.bm-badge'); if (b) b.classList.toggle('on', isBookmarked(key)); }
  // If viewing the bookmarks tab, re-render so the card appears/disappears immediately
  if (ui.activeTab === 'bookmarks') renderLibrary($('search').value);
  closeCardMenu();
}

function ctxIdentify() {
  if (!_cardMenuTarget) return;
  openIdentifyModal(_cardMenuTarget.series || { name: _cardMenuTarget.data.name || _cardMenuTarget.data.title });
  closeCardMenu();
}

async function ctxSetCover() {
  if (!_cardMenuTarget?.series || !IS_TAURI) return;
  const series = _cardMenuTarget.series;
  closeCardMenu();

  const srcPath = await invoke('pick_image_file').catch(() => null);
  if (!srcPath) return;

  try {
    const cachedPath = await invoke('cache_custom_cover', {
      seriesName: series.name,
      srcPath,
    });
    const url = convertFileSrc(cachedPath);

    // Store as custom override — _applyCover will skip this series
    coverIndex[series.name] = { cachedPath, custom: true };
    saveCoverIndex();

    // Apply immediately to the card and hero if this series is open
    setCoverUrl(series, url);
    const card = getSeriesCard(series.name);
    if (card) { rebuildCoverEl(card, 'local:'+series.name, series, 'local'); }
    if (library.curSeries?.name === series.name) {
      $('hero').innerHTML = `<img src="${esc(url)}" alt="">`;
      _updateHeroBg(url);
    }
    showWatcherToast('Cover updated');
  } catch(e) {
    console.error('[cover] set custom cover failed:', e);
    showWatcherToast('Failed to set cover');
  }
}

function ctxResetCover() {
  if (!_cardMenuTarget?.series) return;
  const series = _cardMenuTarget.series;
  closeCardMenu();

  // Remove custom cover entry — next load will re-fetch from MU
  delete coverIndex[series.name];
  saveCoverIndex();

  // Clear the displayed cover and re-enqueue MU fetch
  setCoverUrl(series, null);
  const card = getSeriesCard(series.name);
  if (card) { card.innerHTML = `<div class="s-cover-ph">📖<small>LOADING</small></div>`; attachCardExtras(card, 'local:'+series.name, series, 'local'); }
  if (library.curSeries?.name === series.name) {
    $('hero').innerHTML = '📖';
    _updateHeroBg(null);
  }
  loadCoverTauri(series);
  showWatcherToast('Cover reset');
}

function ctxOpenFolder() {
  if (!_cardMenuTarget?.series?.path || !IS_TAURI) return;
  closeCardMenu();
  invoke('open_folder_path', { path: _cardMenuTarget.series.path })
    .catch(e => { console.error('[open folder]', e); showWatcherToast('Could not open folder'); });
}

function openCurrentSeriesFolder() {
  if (!library.curSeries?.path || !IS_TAURI) return;
  invoke('open_folder_path', { path: library.curSeries.path })
    .catch(e => { console.error('[open folder]', e); showWatcherToast('Could not open folder'); });
}

// ═══════════════════════════════════════════════════════════════
// IDENTIFY MODAL (MangaUpdates override)
// ═══════════════════════════════════════════════════════════════

let _identifySeries = null;

function openIdentifyModal(series) {
  _identifySeries = series;
  $('identify-series-name').textContent = series.name;
  $('identify-search').value = muOverrides[series.name]?.title || series.name;
  $('identify-results').innerHTML = '';
  // Show active override hint
  if (muOverrides[series.name]) {
    $('identify-clear-btn').style.display = '';
    $('identify-results').innerHTML = `<div style="padding:10px 14px;font-family:var(--f-hdr);font-weight:700;font-size:9px;color:var(--accent);letter-spacing:0.5px">OVERRIDE ACTIVE: ${esc(muOverrides[series.name].title)}</div>`;
  } else {
    $('identify-clear-btn').style.display = 'none';
  }
  $('identify-modal').classList.add('open');
  runIdentifySearch();
}

function closeIdentifyModal() {
  $('identify-modal').classList.remove('open');
  _identifySeries = null;
}

async function runIdentifySearch() {
  const q = $('identify-search').value.trim();
  if (!q) return;
  const res = $('identify-results');
  res.innerHTML = '<div class="empty" style="height:80px"><div class="spin"></div></div>';
  try {
    const data = await muSearch(q, 10);
renderIdentifyResults(data.results || []);
  } catch(e) {
    res.innerHTML = '<div style="padding:14px;font-family:var(--f-hdr);font-weight:700;font-size:10px;color:var(--text-dim);letter-spacing:0.5px">MANGAUPDATES UNAVAILABLE</div>';
  }
}

function renderIdentifyResults(results) {
  const res = $('identify-results');
  if (!results.length) { res.innerHTML = '<div style="padding:14px;font-family:var(--f-hdr);font-weight:700;font-size:10px;color:var(--text-dim)">NO RESULTS</div>'; return; }
  res.innerHTML = '';
  const curOverride = _identifySeries ? muOverrides[_identifySeries.name]?.title : null;
  results.forEach(r => {
    const rec = r.record || {};
    const title = rec.title || r.hit_title || '—';
    const isActive = curOverride === title;
    const item = document.createElement('div');
    item.className = 'identify-result-item' + (isActive ? ' ident-active' : '');
    item.innerHTML = `<div class="ident-title">${esc(title)}${isActive ? ' ✓' : ''}</div><div class="ident-meta">${esc(rec.year||'')} ${esc(rec.status||'')} ${rec.series_id ? '· ID:'+esc(rec.series_id) : ''}</div>`;
    item.onclick = () => applyMuOverride({ title, series_id: rec.series_id });
    res.appendChild(item);
  });
}

function applyMuOverride(rec) {
  if (!_identifySeries) return;
  const key = _identifySeries.name;
  // Delete the old cached cover so it re-downloads for the new series
  const oldInfo = muCache[key];
  if (IS_TAURI && oldInfo?.id) {
    invoke('delete_cached_cover', { seriesId: String(oldInfo.id) }).catch(() => {});
  }
  muOverrides[key] = { title: rec.title, seriesId: rec.series_id };
  saveOverrides();
  delete muCache[key];
  saveMuCache();
  // Also clear from cover index so it re-downloads on next load
  if (coverIndex[key]) { delete coverIndex[key]; saveCoverIndex(); }
  if (_identifySeries) _identifySeries.muInfo = null;
  closeIdentifyModal();
  // Re-open series to re-fetch MU data with new override
  if (library.curSeries && library.curSeries.name === key) openSeries(_identifySeries);
}

function clearMuOverride() {
  if (!_identifySeries) return;
  const key = _identifySeries.name;
  // Delete cached cover so it re-downloads without the override
  const oldInfo = muCache[key];
  if (IS_TAURI && oldInfo?.id) {
    invoke('delete_cached_cover', { seriesId: String(oldInfo.id) }).catch(() => {});
  }
  delete muOverrides[key];
  saveOverrides();
  delete muCache[key];
  saveMuCache();
  // Also clear from cover index so it re-downloads on next load
  if (coverIndex[key]) { delete coverIndex[key]; saveCoverIndex(); }
  if (_identifySeries) _identifySeries.muInfo = null;
  closeIdentifyModal();
  if (library.curSeries && library.curSeries.name === key) openSeries(_identifySeries);
}


// ═══════════════════════════════════════════════════════════════
// BREADCRUMB
// ═══════════════════════════════════════════════════════════════

/**
 * Updates the header breadcrumb and right-side action buttons.
 * @param {string} view - One of: 'landing','library','chapters','reader',
 *                        'mdex','mdex-detail','reader-mdex'
 */
function bc(view) {
  // Stop reader header auto-hide whenever we navigate away from reader
  if (view !== 'reader' && typeof _stopReaderHeaderAutoHide === 'function') {
    _stopReaderHeaderAutoHide();
  }
  const bcEl=$('bc'), hrEl=$('hr');
  const root=library.rootHandle?library.rootHandle.name:'LIBRARY';
  const changeBtn='<button class="btn change-folder-btn">CHANGE FOLDER</button>';

  // ── Nav-row path + button enable/disable ─────────────────────
  const backBtn    = $('nav-back-btn');
  const fwdBtn     = $('nav-forward-btn');
  const rescanBtn  = $('nav-rescan-btn');
  const navPath    = $('nav-path');

  const canBack    = view === 'chapters' || view === 'reader';
  const canFwd     = ui.navHistory.length > 0;
  const canRescan  = !!library.rootHandle?._path;

  if (backBtn)   backBtn.disabled   = !canBack;
  if (fwdBtn)    fwdBtn.disabled    = !canFwd;
  if (rescanBtn) rescanBtn.disabled = !canRescan;

  // Build path segments for nav row
  if (navPath) {
    if (view === 'landing' || !library.rootHandle) {
      navPath.innerHTML = '';
    } else if (view === 'library') {
      navPath.innerHTML = `<span class="nav-crumb active">${esc(root)}</span>`;
    } else if (view === 'chapters') {
      navPath.innerHTML =
        `<span class="nav-crumb" id="nbc0">${esc(root)}</span>` +
        `<span class="nav-sep">›</span>` +
        `<span class="nav-crumb active">${esc(library.curSeries?.name||'')}</span>`;
      const _nbc0 = $('nbc0'); if (_nbc0) _nbc0.onclick = () => { mobileBack(); };
    } else if (view === 'reader') {
      const ch = library.curSeries?.chapters[library.curChIdx]?.name || '';
      navPath.innerHTML =
        `<span class="nav-crumb" id="nbc0">${esc(root)}</span>` +
        `<span class="nav-sep">›</span>` +
        `<span class="nav-crumb" id="nbc1">${esc(library.curSeries?.name||'')}</span>` +
        `<span class="nav-sep">›</span>` +
        `<span class="nav-crumb active">${esc(ch)}</span>`;
      const _nbc0r = $('nbc0'), _nbc1r = $('nbc1');
      if (_nbc1r) _nbc1r.onclick = () => { mobileBack(); };
      if (_nbc0r) _nbc0r.onclick = () => { ui.navHistory.length=0; show('library'); bc('library'); };
    }
  }

  // ── App-bar breadcrumb + right-side action buttons ────────────
  if (view==='landing') {
    bcEl.innerHTML='';
    hrEl.innerHTML=`<button class="btn primary" id="open-btn">OPEN LIBRARY</button>`;
    $('open-btn').onclick=openLibrary;
  } else if (view==='library') {
    bcEl.innerHTML=`<span class="crumb active">${esc(root)}</span>`;
    hrEl.innerHTML=changeBtn;
    hrEl.querySelector('.change-folder-btn').addEventListener('click', openLibrary);
  } else if (view==='chapters') {
    bcEl.innerHTML=`<span class="crumb" id="bc0">${esc(root)}</span><span class="sep">›</span><span class="crumb active">${esc(library.curSeries?.name||'')}</span>`;
    hrEl.innerHTML=changeBtn;
    hrEl.querySelector('.change-folder-btn').addEventListener('click', openLibrary);
    const _bc0c = $('bc0'); if (_bc0c) _bc0c.onclick = () => { mobileBack(); };
  } else if (view==='reader') {
    const rawCh = library.curSeries?.chapters[library.curChIdx]?.name || '';
    // Strip zero-padding: parse vol/ch numbers and reformat without leading zeros
    const [vol, chNum] = parseChapterKey(rawCh);
    const fmtN = n => Number.isFinite(n) && n >= 0 ? (n % 1 === 0 ? String(n) : n.toFixed(1)) : null;
    let chDisplay = rawCh;
    if (fmtN(vol) || fmtN(chNum)) {
      const parts = [];
      if (fmtN(vol))   parts.push(`Vol.${fmtN(vol)}`);
      if (fmtN(chNum)) parts.push(`Ch.${fmtN(chNum)}`);
      // Append any trailing title/group info after the numeric part
      const title = cleanChTitle(rawCh);
      if (title) parts.push(title);
      chDisplay = parts.join(' ');
    }
    bcEl.innerHTML=`<span class="crumb" id="bc0">${esc(root)}</span><span class="sep">›</span><span class="crumb" id="bc1">${esc(library.curSeries?.name||'')}</span><span class="sep">›</span><span class="crumb active">${esc(chDisplay)}</span>`;
    hrEl.innerHTML='';
    const _bc0r = $('bc0'), _bc1r = $('bc1');
    if (_bc1r) _bc1r.onclick = () => { mobileBack(); };
    if (_bc0r) _bc0r.onclick = () => { ui.navHistory.length=0; show('library'); bc('library'); };
  }
  ui.currentView = view;
  document.body.dataset.view = view;
}

/** Navigates up one level in the view stack (used by mobile back button). */

function mobileBack() {
  const v = ui.currentView;
  ui.navBack = true;
  if (v === 'chapters') { ui.navHistory.push(v); show('library');  bc('library'); }
  else if (v === 'reader') { ui.navHistory.push(v); show('chapters'); bc('chapters'); }
}

function mobileForward() {
  const next = ui.navHistory.pop();
  if (!next) return;
  ui.navBack = true;
  if (next === 'chapters') { show('chapters'); bc('chapters'); }
  else if (next === 'reader') {
    if (reader.src === 'local' && library.curSeries) { show('reader'); bc('reader'); }
  }
}

// ═══════════════════════════════════════════════════════════════
// UPDATE CHECKER
// ═══════════════════════════════════════════════════════════════

// ── TAURI: Library file watcher ──────────────────────────────────────────────
// Listens for new folders added to the library root (e.g. by HakuNeko)
// and auto-refreshes the library after a short debounce.

/**
 * Registers a Tauri event listener.
 * Prefers the stable public API (window.__TAURI__.event.listen, available when
 * withGlobalTauri is true in tauri.conf.json), then falls back to the internal
 * invoke path used by all current Tauri v2 builds. Either way the internal usage
 * is isolated here so only this one function needs updating if the API changes.
 * Returns a Promise resolving to an unlisten function, or null on failure.
 */
async function tauriListen(event, callback) {
  if (window.__TAURI__?.event?.listen) {
    try { return await window.__TAURI__.event.listen(event, callback); } catch(_) {}
  }
  // Fallback: use the internal invoke path available in all current Tauri v2 builds.
  // Guard both properties before accessing so a partial Tauri environment doesn't
  // throw a cryptic TypeError deep inside the call.
  if (!window.__TAURI_INTERNALS__?.transformCallback || !window.__TAURI_INTERNALS__?.invoke) {
    console.warn('[NeruYomi] tauriListen: __TAURI_INTERNALS__ is missing required methods; event listener not registered for:', event);
    return null;
  }
  const handler = window.__TAURI_INTERNALS__.transformCallback(callback, false);
  await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {
    event, handler, target: { kind: 'App' },
  });
  return () => window.__TAURI_INTERNALS__.invoke(
    'plugin:event|unlisten', { event, handler }
  ).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
// MANUAL RESCAN
// Rescans the library root for added or removed series folders
// without losing read-progress, bookmarks, or MU metadata.
// ═══════════════════════════════════════════════════════════════

async function rescanLibrary() {
  if (!library.rootHandle?._path) return;

  const btn = $('nav-rescan-btn');
  if (btn?.disabled) return;

  const currentView = ui.currentView;

  // Spin the icon while scanning
  if (btn) {
    btn.disabled = true;
    const svg = btn.querySelector('svg');
    if (svg) svg.style.animation = 'spin 0.7s linear infinite';
  }

  try {
    const folderPath = library.rootHandle._path;

    // ── Step 1: rescan the library folder (series list) ───────────
    // Single pass: build both the lookup Map and the prev-names Set together.
    const prevByName = new Map(library.items.map(s => [s.name, s]));
    const prevNames  = new Set(prevByName.keys());
    const topEntries = await invoke('read_dir', { path: folderPath });
    const dirs = topEntries
      .filter(e => e.is_dir && e.name !== '_trash')
      .sort((a, b) => natCmp(a.name, b.name));

    // Build updated library, preserving existing series objects so
    // covers, muInfo, size etc. aren't thrown away.
    // newEntries holds direct references to genuinely new series objects
    // so we never need to re-scan library with find() afterward.
    const newLibrary = [];
    const newEntries = [];
    for (const dir of dirs) {
      if (prevByName.has(dir.name)) {
        // Keep existing entry — chapters refreshed below if needed
        newLibrary.push(prevByName.get(dir.name));
      } else {
        const chapters = await getChaptersTauri(dir.path);
        const s = { name: dir.name, path: dir.path, chapters, coverUrl: null, size: null };
        newLibrary.push(s);
        newEntries.push(s);
      }
    }

    const nextNames = new Set(newLibrary.map(s => s.name));
    const added     = [...nextNames].filter(n => !prevNames.has(n));
    const removed   = [...prevNames].filter(n => !nextNames.has(n));

    // Commit the updated library in-place
    library.items.length = 0;
    for (const s of newLibrary) library.items.push(s);

    // Load covers for new entries only (existing covers are preserved above).
    // Refresh sizes for ALL series — existing ones may have grown if new chapters
    // were downloaded into them since the last open. loadSeriesSize is async and
    // fire-and-forget so this happens in the background without blocking the UI.
    for (const s of newEntries) loadCoverTauri(s);
    library.items.forEach(loadSeriesSize);

    // Restart watcher
    if (IS_TAURI) invoke('start_library_watcher', { path: folderPath }).catch(() => {});

    // ── Step 2: context-specific UI update ───────────────────────
    if (currentView === 'chapters' || currentView === 'reader') {
      // Rescan the currently open series for new/removed chapters
      const seriesStillExists = library.curSeries && nextNames.has(library.curSeries.name);

      if (seriesStillExists) {
        const freshChapters = await getChaptersTauri(library.curSeries.path);
        const prevChCount   = library.curSeries.chapters.length;
        library.curSeries.chapters  = freshChapters;

        // Also update the library entry so the grid reflects the new count
        const libEntry = library.items.find(s => s.name === library.curSeries.name);
        if (libEntry) libEntry.chapters = freshChapters;

        const newChCount = freshChapters.length - prevChCount;

        if (currentView === 'chapters') {
          // Refresh the stat line and chapter list without leaving the page
          $('sstat').innerHTML = `<b>${library.curSeries.chapters.length}</b> CHAPTERS`;
          renderChapterList(library.curSeries, 'local:' + library.curSeries.name);

          // Re-fetch MU metadata for the open series (force=true bypasses cache)
          // so any changes to status, description, rating etc. are picked up.
          $('mu-fetching').style.display = '';
          $('mu-meta').style.display = 'none';
          fetchMuInfo(library.curSeries.name, true).then(info => {
            $('mu-fetching').style.display = 'none';
            if (info && library.curSeries) applyMuInfoToPanel(info, library.curSeries, false);
          });
        }

        // Build toast message
        const parts = [];
        if (added.length)    parts.push(`+${added.length} new series`);
        if (removed.length)  parts.push(`−${removed.length} series removed`);
        if (newChCount > 0)  parts.push(`+${newChCount} new chapters`);
        if (newChCount < 0)  parts.push(`${newChCount} chapters removed`);

        showWatcherToast(parts.length
          ? `Rescan complete — ${parts.join(', ')}, refreshing MU metadata…`
          : 'Refreshing MU metadata…');

      } else if (library.curSeries && !seriesStillExists) {
        // The open series was deleted — fall back to library view
        showWatcherToast(`"${library.curSeries.name}" was removed from library`);
        library.curSeries = null;
        renderLibrary();
        show('library');
        bc('library');
      } else {
        showWatcherToast('Library is up to date');
      }

    } else {
      // On the library view — re-render the grid as before
      renderLibrary($('search').value);
      bc('library');

      const parts = [];
      if (added.length)   parts.push(`+${added.length} added`);
      if (removed.length) parts.push(`−${removed.length} removed`);
      showWatcherToast(parts.length
        ? `Rescan complete — ${parts.join(', ')}`
        : 'Library is up to date');
    }

  } catch (e) {
    showWatcherToast('Rescan failed — check the console');
    console.error('[rescan] error:', e);
  } finally {
    if (btn) {
      btn.disabled = false;
      const svg = btn.querySelector('svg');
      if (svg) svg.style.animation = '';
    }
  }
}

// Suppress toasts that fire during the initial auto-reopen on page load
let _toastReady = false;
setTimeout(() => { _toastReady = true; }, 2000);

function showWatcherToast(msg) {
  if (!_toastReady) return;
  let toast = $('watcher-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'watcher-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.visibility = 'visible';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.visibility = 'hidden';
  }, 3000);
}

if (IS_TAURI) {
  let _watcherRefreshTimer = null;

  tauriListen('library-changed', () => {
    clearTimeout(_watcherRefreshTimer);
    _watcherRefreshTimer = setTimeout(async () => {
      if (!library.rootHandle?._path) return;
      const prev = library.items.length;
      await _loadLibraryFromPath(library.rootHandle._path);
      const added = library.items.length - prev;
      if (added > 0) showWatcherToast(`Library updated — +${added} series`);
    }, 1500);
  }).catch(() => {});
}

