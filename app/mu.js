// ═══════════════════════════════════════════════════════════════
// MU (MangaUpdates Integration)
// Cover fetching, metadata cache, cover queue.
// Depends on: $, esc, IS_TAURI, invoke (utils.js)
//             muCache, muOverrides, coverIndex, saveMuCache,
//             saveCoverIndex (store.js)
// ═══════════════════════════════════════════════════════════════

function updateMuCacheStats() {
  const el = $('mu-cache-stats');
  if (!el) return;
  const total   = Object.keys(muCache).length;
  const found   = Object.values(muCache).filter(v => v !== null).length;
  const missing = total - found;
  const oldest  = Object.values(muCache).filter(v => v?.cachedAt).map(v => v.cachedAt).sort()[0];
  const ageStr  = oldest ? `oldest: ${Math.round((Date.now() - oldest) / 86400000)}d ago` : '';
  el.textContent = `${found} series cached${missing ? `, ${missing} not found` : ''}${ageStr ? ' · ' + ageStr : ''}`;
}

/** Re-fetch MU data for every cached series (runs sequentially to avoid hammering the API). */
async function refreshAllMuCache() {
  const keys = Object.keys(muCache);
  const btn = document.getElementById('mu-cache-refresh-btn');
  if (!keys.length) {
    if (btn) { const orig=btn.textContent; btn.textContent='NOTHING TO REFRESH'; setTimeout(()=>btn.textContent=orig,2000); }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = '↻ REFRESHING…'; }
  for (const name of keys) {
    await fetchMuInfo(name, true); // force=true bypasses cache
    await new Promise(r => setTimeout(r, 200)); // gentle throttle
  }
  // Clear muInfo on all loaded series so detail views re-render
  library.items.forEach(s => { s.muInfo = null; });
  if (btn) { btn.disabled = false; btn.textContent = '↻ REFRESH ALL'; }
  updateMuCacheStats();
}

/** Wipes the entire MU metadata cache. */
function clearAllMuCache() {
  const btn = document.getElementById('mu-cache-clear-btn');
  if (!btn) return;
  if (btn.dataset.confirming !== 'true') {
    btn.dataset.confirming = 'true';
    const orig = btn.textContent;
    btn.textContent = 'CONFIRM? TAP AGAIN';
    btn.style.borderColor = 'var(--accent)';
    btn.style.color = 'var(--accent)';
    setTimeout(() => {
      btn.dataset.confirming = 'false';
      btn.textContent = orig;
      btn.style.borderColor = '';
      btn.style.color = '';
    }, 3000);
    return;
  }
  btn.dataset.confirming = 'false';
  btn.style.borderColor = ''; btn.style.color = '';
  Object.keys(muCache).forEach(k => delete muCache[k]);
  saveMuCache();
  library.items.forEach(s => { s.muInfo = null; });
  updateMuCacheStats();
}

// ═══════════════════════════════════════════════════════════════
// MANGAUPDATES INTEGRATION
// ═══════════════════════════════════════════════════════════════

const MU_API  = 'https://api.mangaupdates.com/v1';

// keyed by series name — null = not found, object = info. Persisted across sessions.
// Entries older than 30 days are evicted on load so stale metadata doesn't accumulate
// indefinitely and exhaust the localStorage quota.
const MU_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
let muCache = {}; // populated in init() after loadAllData()

function _initMuCache() {
  const raw = getData('mu_cache.json');
  const now = Date.now();
  for (const key of Object.keys(raw)) {
    const entry = raw[key];
    if (entry?.cachedAt && (
      (now - entry.cachedAt) > MU_CACHE_TTL_MS ||
      !('status' in entry)
    )) {
      delete raw[key];
    }
  }
  muCache = raw;
}

function saveMuCache() {
  saveData('mu_cache.json', muCache);
}

/**
 * Searches MangaUpdates for a series by name and returns structured metadata.
 * Does a two-step fetch: search to find the best match, then a full series
 * lookup by ID to get authors and pub_status (not returned by the search endpoint).
 * Results are cached in localStorage so each name is only fetched once.
 * Pass force=true to bypass the cache and re-fetch from the API.
 *
 * @param {string}  name  - Series folder/display name.
 * @param {boolean} force - Skip cache and always hit the API.
 * @returns {Promise<object|null>}  Parsed info object, or null if not found.
 */
