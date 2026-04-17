// ═══════════════════════════════════════════════════════════════
// READER
// Chapter loading, page rendering, navigation, zoom/pan.
// Depends on: $, esc, ZSTEP/ZMIN/ZMAX, BLANK, LOADING_PAGE,
//             CONN_LOST_SVG, natCmp, isImg (utils.js)
//             IS_TAURI, invoke, convertFileSrc (utils.js)
//             reader, library, ui (state)
//             setSetting (settings.js)
//             getChProg, setChProg, saveReadProgress (library.js)
// ═══════════════════════════════════════════════════════════════

// Local chapter reader
let _savedChScroll = 0;
async function openLocalChapter(idx, startAtEnd=false) {
  // Forward navigation — reset history so mobileForward() doesn't jump to a ghost view.
  ui.navHistory.length = 0;
  _savedChScroll = $('view-chapters')?.scrollTop || 0;
  library.curChIdx=idx; reader.src='local';
  const ch=library.curSeries.chapters[idx];
  show('reader'); bc('reader');
  _startReaderHeaderAutoHide();
  freePages();
  $('page-display').innerHTML=`<div style="color:var(--text-primary);font-size:12px;margin:auto;font-family:monospace;letter-spacing:2px">LOADING…</div>`;
  const fill = $('prog-fill'); if (fill) fill.style.width = '0%';

  if (ch.pdfHandle || (IS_TAURI && ch.isPdf && ch.pdfPath)) {
    // PDF chapter — load all pages lazily
    $('page-display').innerHTML=`<div style="color:var(--text-primary);font-size:12px;margin:auto;font-family:monospace">LOADING PDF…</div>`;
    try {
      let file;
      if (IS_TAURI && ch.pdfPath) {
        // Load PDF via asset protocol — no base64 roundtrip needed
        const pdfUrl = convertFileSrc(ch.pdfPath);
        const doc = await pdfjsLib.getDocument(pdfUrl).promise;
        const arr = [];
        // Virtual chapters specify a page range; full chapters use all pages
        const startPage = ch.pdfStartPage ?? 1;
        const endPage   = ch.pdfEndPage   ?? doc.numPages;
        for (let i = startPage; i <= endPage; i++)
          arr.push({ name: `Page ${i}`, url: null, revoke: true, pdfDoc: doc, pdfPageNum: i });
        reader.pages = arr;
      } else {
        file = await ch.pdfHandle.getFile();
        reader.pages = await pdfFileToPages(file);
      }
    } catch(e) {
      $('page-display').innerHTML=`<div class="empty"><div class="ei">⚠</div>FAILED TO LOAD PDF</div>`;
      return;
    }
  } else if (IS_TAURI && ch.isCbz && ch.cbzPath) {
    // CBZ chapter — use pre-set entries for virtual chapters, else fetch from archive
    try {
      const cbzEntries = ch.cbzEntries || await invoke('read_cbz_entries', { path: ch.cbzPath });
      reader.pages = cbzEntries.map(name => ({
        name:      name.split('/').pop(),
        cbzPath:   ch.cbzPath,
        entryName: name,
        url:       null,
        revoke:    true,
      }));
    } catch(e) {
      $('page-display').innerHTML = `<div class="empty"><div class="ei">⚠</div>FAILED TO READ CBZ</div>`;
      return;
    }
  } else if (IS_TAURI && ch.path) {
    // Tauri native FS — assign asset URLs immediately, no IPC or base64 per page
    try {
      const entries = await invoke('read_dir', { path: ch.path });
      const imgs = entries
        .filter(e => !e.is_dir && isImg(e.name))
        .sort((a, b) => natCmp(a.name, b.name));
      reader.pages = imgs.map(e => ({ name: e.name, filePath: e.path, url: convertFileSrc(e.path), revoke: false }));
    } catch(e) {
      $('page-display').innerHTML=`<div class="empty"><div class="ei">⚠</div>FAILED TO READ CHAPTER</div>`;
      return;
    }
  } else {
    const imgs=[];
    for await (const [name,handle] of ch.handle.entries())
      if (handle.kind==='file'&&isImg(name)) imgs.push({name,handle});
    imgs.sort((a,b)=>natCmp(a.name,b.name));
    reader.pages=imgs.map(({name,handle})=>({name,handle,url:null,revoke:true}));
  }

  if (!startAtEnd) {
    const saved = getChProg('local:'+library.curSeries.name, ch.name);
    // Resume only if genuinely in-progress (page > 0 in LTR, or page < last in RTL)
    const inProgress = saved && !saved.read && saved.page > 0 && saved.page < reader.pages.length - 1;
    reader.curPage = inProgress ? saved.page : 0;
  } else {
    // Arriving from the previous chapter — land at the reading-direction "end"
    reader.curPage = reader.pages.length - 1;
  }
  reader.zoom=1; reader.panX=0; reader.panY=0;
  const preIdx=startAtEnd ? [reader.curPage, reader.curPage-1, reader.curPage-2, reader.curPage-3, reader.curPage-4] : [reader.curPage, reader.curPage+1, reader.curPage+2, reader.curPage+3, reader.curPage+4];
  await preloadLocal(preIdx);
  await applyAutoLayout();
  renderProgressSegs(); renderThumbs(); renderPage(); stat();
}
async function preloadLocal(idxs) {
  await Promise.all(idxs.map(async i=>{
    if (i<0||i>=reader.pages.length||reader.pages[i].url) return;
    if (reader.pages[i].pdfDoc) {
      await preloadPdfPage(reader.pages[i]);
    } else if (IS_TAURI && reader.pages[i].filePath) {
      // Asset URL was assigned at chapter-open time — nothing to load here.
      // This path is only reached if something cleared pages[i].url unexpectedly.
      reader.pages[i].url = convertFileSrc(reader.pages[i].filePath);
    } else if (IS_TAURI && reader.pages[i].cbzPath) {
      // CBZ page: decode from archive on demand, create blob URL
      const p = reader.pages[i];
      const b64 = await invoke('read_cbz_entry', { path: p.cbzPath, name: p.entryName });
      reader.pages[i].url = _base64ToUrl(b64, _imgMimeType(p.entryName));
    } else if (reader.pages[i].handle) {
      const f=await reader.pages[i].handle.getFile();
      reader.pages[i].url=URL.createObjectURL(f);
    }
  }));
}


