// ═══════════════════════════════════════════════════════════════
// UPDATE
// In-app update checker and installer (tauri-plugin-updater).
// Depends on: $, IS_TAURI (utils.js)
// ═══════════════════════════════════════════════════════════════

const RELEASES_URL = 'https://github.com/YOUR_USER/YOUR_REPO/releases/latest';

let _appVersion = '0.49.0';

/**
 * Resolves the running app version via the Tauri v2 app plugin API so it
 * always matches Cargo.toml rather than the hardcoded fallback above.
 * Returns the hardcoded fallback in browser dev mode or if the call fails.
 *
 * NOTE: The init block in index.html also calls this at startup to populate
 * _appVersion before any update UI is shown. Both paths use the same function
 * so there is a single source of truth.
 */
async function getAppVersion() {
  if (!IS_TAURI) return _appVersion;
  try {
    return await window.__TAURI__.app.getVersion();
  } catch(_) {}
  return _appVersion;
}

/**
 * Checks for an available update via tauri-plugin-updater.
 * Returns the update object if one is available and the plugin confirmed
 * it has a compatible asset for the current platform, null otherwise.
 * Distinguishes between "no update" (returns null cleanly) and a network/
 * parse failure (logs a warning and returns null with _updateCheckFailed set).
 */
let _updateCheckFailed = false;

async function checkForUpdates(silent = false) {
  if (!IS_TAURI) return null;
  _updateCheckFailed = false;
  try {
    const { check } = window.__TAURI__.updater;
    const update = await check();
    // check() returns null/undefined when already up to date, or an object
    // when an update is available. Treat falsy as "up to date", not failure.
    return update || null;
  } catch(e) {
    _updateCheckFailed = true;
    if (!silent) console.warn('[update] check failed:', e);
    return null;
  }
}

/**
 * Shows the update notification banner.
 * The "UPDATE NOW" button is only rendered when the plugin confirmed it has
 * a compatible platform asset — i.e. update.downloadAndInstall exists.
 * A "Download ↗" link is always shown as a fallback so the user is never
 * stranded if the in-app update path fails or is unavailable.
 *
 * @param {object} update — update object returned by tauri-plugin-updater check()
 */
function showUpdateBanner(update) {
  const banner = $('update-banner');
  banner.innerHTML = '';

  const label = document.createElement('span');
  label.textContent = `NeruYomi v${update.version} is available`;

  // Guard: only show the in-app button when the plugin has a downloadable asset.
  // If the platform installer wasn't found the user can still reach the release
  // page via the fallback link below.
  const canAutoUpdate = typeof update.downloadAndInstall === 'function';
  if (canAutoUpdate) {
    const updateBtn = document.createElement('button');
    updateBtn.className = 'btn primary';
    updateBtn.style.cssText = 'font-size:9px;padding:4px 10px;letter-spacing:0.5px;flex-shrink:0';
    updateBtn.textContent = '↻ UPDATE NOW';
    updateBtn.addEventListener('click', () => autoUpdate(update));
    banner.appendChild(label);
    banner.appendChild(updateBtn);
  } else {
    banner.appendChild(label);
  }

  const spacer = document.createElement('div');
  spacer.id = 'update-banner-spacer';

  // Fallback link — always present so the user can get to the release page
  // even if the in-app download isn't available for their platform.
  const link = document.createElement('a');
  link.textContent = 'Download ↗';
  link.style.cssText = 'flex-shrink:0';
  link.addEventListener('click', () => invoke('open_url', { url: RELEASES_URL }));

  const dismiss = document.createElement('button');
  dismiss.id = 'update-banner-dismiss';
  dismiss.textContent = '✕';
  dismiss.title = 'Dismiss';
  dismiss.addEventListener('click', () => { banner.style.display = 'none'; });

  banner.appendChild(spacer);
  banner.appendChild(link);
  banner.appendChild(dismiss);
  banner.style.display = 'flex';
}

/**
 * Downloads and installs the update via tauri-plugin-updater, showing a
 * live progress bar in the banner while the download runs.
 *
 * On success: relaunches the app automatically (seamless update).
 * On failure: shows the error inline with a retry button AND keeps the
 *             fallback "Download ↗" link visible so the user isn't stranded.
 *
 * @param {object} update — update object from tauri-plugin-updater check()
 */