async function fetchMuInfo(name, force = false) {
  if (!force && Object.prototype.hasOwnProperty.call(muCache, name)) return muCache[name];
  const searchName = muOverrides[name]?.title || name;
  try {
    const data = await _muThrottle(() => muSearch(searchName, 5));
    const results = data.results || [];
    if (!results.length) { muCache[name] = null; saveMuCache(); return null; }
    const nl = name.toLowerCase();
    const best = results.find(r => (r.hit_title || r.record?.title || '').toLowerCase() === nl)
              || results[0];
    const slim = best.record || {};

    // Follow up with a full series fetch — the search result omits authors and pub_status.
    let full = slim;
    if (slim.series_id) {
      try { full = await _muThrottle(() => muFetchSeries(slim.series_id)); }
      catch(e) { console.warn('[MU] full series fetch failed for', name, '— falling back to slim record:', e); }
    }

    const stripHtml = s => (s || '')
      .replace(/<[^>]+>/g, '')           // HTML tags
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
      .replace(/https?:\/\/\S+/g, '')    // bare URLs
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\s{2,}/g, ' ')           // collapse extra whitespace
      .trim();
    const info = {
      id:          full.series_id  || slim.series_id,
      title:       full.title      || slim.title || name,
      url:         full.url        || slim.url   || `https://www.mangaupdates.com/series/${slim.series_id}`,
      description: stripHtml(full.description || slim.description),
      image:       full.image?.url?.original || full.image?.url?.thumb || slim.image?.url?.original || slim.image?.url?.thumb || null,
      thumb:       full.image?.url?.thumb    || full.image?.url?.original || slim.image?.url?.thumb || slim.image?.url?.original || null,
      year:        full.year       || slim.year   || null,
      // pub_status can be either an array [{status,volume,chapter},...] or a plain
      // object {status,volume,chapter} depending on the series. Handle both shapes.
      status: (() => {
        const ps = full.pub_status || slim.pub_status;
        if (!ps) return null;
        if (Array.isArray(ps)) return ps[0]?.status || null;
        return ps.status || null;
      })(),
      genres:      ((full.genres  || slim.genres  || []).map(g => g.genre).filter(Boolean).slice(0, 7)),
      authors:     ((full.authors || slim.authors || []).filter(a => a.type === 'Author').map(a => a.name).join(', '))
                || ((full.authors || slim.authors || []).map(a => a.name).join(', ')) || null,
      rating:      (full.bayesian_rating ?? slim.bayesian_rating) != null
                     ? Number(full.bayesian_rating ?? slim.bayesian_rating).toFixed(2)
                     : null,
      cachedAt:    Date.now(),
    };
    muCache[name] = info;
    saveMuCache();
    return info;
  } catch(e) {
    // Network / parse error — don't cache so the next request retries the API.
    // Only a confirmed "no results" response (handled above) writes null to the cache.
    console.warn('[MU] fetch failed for', name, e);
    return null;
  }
}

// ── MU global rate limiter ────────────────────────────────────────────────────
// All MU API calls (search + series fetch) must go through _muThrottle() so
// requests are always serialised with a minimum gap between them. This prevents
// 429s regardless of how many series are opened or queued simultaneously.
const MU_MIN_GAP_MS = 500; // minimum ms between any two MU API requests
let _muLastCall  = 0;
let _muQueueSize = 0;
let _muQueue     = Promise.resolve();