// ═══════════════════════════════════════════════════════════════
// SHARED READER
// ═══════════════════════════════════════════════════════════════


/** Frees object URLs for local pages and clears the pages array. */
function freePages() {
  const seenDocs = new Set();
  reader.pages.forEach(p => {
    if (p.url && p.revoke) URL.revokeObjectURL(p.url);
    // Destroy PDF.js document objects — each doc is shared across all its pages
    // so deduplicate via a Set to avoid calling destroy() more than once.
    if (p.pdfDoc && !seenDocs.has(p.pdfDoc)) {
      seenDocs.add(p.pdfDoc);
      p.pdfDoc.destroy();
    }
  });
  reader.pages = [];
}

// ═══════════════════════════════════════════════════════════════
// LONG STRIP RENDERER
// ═══════════════════════════════════════════════════════════════

let _stripScrollListener = null;
let _stripScrollTimer    = null;
let _stripObserver       = null;

/** Removes the strip scroll listener, cancels any pending rAF, and disconnects the IntersectionObserver. */
function _disconnectStripScroll() {
  const display = $('page-display');
  if (display && _stripScrollListener) {
    display.removeEventListener('scroll', _stripScrollListener);
    _stripScrollListener = null;
  }
  if (_stripScrollTimer) { cancelAnimationFrame(_stripScrollTimer); _stripScrollTimer = null; }
  if (_stripObserver)    { _stripObserver.disconnect(); _stripObserver = null; }
}

/** Attaches a rAF-throttled scroll listener that keeps curPage in sync. */
function _connectStripScroll() {
  const display = $('page-display');
  if (!display || _stripScrollListener) return;
  _stripScrollListener = () => {
    if (_stripScrollTimer) return;
    _stripScrollTimer = requestAnimationFrame(() => {
      _stripScrollTimer = null;
      if (!reader.strip) return;
      // Always update the % bar on every scroll tick
      stat();
      const containerTop = display.getBoundingClientRect().top;
      let bestIdx = reader.curPage, bestDist = Infinity;
      for (const el of display.children) {
        const rect = el.getBoundingClientRect();
        // Pick the page whose top edge is closest to (not above) the container top
        if (rect.bottom > containerTop) {
          const dist = Math.abs(rect.top - containerTop);
          if (dist < bestDist) { bestDist = dist; bestIdx = parseInt(el.dataset.idx, 10); }
        }
      }
      if (bestIdx !== reader.curPage && !isNaN(bestIdx)) {
        reader.curPage = bestIdx;
        _evictPdfPages(reader.curPage);
        saveCurrentProgress();
      }
    });
  };
  display.addEventListener('scroll', _stripScrollListener, { passive: true });
}