async function autoUpdate(update) {
  const banner = $('update-banner');
  banner.innerHTML = '';

  const label = document.createElement('span');
  label.id = 'update-dl-label';
  label.textContent = 'Downloading…';
  label.style.flexShrink = '0';

  const barWrap = document.createElement('div');
  barWrap.id = 'update-progress-bar';
  const fill = document.createElement('div');
  fill.id = 'update-progress-fill';
  barWrap.appendChild(fill);

  const dismiss = document.createElement('button');
  dismiss.id = 'update-banner-dismiss';
  dismiss.textContent = '✕';
  dismiss.title = 'Dismiss';
  dismiss.addEventListener('click', () => { banner.style.display = 'none'; });

  banner.appendChild(label);
  banner.appendChild(barWrap);
  banner.appendChild(dismiss);

  try {
    let downloaded = 0, total = 0;
    await update.downloadAndInstall(event => {
      if (event.event === 'Started')  { total = event.data.contentLength ?? 0; }
      if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        const lbl = $('update-dl-label');
        const bar = $('update-progress-fill');
        if (lbl) lbl.textContent = total > 0 ? `Downloading… ${pct}%` : 'Downloading…';
        if (bar) bar.style.width = pct + '%';
      }
      if (event.event === 'Finished') {
        const bar = $('update-progress-fill');
        if (bar) bar.style.width = '100%';
      }
    });

    // Relaunch to apply the update — seamless, no manual action needed.
    const { relaunch } = window.__TAURI__.process;
    await relaunch();

  } catch(e) {
    // ── Download/install failed ───────────────────────────────────
    // Show the error, a retry button, and restore the fallback download
    // link so the user can always reach the release page manually.
    const lbl = $('update-dl-label');
    if (lbl) { lbl.textContent = `Update failed: ${e}`; lbl.style.color = 'var(--status-error)'; }

    const barEl = $('update-progress-bar');
    if (barEl) {
      const retry = document.createElement('button');
      retry.className = 'btn';
      retry.style.cssText = 'font-size:9px;padding:3px 8px;flex-shrink:0';
      retry.textContent = '↻ RETRY';
      retry.addEventListener('click', () => autoUpdate(update));
      barEl.replaceWith(retry);
    }

    // Re-append the fallback link after the error UI is built
    const link = document.createElement('a');
    link.textContent = 'Download ↗';
    link.style.cssText = 'flex-shrink:0;margin-left:6px';
    link.addEventListener('click', () => invoke('open_url', { url: RELEASES_URL }));
    banner.appendChild(link);
  }
}

/**
 * Manual update check triggered from the Settings panel.
 * Distinguishes three states: update available, up to date, and check failed
 * (e.g. offline) — the original update.js collapsed the latter two into one,
 * which could mislead the user into thinking they were current when offline.
 */
async function manualCheckUpdate() {
  if (!IS_TAURI) return;
  const el = $('update-status');
  el.textContent = 'CHECKING…';
  el.style.color = 'var(--text-dim)';
  el.style.cursor = 'default';
  el.onclick = null;

  // Refresh _appVersion in case it wasn't resolved at startup
  _appVersion = await getAppVersion();

  const update = await checkForUpdates(false);

  if (_updateCheckFailed) {
    el.textContent = 'CHECK FAILED — OFFLINE?';
    el.style.color = 'var(--status-error)';
    setTimeout(() => {
      el.textContent = `CURRENT: v${_appVersion}`;
      el.style.color = 'var(--text-dim)';
    }, 1000);
    return;
  }

  if (!update) {
    el.textContent = `UP TO DATE (v${_appVersion})`;
    el.style.color = 'var(--status-ok)';
    setTimeout(() => {
      el.textContent = `CURRENT: v${_appVersion}`;
      el.style.color = 'var(--text-dim)';
    }, 3000);
    return;
  }

  el.textContent = `v${update.version} AVAILABLE ↗`;
  el.style.color = 'var(--accent)';
  el.style.cursor = 'pointer';
  el.onclick = () => invoke('open_url', { url: RELEASES_URL });
  showUpdateBanner(update);
}