function _muThrottle(fn) {
  _muQueueSize++;
  const p = _muQueue.then(async () => {
    const wait = MU_MIN_GAP_MS - (Date.now() - _muLastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _muLastCall = Date.now();
    try {
      return await fn();
    } finally {
      // When the queue fully drains, reset to a fresh promise so the
      // entire chain becomes unreferenced and can be garbage collected.
      if (--_muQueueSize === 0) _muQueue = Promise.resolve();
    }
  });
  _muQueue = p;
  return p;
}
const _muCoverQ = [];
let   _muCoverRunning = false;

/**
 * Schedules a MangaUpdates cover lookup for `series`.
 * If MU returns no image, `fallback()` is called so a local
 * chapter page can be used instead.
 * @param {object}        series
 * @param {Function|null} fallback - async function called when MU has no cover
 */
/**
 * Applies MU metadata to the series hero panel DOM.
 * Used by both openSeries (full fetch) and _applyMuMetadataOnly (cover-indexed fast path).
 * @param {object} info  — MU info object from fetchMuInfo
 * @param {object} series — the local series object
 * @param {boolean} updateCover — whether to update the hero cover image
 */
function applyMuInfoToPanel(info, series, updateCover = false) {
  if (!info) return;
  series.muInfo = info;
  renderGenreBar();

  if (updateCover && (info.image || info.thumb)) {
    const muCover = info.image || info.thumb;
    setCoverUrl(series, muCover);
    $('hero').innerHTML = `<img src="${esc(muCover)}" alt="">`;
    _updateHeroBg(muCover);
    const card = getSeriesCard(series.name);
    if (card) { card.innerHTML = localCoverHTML(series); attachCardExtras(card, 'local:' + series.name, series, 'local'); }
  }

  if (info.authors) $('mu-author').innerHTML = `AUTHOR: <b>${esc(info.authors)}</b>`;

  // Clear the separate status row — status is now shown inline in the stat bar
  const statusEl = $('mu-status');
  if (statusEl) statusEl.innerHTML = '';

  // Inject year, status, and rating into the stat row alongside chapter count
  const sstatEl = $('sstat');
  if (sstatEl && (info.year || info.status || info.rating)) {
    const chCount = library.curSeries?.chapters.length ?? '';
    const parts = [`<b>${chCount}</b> <span style="color:var(--text-muted)">CHAPTERS</span>`];
    if (info.year) parts.push(`<span class="stat-divider"></span><span class="stat-year">${info.year}</span>`);
    if (info.status) {
      const s = info.status.toLowerCase();
      const cls = s.includes('complete') ? 'complete' : s.includes('hiatus') ? 'hiatus'
                : s.includes('cancel')   ? 'cancelled' : s.includes('ongoing') ? 'ongoing' : 'unknown';
      parts.push(`<span class="stat-divider"></span><span class="stat-status ${cls}">${info.status}</span>`);
    }
    if (info.rating) parts.push(`<span class="stat-divider"></span><span class="stat-rating">★ ${info.rating}</span>`);
    sstatEl.innerHTML = parts.join('');
  }

  if (info.description) $('mu-desc').textContent = info.description;
  if (info.genres?.length) $('mu-genres').innerHTML = info.genres.map(g => `<span class="mu-genre">${esc(g)}</span>`).join('');

  const muUrl = info.url || '';
  $('mu-link').href = (muUrl.startsWith('https://') || muUrl.startsWith('http://'))
    ? muUrl : `https://www.mangaupdates.com/series/${encodeURIComponent(info.id || '')}`;

  $('mu-meta').style.display    = '';
  $('mu-fetching').style.display = 'none';
}


async function _applyMuMetadataOnly(s) {
  const info = await fetchMuInfo(s.name);
  if (!info) return;
  if (library.curSeries?.name === s.name) {
    // Always sync the hero image and background — openSeries may have run before
    // the cover URL was available, leaving backgroundImage empty.
    const hero = $('hero');
    if (hero && s.coverUrl) {
      if (!hero.querySelector('img')) {
        hero.innerHTML = `<img src="${esc(s.coverUrl)}" alt="">`;
      }
      // Always call _updateHeroBg regardless of img presence: openSeries calls it
      // with series.coverUrl at render time, but that may have been null if the
      // cover hadn't loaded yet. This is the first guaranteed point where both
      // the series panel is open AND a cover URL is confirmed available.
      _updateHeroBg(s.coverUrl);
    }
    applyMuInfoToPanel(info, s, false);
  } else {
    s.muInfo = info;
    renderGenreBar();
  }
}

function enqueueMuCover(series, fallback = null) {
  _muCoverQ.push({ series, fallback });
  if (!_muCoverRunning) _drainMuCoverQ();
}

async function _drainMuCoverQ() {
  _muCoverRunning = true;
  while (_muCoverQ.length) {
    // Split the current queue into items whose metadata is already in the local
    // cache and items that will need a live MangaUpdates API call.
    // Cache hits are free — process them all in parallel with no throttle.
    // API misses must stay sequential and throttled to respect rate limits.
    const cached = [], uncached = [];
    for (const item of _muCoverQ.splice(0)) {
      (Object.prototype.hasOwnProperty.call(muCache, item.series.name) ? cached : uncached).push(item);
    }

    // Batch: all cache hits in parallel — covers appear simultaneously
    if (cached.length) {
      await Promise.all(cached.map(({ series: s, fallback }) => _applyCover(s, fallback)));
    }

    // Sequential: one API call at a time — global _muThrottle handles spacing
    for (const { series: s, fallback } of uncached) {
      await _applyCover(s, fallback);
    }
  }
  _muCoverRunning = false;
}

/** Resolves and applies the cover URL for a single series. */
async function _applyCover(s, fallback) {
  // Don't overwrite a manually set custom cover
  if (coverIndex[s.name]?.custom) return;

  const info = await fetchMuInfo(s.name);
  if (info?.thumb || info?.image) {
    const rawUrl = info.thumb || info.image;
    if (IS_TAURI && info.id) {
      try {
        const cachedPath = await invoke('cache_cover', {
          url: rawUrl,
          seriesId: String(info.id),
        });
        setCoverUrl(s, convertFileSrc(cachedPath));
        // Persist the mapping so next launch can skip cache_cover entirely
        const existing = coverIndex[s.name];
        if (!existing || (typeof existing === 'string' ? existing : existing.cachedPath) !== cachedPath) {
          coverIndex[s.name] = { cachedPath };
          saveCoverIndex();
        }
      } catch(e) {
        console.warn('[cover cache] failed for', s.name, e);
        setCoverUrl(s, rawUrl);
      }
    } else {
      setCoverUrl(s, rawUrl);
    }
    s.muInfo = info;
    const card = getSeriesCard(s.name);
    if (card) { card.innerHTML = localCoverHTML(s); attachCardExtras(card, 'local:'+s.name, s, 'local'); }
    // Also sync the hero section if this series is currently open — openSeries
    // may have called _updateHeroBg(null) before the cover was available.
    if (library.curSeries?.name === s.name) {
      const hero = $('hero');
      if (hero && !hero.querySelector('img')) {
        hero.innerHTML = `<img src="${esc(rawUrl)}" alt="">`;
      }
      _updateHeroBg(rawUrl);
    }
    renderGenreBar();
  } else if (fallback) {
    await fallback();
  }
}