/**
 * Sliding window for PDF pages — revokes blob URLs for rendered PDF pages
 * that are more than KEEP positions away from curIdx and resets them to null
 * so they'll be re-rendered if the user scrolls back.
 * No-op for non-PDF pages (revoke: false).
 */
const PDF_KEEP_WINDOW = 2;
function _evictPdfPages(curIdx) {
  reader.pages.forEach((p, i) => {
    if (!p.pdfDoc || !p.url || !p.revoke) return;
    if (Math.abs(i - curIdx) > PDF_KEEP_WINDOW) {
      URL.revokeObjectURL(p.url);
      p.url = null; // will be re-rendered by preloadLocal if visited again
    }
  });
}

/** Builds the full-page vertical scroll layout used for webtoon / long-strip chapters. */
function renderStrip() {
  const display = $('page-display');
  display.innerHTML = '';
  const frag = document.createDocumentFragment();

  // Pages within this distance of curPage are loaded immediately.
  // Everything else is deferred until the IntersectionObserver fires.
  // Only applies to non-PDF pages — PDF pages are always lazy via preloadLocal.
  const STRIP_BUFFER = 5;

  // IntersectionObserver — loads img.src when a strip-page div scrolls
  // within ~2 screen-heights of the viewport. rootMargin of 200% means
  // the browser will trigger about 2 full viewport heights ahead/behind.
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const div = entry.target;
      const img = div.querySelector('img');
      const i   = parseInt(div.dataset.idx, 10);
      if (!img || img.dataset.loaded) { obs.unobserve(div); return; }
      if (reader.pages[i]?.url) {
        img.src = reader.pages[i].url;
        img.dataset.loaded = '1';
      } else {
        preloadLocal([i]).then(() => {
          if (reader.pages[i]?.url) {
            img.src = reader.pages[i].url;
            img.dataset.loaded = '1';
          }
        });
      }
      obs.unobserve(div);
    });
  }, { root: display, rootMargin: '200% 0px' });

  _stripObserver = obs;

  reader.pages.forEach((p, i) => {
    const div = document.createElement('div');
    div.className   = 'strip-page';
    div.id          = 'sp-' + i;
    div.dataset.idx = String(i);
    if (reader.zoom !== 1) div.style.maxWidth = Math.round(reader.zoom * 720) + 'px';

    const img = document.createElement('img');
    img.draggable = false;
    img.onerror = () => { img.onerror = null; img.src = CONN_LOST_SVG; };

    const withinBuffer = Math.abs(i - reader.curPage) <= STRIP_BUFFER;

    if (p.pdfDoc) {
      // PDF pages are always lazy — preloadLocal renders them to canvas blobs
      img.src = LOADING_PAGE;
      if (withinBuffer) {
        preloadLocal([i]).then(() => {
          if (reader.pages[i]?.url) { img.src = reader.pages[i].url; img.dataset.loaded = '1'; }
        });
      } else {
        obs.observe(div);
      }
    } else if (withinBuffer) {
      // Normal manga within buffer — load immediately
      if (p.url) {
        img.src = p.url;
        img.dataset.loaded = '1';
      } else {
        img.src = LOADING_PAGE;
        preloadLocal([i]).then(() => {
          if (reader.pages[i]?.url) { img.src = reader.pages[i].url; img.dataset.loaded = '1'; }
        });
      }
    } else {
      // Outside buffer — defer to IntersectionObserver
      img.src = LOADING_PAGE;
      obs.observe(div);
    }

    div.appendChild(img);
    frag.appendChild(div);
  });

  display.appendChild(frag);

  // Restore scroll position to curPage (e.g. when resuming a chapter).
  requestAnimationFrame(() => {
    $('sp-' + reader.curPage)?.scrollIntoView({ block: 'start' });
  });

  _connectStripScroll();
}

// ═══════════════════════════════════════════════════════════════
// LONG STRIP AUTO-DETECTION
// ═══════════════════════════════════════════════════════════════

/**
 * Inspects the natural dimensions of the first few loaded pages and returns
 * true when the average height:width ratio exceeds the webtoon threshold (2.5).
 * Standard manga pages run ~1.3–1.8; webtoon strips are typically 3–20+.
 */
async function detectLongStrip() {
  // Sample up to 3 non-PDF pages that already have a URL (preloaded before we run).
  const sample = reader.pages.filter(p => p.url && !p.pdfDoc).slice(0, 3);
  if (!sample.length) return false;

  const ratios = await Promise.all(sample.map(p => new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(img.naturalHeight / (img.naturalWidth || 1));
    img.onerror = () => resolve(0);
    img.src = p.url;
  })));

  const valid = ratios.filter(r => r > 0);
  if (!valid.length) return false;
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  return avg > 2.5;
}

/**
 * Runs auto-detection and sets the effective `strip` / `spread` flags for the
 * current chapter without touching the user's saved layout preference.
 * Shows a badge in the settings panel and a brief toast when auto-switching.
 */
async function applyAutoLayout() {
  const autoDetected = await detectLongStrip();
  const prevStrip = reader.strip;
  // User's explicit "Long Strip" preference always wins; otherwise trust detection.
  reader.strip  = (userSettings.layout === 'strip') || autoDetected;
  reader.spread = !reader.strip && (userSettings.layout === 'spread');

  // Update the auto-detect badge visibility in the settings panel.
  const badge = $('strip-auto-badge');
  const isAutoOverride = autoDetected && userSettings.layout !== 'strip';
  if (badge) badge.classList.toggle('show', isAutoOverride);

  if (isAutoOverride && !prevStrip) {
    showToast('≡ LONG STRIP DETECTED');
  }
}

/** Returns the text content for a series card badge. */
function badgeText(s) {
  const ch = `${s.chapters.length} CH`;
  return s.size != null ? `${ch} · ${formatBytes(s.size)}` : ch;
}

/** Assigns a new cover URL to a series, revoking the previous one if it was a blob. */
/** Returns the .s-cover element for a series card by series name. */
function getSeriesCard(name) {
  return document.querySelector(`[data-series="${CSS.escape(name)}"] .s-cover`);
}

function setCoverUrl(series, url) {
  if (series.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(series.coverUrl);
  series.coverUrl = url;
}

/** Revokes any blob cover URLs held by the current library before it is replaced. */
function freeLibrary() {
  library.items.forEach(s => { if (s.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(s.coverUrl); });
  ui.activeGenres.clear();
  const bar  = $('genre-bar');
  const wrap = $('genre-dropdown-wrap');
  if (bar)  { bar.innerHTML = ''; bar.classList.remove('open'); }
  if (wrap) wrap.style.display = 'none';
  $('genre-dropdown-btn')?.classList.remove('open');
  // Clear the Rust-side library root so FS commands reject stale paths.
  if (IS_TAURI) invoke('clear_library_root').catch(() => {});
}

/** Renders the thumbnail strip, respecting reading direction. */
function renderThumbs() {
  const tp=$('thumbs'); tp.innerHTML='';
  if (reader.strip) return; // strip mode has no thumbnail panel — skip the render
  const order=reader.rtl?[...reader.pages.keys()].reverse():[...reader.pages.keys()];
  order.forEach(i=>{
    const d=document.createElement('div'); d.className='thumb'+(i===reader.curPage?' on':''); d.id='th-'+i; d.onclick=()=>jump(i);
    const img=document.createElement('img'); img.loading='lazy';
    img.src=reader.pages[i].url||BLANK;
    if (!reader.pages[i].url) preloadLocal([i]).then(()=>{if(reader.pages[i].url)img.src=reader.pages[i].url;});
    const num=document.createElement('div'); num.className='thumb-n'; num.textContent=i+1;
    d.appendChild(img); d.appendChild(num); tp.appendChild(d);
  });
}

/** Renders the active page (or spread pair) in the reading area. */
function renderPage() {
  // Always disconnect the strip scroll watcher before (re)rendering so we
  // don't accumulate duplicate listeners when switching layouts.
  _disconnectStripScroll();
  $('read-area').classList.toggle('strip-mode', reader.strip);
  document.body.classList.toggle('strip-active', reader.strip);
  if (reader.strip) { renderStrip(); return; }
  // ── Single / spread ──────────────────────────────────────────────────────
  $('read-area').classList.toggle('rtl-mode', reader.rtl);
  const display=$('page-display'); display.innerHTML='';
  const idxs=spreadIdxs();
  const order=reader.rtl?[...idxs].reverse():idxs;
  order.forEach(i=>{
    const wrap=document.createElement('div'); wrap.className='pw';
    const img=document.createElement('img'); img.draggable=false;
    img.onerror=()=>{ img.onerror=null; img.src=CONN_LOST_SVG; };
    if (reader.pages[i].url) { img.src=reader.pages[i].url; }
    else { img.src=LOADING_PAGE; preloadLocal([i]).then(()=>{if(reader.pages[i].url)img.src=reader.pages[i].url;}); }
    wrap.appendChild(img); display.appendChild(wrap);
  });
  // Pre-fetch pages for local mode:
  // single → 4 ahead, 2 behind; spread → 4 ahead (2 pairs), 2 behind
  if (reader.src==='local') preloadLocal(
    idxs.flatMap(i => [i+1, i+2, i+3, i+4, i-1, i-2])
  );
  // Sync thumbnail highlight — remove 'on' only from the currently active thumb
  document.querySelector('.thumb.on')?.classList.remove('on');
  const at=$('th-'+reader.curPage); if(at){at.classList.add('on');at.scrollIntoView({block:'nearest'});}
  $('nav-prev').disabled = reader.curPage <= 0;
  $('nav-next').disabled = reader.curPage >= reader.pages.length - 1;
  if (reader.zoom !== 1) applyZ(); // re-apply current zoom to freshly rendered images
}

function spreadIdxs() {
  if (!reader.spread) return [reader.curPage];
  const n=reader.rtl?reader.curPage-1:reader.curPage+1;
  return (n>=0&&n<reader.pages.length)?[reader.curPage,n]:[reader.curPage];
}

/** Builds the segmented progress bar — one div per page in paged mode,
 *  or a single continuous fill bar in strip mode. */
function renderProgressSegs() {
  const prog = $('prog');
  if (!prog) return;
  // The prog div now contains a single .prog-fill div (in HTML).
  // Wire up click-to-seek — no DOM rebuild needed each chapter.
  prog.onclick = (e) => {
    if (reader.strip) {
      const display = $('page-display');
      if (!display) return;
      const pct = e.offsetX / prog.offsetWidth;
      display.scrollTo({ top: pct * (display.scrollHeight - display.clientHeight), behavior: 'smooth' });
    } else if (reader.pages.length > 1) {
      const idx = Math.round((e.offsetX / prog.offsetWidth) * (reader.pages.length - 1));
      jump(reader.rtl ? (reader.pages.length - 1 - idx) : idx);
    }
  };
}

/** Updates the bottom status bar. */
function stat() {
  const jumpEl = $('page-jump'), totalEl = $('page-total'), fill = $('prog-fill');
  if (!reader.pages.length) {
    if (jumpEl) jumpEl.value = '';
    if (totalEl) totalEl.textContent = '—';
    if (fill) fill.style.width = '0%';
    return;
  }

  if (reader.strip) {
    const display = $('page-display');
    const maxScroll = display ? display.scrollHeight - display.clientHeight : 0;
    const scrollTop = display ? display.scrollTop : 0;
    const pct = maxScroll > 0 ? Math.round((scrollTop / maxScroll) * 100) : 0;
    if (jumpEl) { jumpEl.value = pct; jumpEl.max = 100; jumpEl.min = 0; }
    const sepEl = document.querySelector('.page-sep');
    if (sepEl) sepEl.textContent = '%';
    if (fill) fill.style.width = pct + '%';
    $('ztxt').textContent = Math.round(reader.zoom * 100) + '%';
    return;
  }

  const sepEl = document.querySelector('.page-sep');
  if (sepEl) sepEl.innerHTML = '/ <span id="page-total">' + reader.pages.length + '</span>';
  if (jumpEl) jumpEl.value = reader.curPage + 1;
  // Smooth fill: position reflects current page + direction
  const fillPct = reader.pages.length <= 1 ? 100
    : (reader.curPage / (reader.pages.length - 1)) * 100;
  if (fill) {
    if (reader.rtl) {
      fill.style.left  = 'auto';
      fill.style.right = '0';
    } else {
      fill.style.left  = '0';
      fill.style.right = 'auto';
    }
    fill.style.width = fillPct.toFixed(1) + '%';
  }
  $('ztxt').textContent = Math.round(reader.zoom * 100) + '%';
}

/** Shows a brief chapter-jump toast message. */
let _toastTimer = null;
function showToast(msg) {
  const t = $('ch-toast');
  t.textContent = msg;
  t.style.opacity = '1';
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.style.opacity = '0'; }, 1800);
}

// Navigation
function jump(i) {
  reader.curPage = Math.max(0, Math.min(reader.pages.length - 1, i));
  if (reader.strip) {
    // In strip mode, scroll to the target page — stat() and saveCurrentProgress()
    // are called by the scroll listener once the page is visible.
    $('sp-' + reader.curPage)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  _evictPdfPages(reader.curPage);
  renderPage(); stat(); saveCurrentProgress();
}

function nextChapterAvailable() {
  return library.curSeries && library.curChIdx < library.curSeries.chapters.length - 1;
}
function prevChapterAvailable() {
  return library.curChIdx > 0;
}
function goNextChapter() {
  if (!nextChapterAvailable()) return;
  showToast('▶ ' + (library.curSeries.chapters[library.curChIdx+1]?.name || 'NEXT CHAPTER'));
  openLocalChapter(library.curChIdx+1);
}
function goPrevChapter() {
  if (!prevChapterAvailable()) return;
  showToast('◀ ' + (library.curSeries.chapters[library.curChIdx-1]?.name || 'PREV CHAPTER'));
  openLocalChapter(library.curChIdx-1, true);
}

function goNext() {
  if (reader.strip) {
    if (reader.curPage >= reader.pages.length - 1) {
      goNextChapter();
    } else {
      $('sp-' + (reader.curPage + 1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }
  const s = reader.spread ? 2 : 1;
  if (reader.curPage < reader.pages.length - 1) jump(Math.min(reader.pages.length - 1, reader.curPage + s));
  else goNextChapter();
}
function goPrev() {
  if (reader.strip) {
    if (reader.curPage <= 0) {
      goPrevChapter();
    } else {
      $('sp-' + (reader.curPage - 1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return;
  }
  const s = reader.spread ? 2 : 1;
  if (reader.curPage > 0) jump(Math.max(0, reader.curPage - s));
  else goPrevChapter();
}
// Navigation zones
$('nav-left').onclick  = () => reader.rtl ? goNext() : goPrev();
$('nav-right').onclick = () => reader.rtl ? goPrev() : goNext();
// Mouse back/forward button navigation
document.addEventListener('mouseup', e => {
  if (e.button === 3) { e.preventDefault(); mobileBack(); }
  else if (e.button === 4) { e.preventDefault(); mobileForward(); }
});
document.addEventListener('mousedown', e => {
  if (e.button === 3 || e.button === 4) e.preventDefault();
});
// Center zone toggles reader bar visibility
$('nav-center').onclick=function() {
  if (ui.theatreMode) return; // Bar stays hidden in theatre mode
  ui.barVisible = !ui.barVisible;
  const bar = $('reader-bar');
  const readArea = $('read-area');
  bar.classList.toggle('hidden', !ui.barVisible);
  readArea.classList.toggle('bar-hidden', !ui.barVisible);
};
// Double-tap for theatre mode (ondblclick is intercepted by iOS/Android)
let _lastTapTime = 0;
$('nav-center').addEventListener('touchend', function(e) {
  const now = Date.now();
  if (now - _lastTapTime < 300) {
    e.preventDefault();
    _triggerTheatre();
    _lastTapTime = 0;
  } else {
    _lastTapTime = now;
  }
}, { passive: false });
$('nav-center').ondblclick = function(e) { e.stopPropagation(); _triggerTheatre(); };
function _triggerTheatre() {
  ui.theatreMode = !ui.theatreMode;
  const header = document.querySelector('header');
  const readArea = $('read-area');
  const bar = $('reader-bar');
  header.classList.toggle('theatre', ui.theatreMode);
  readArea.classList.toggle('theatre', ui.theatreMode);
  if (ui.theatreMode) {
    bar.classList.add('hidden');
    readArea.classList.add('bar-hidden');
    ui.barVisible = false;
  } else {
    ui.barVisible = true;
    bar.classList.remove('hidden');
    readArea.classList.remove('bar-hidden');
  }
}

// ── Header auto-hide in reader ────────────────────────────────────────────────
// Header fades out after 2.5s of inactivity. Returns on any mouse/touch move.
let _readerHideTimer = null;
let _readerHeaderHidden = false;

function _showReaderHeader() {
  const header = document.querySelector('header');
  if (!header) return;
  header.classList.remove('reader-hidden');
  _readerHeaderHidden = false;
  clearTimeout(_readerHideTimer);
  _readerHideTimer = setTimeout(_hideReaderHeader, 2500);
}

function _hideReaderHeader() {
  if (ui.theatreMode) return;
  const header = document.querySelector('header');
  if (!header) return;
  header.classList.add('reader-hidden');
  _readerHeaderHidden = true;
}

function _startReaderHeaderAutoHide() {
  _showReaderHeader();
  document.addEventListener('mousemove', _onReaderActivity);
  document.addEventListener('touchstart', _onReaderActivity, { passive: true });
}

function _stopReaderHeaderAutoHide() {
  clearTimeout(_readerHideTimer);
  const header = document.querySelector('header');
  if (header) header.classList.remove('reader-hidden');
  _readerHeaderHidden = false;
  document.removeEventListener('mousemove', _onReaderActivity);
  document.removeEventListener('touchstart', _onReaderActivity);
}

function _onReaderActivity() {
  if ($('view-reader')?.classList.contains('active')) _showReaderHeader();
  else _stopReaderHeaderAutoHide();
}
document.addEventListener('keydown',e=>{
  if(!$('view-reader').classList.contains('active'))return;
  if(e.key==='ArrowRight'||e.key==='ArrowDown') reader.rtl ? goPrev() : goNext();
  if(e.key==='ArrowLeft' ||e.key==='ArrowUp')   reader.rtl ? goNext() : goPrev();
  if(e.key==='+'||e.key==='=') adjZ(ZSTEP);
  if(e.key==='-')              adjZ(-ZSTEP);
  if(e.key==='0')              {reader.zoom=1;reader.panX=0;reader.panY=0;applyZ();}
});
// Global Escape: close any open modal or settings panel
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const panel = $('settings-panel');
  if (panel?.classList.contains('open')) { toggleSettings(); return; }
  if ($('identify-modal')?.classList.contains('open')) { closeIdentifyModal(); return; }
  if ($('card-ctx-menu')?.style.display === 'flex') { closeCardMenu(); return; }
  if ($('search-preview')?.classList.contains('show')) { clearSearch(); return; }
});

// Intercept all <a href> clicks: in Tauri, open them in the system browser
// instead of a new WebView window. Falls back to window.open in browser mode.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.href;
  if (!href || href.startsWith('javascript:') || href === window.location.href || href === window.location.href + '#') return;
  e.preventDefault();
  if (IS_TAURI) {
    invoke('open_url', { url: href }).catch(() => {});
  } else {
    window.open(href, '_blank', 'noopener,noreferrer');
  }
});
let ts=null, tsY=null, tsT=null;
$('read-area').addEventListener('touchstart',e=>{
  ts=e.touches[0].clientX; tsY=e.touches[0].clientY; tsT=Date.now();
},{passive:true});
$('read-area').addEventListener('touchend',e=>{
  if(ts===null)return;
  const dx=ts-e.changedTouches[0].clientX;
  const dy=tsY-e.changedTouches[0].clientY;
  const elapsed=Date.now()-tsT;
  ts=null; tsY=null; tsT=null;
  // Cancel if vertical movement dominates OR swipe is too slow
  if(Math.abs(dy)>Math.abs(dx)) return;
  if(Math.abs(dx)>50&&Math.abs(dx)/elapsed>0.25) {
    if (reader.rtl) dx>0?goPrev():goNext();
    else dx>0?goNext():goPrev();
  }
});
// Note: prog.onclick is wired in renderProgressSegs() on each chapter open —
// it handles both paged and strip seek, including RTL. No static handler here.

// ── Zoom & pan (paged mode) ──────────────────────────────────────────────────

function _clampPan() {
  const display = $('page-display');
  const pw = display.querySelector('.pw');
  if (!pw) return;
  const img = pw.querySelector('img');
  const natW = img?.naturalWidth  || 0;
  const natH = img?.naturalHeight || 0;
  // Skip clamp if image hasn't loaded yet
  if (!natW || !natH) return;
  const extraX = Math.max(0, (natW * reader.zoom - display.clientWidth)  / 2);
  const extraY = Math.max(0, (natH * reader.zoom - display.clientHeight) / 2);
  reader.panX = Math.max(-extraX, Math.min(extraX, reader.panX));
  reader.panY = Math.max(-extraY, Math.min(extraY, reader.panY));
}

function _applyTransform() {
  _clampPan();
  const display = $('page-display');
  for (const pw of display.children) {
    pw.style.transform = `translate(${reader.panX}px, ${reader.panY}px) scale(${reader.zoom})`;
    pw.style.transformOrigin = 'center center';
  }
}

function adjZ(d) {
  reader.zoom = Math.min(ZMAX, Math.max(ZMIN, reader.zoom + d));
  applyZ();
}

function applyZ() {
  if (reader.strip) {
    const maxW = Math.round(reader.zoom * 720) + 'px';
    for (const div of $('page-display').children) div.style.maxWidth = maxW;
  } else {
    if (reader.zoom === 1) { reader.panX = 0; reader.panY = 0; }
    _applyTransform();
    $('read-area').classList.toggle('panned', reader.zoom > 1);
  }
  $('ztxt').textContent = Math.round(reader.zoom * 100) + '%';
}

$('zi').onclick=()=>adjZ(ZSTEP);
$('zo').onclick=()=>adjZ(-ZSTEP);
$('read-area').addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); adjZ(e.deltaY < 0 ? ZSTEP : -ZSTEP); }
}, { passive: false });

// Drag-to-pan when zoomed in paged mode
(function() {
  const readArea = $('read-area');
  let isPanning = false, startX = 0, startY = 0, startPanX = 0, startPanY = 0;

  readArea.addEventListener('mousedown', e => {
    if (reader.zoom <= 1 || reader.strip) return;
    isPanning = true;
    startX = e.clientX; startY = e.clientY;
    startPanX = reader.panX; startPanY = reader.panY;
    readArea.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!isPanning) return;
    reader.panX = startPanX + (e.clientX - startX);
    reader.panY = startPanY + (e.clientY - startY);
    _applyTransform();
  });
  window.addEventListener('mouseup', () => {
    if (!isPanning) return;
    isPanning = false;
    readArea.classList.remove('dragging');
  });

  // Touch pan
  let tStartX = 0, tStartY = 0, tPanX = 0, tPanY = 0;
  readArea.addEventListener('touchstart', e => {
    if (reader.zoom <= 1 || reader.strip || e.touches.length !== 1) return;
    tStartX = e.touches[0].clientX; tStartY = e.touches[0].clientY;
    tPanX = reader.panX; tPanY = reader.panY;
  }, { passive: true });
  readArea.addEventListener('touchmove', e => {
    if (reader.zoom <= 1 || reader.strip || e.touches.length !== 1) return;
    reader.panX = tPanX + (e.touches[0].clientX - tStartX);
    reader.panY = tPanY + (e.touches[0].clientY - tStartY);
    _applyTransform();
    e.preventDefault();
  }, { passive: false });
})();

// Page jump input
$('page-jump').addEventListener('keydown', e => { if (e.key === 'Enter') $('page-jump').blur(); });
$('page-jump').addEventListener('change', function() {
  const n = parseInt(this.value);
  if (!isNaN(n) && reader.pages.length) {
    if (reader.strip) {
      // Value is a percentage — scroll to that position
      const display = $('page-display');
      if (display) {
        const pct = Math.max(0, Math.min(100, n)) / 100;
        display.scrollTo({ top: pct * (display.scrollHeight - display.clientHeight), behavior: 'smooth' });
      }
    } else {
      jump(Math.max(0, Math.min(reader.pages.length - 1, n - 1)));
    }
  } else {
    if (reader.strip) {
      const display = $('page-display');
      const maxScroll = display ? display.scrollHeight - display.clientHeight : 0;
      this.value = maxScroll > 0 ? Math.round((display.scrollTop / maxScroll) * 100) : 0;
    } else {
      this.value = reader.pages.length ? reader.curPage + 1 : '';
    }
  }
});
$('page-jump').addEventListener('focus', function() { this.select(); });

// Spread / Direction
const tSpread=$('t-spread'), tDir=$('t-dir');
if(tSpread) tSpread.onclick=function(){reader.spread=!reader.spread;setSetting('layout',reader.spread?'spread':'single');this.classList.toggle('on',reader.spread);if($('view-reader').classList.contains('active')){renderThumbs();renderPage();stat();}};
if(tDir) tDir.onclick=function(){reader.rtl=!reader.rtl;setSetting('direction',reader.rtl?'rtl':'ltr');this.textContent=reader.rtl?'◀ RTL':'LTR ▶';this.classList.toggle('on',!reader.rtl);if($('view-reader').classList.contains('active')){renderThumbs();renderPage();stat();}};
