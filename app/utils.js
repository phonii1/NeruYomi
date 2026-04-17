// ═══════════════════════════════════════════════════════════════
// UTILS
// Pure helpers — no app state, no DOM side-effects at load time.
// Everything here can be imported by any other module.
// ═══════════════════════════════════════════════════════════════

// ── Tauri bridge ─────────────────────────────────────────────────────────────

const IS_TAURI = !!window.__TAURI_INTERNALS__ || !!window.__TAURI__;
const invoke = IS_TAURI
  ? (...args) => (window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke)(...args)
  : () => Promise.reject(new Error('[NeruYomi] invoke() called outside of Tauri context'));

/**
 * Converts a local file path to a Tauri asset protocol URL so the WebView
 * can load it directly from disk — no IPC, no base64, no JS decode.
 * Tries the stable public API first (available when withGlobalTauri: true),
 * falls back to manual construction that normalizes Windows backslashes.
 */
function convertFileSrc(path) {
  if (window.__TAURI__?.core?.convertFileSrc) return window.__TAURI__.core.convertFileSrc(path);
  // Normalize backslashes → forward slashes, then encode each segment.
  // Encoding the full path with encodeURIComponent encodes backslashes as
  // %5C which WebView2 on Windows doesn't reliably decode for asset routing.
  const encoded = path.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
  return navigator.userAgent.includes('Windows')
    ? `http://asset.localhost/${encoded}`   // Tauri on Windows uses http, not https
    : `asset://localhost/${encoded}`;
}

const HAS_FSAPI = ('showDirectoryPicker' in window);

// ── DOM shorthand ─────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ── HTML escaping ─────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

// ── CSS value validation ──────────────────────────────────────────────────────

/**
 * Validates a CSS color value loaded from storage (e.g. localStorage) before
 * injecting it into a style attribute. Accepts hex colors only (#rgb, #rrggbb,
 * #rrggbbaa). Falls back to a safe default so a tampered value can never break
 * out of the style context or inject arbitrary CSS.
 */
const safeColor = (c, fallback = '#000000') =>
  /^#[0-9a-fA-F]{3,8}$/.test(String(c ?? '')) ? c : fallback;

/**
 * Clamps a numeric theme value (loaded from storage) to a safe range.
 * Returns `def` if the value is not a finite number.
 */
const clampInt = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

// ── Color math ────────────────────────────────────────────────────────────────

function hexToHsl(hex) {
  let r = parseInt(hex.slice(1,3),16)/255,
      g = parseInt(hex.slice(3,5),16)/255,
      b = parseInt(hex.slice(5,7),16)/255;
  const max=Math.max(r,g,b), min=Math.min(r,g,b);
  let h, s, l=(max+min)/2;
  if (max===min) { h=s=0; }
  else {
    const d=max-min;
    s=l>0.5 ? d/(2-max-min) : d/(max+min);
    switch(max){
      case r: h=((g-b)/d+(g<b?6:0))/6; break;
      case g: h=((b-r)/d+2)/6; break;
      case b: h=((r-g)/d+4)/6; break;
    }
  }
  return [h*360, s*100, l*100];
}

function hslToHex(h, s, l) {
  h/=360; s/=100; l/=100;
  let r,g,b;
  if (s===0) { r=g=b=l; }
  else {
    const q=l<0.5?l*(1+s):l+s-l*s, p=2*l-q;
    const hue2rgb=(p,q,t)=>{
      if(t<0)t+=1; if(t>1)t-=1;
      if(t<1/6)return p+(q-p)*6*t;
      if(t<1/2)return q;
      if(t<2/3)return p+(q-p)*(2/3-t)*6;
      return p;
    };
    r=hue2rgb(p,q,h+1/3); g=hue2rgb(p,q,h); b=hue2rgb(p,q,h-1/3);
  }
  return '#'+[r,g,b].map(x=>Math.round(x*255).toString(16).padStart(2,'0')).join('');
}

function shiftL(hex, delta) {
  let [h,s,l]=hexToHsl(hex);
  return hslToHex(h, s, Math.max(0,Math.min(100,l+delta)));
}

function hexAlpha(hex, a) {
  const r=parseInt(hex.slice(1,3),16),
        g=parseInt(hex.slice(3,5),16),
        b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

function isDark(hex) { return hexToHsl(hex)[2] < 50; }

// ── Reader constants ──────────────────────────────────────────────────────────

const ZSTEP = 0.15, ZMIN = 0.3, ZMAX = 3;

// ── File type helpers ─────────────────────────────────────────────────────────

const IMG_EXT = new Set(['jpg','jpeg','png','webp','gif','avif','bmp','svg','tif','tiff']);
const isImg  = n => { const i = n.lastIndexOf('.'); return i !== -1 && IMG_EXT.has(n.slice(i + 1).toLowerCase()); };
const isPdf  = n => { const i = n.lastIndexOf('.'); return i !== -1 && n.slice(i + 1).toLowerCase() === 'pdf'; };
const isCbz  = n => { const i = n.lastIndexOf('.'); return i !== -1 && n.slice(i + 1).toLowerCase() === 'cbz'; };

/** Returns the MIME type for an image file based on its extension. */
function _imgMimeType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp'
       : ext === 'gif' ? 'image/gif' : ext === 'avif' ? 'image/avif' : 'image/jpeg';
}

/** Converts a base64 string (from read_cbz_entry) to a blob URL. */
function _base64ToUrl(b64, mimeType) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}

// ── Natural sort ──────────────────────────────────────────────────────────────

const natCmp = (a,b) => a.localeCompare(b,undefined,{numeric:true,sensitivity:'base'});

// ── Chapter name parsing ──────────────────────────────────────────────────────

/**
 * Parses a manga chapter folder name into [volume, chapter] numeric keys.
 *
 * Handles formats such as:
 *   "Vol.02 Ch.0006.2 - Because You're Special (Part 2) (en) [Group]"
 *   "Ch.006.5 - Title"
 *   "Chapter 001"
 *   "Volume 2 Chapter 10"
 *   Chapters with no volume prefix (treated as vol 0)
 *
 * @param {string} name - Folder/file name to parse.
 * @returns {[number, number]} [volume, chapter] — chapter may be fractional (e.g. 6.2).
 */
function parseChapterKey(name) {
  let vol = 0, ch = -1;

  // Volume: "Vol.02", "Vol 2", "Volume 02", "Volume2", "v03" (bare v prefix)
  const volMatch = name.match(/(?:vol(?:ume)?|\bv)([ ._-]*(\d+))/i);
  if (volMatch) vol = parseInt(volMatch[2], 10);

  // Chapter: "Ch.0006.2", "Ch 6.2", "Chapter 006", "Chapter6.5"
  const chMatch = name.match(/ch(?:apter)?[\s._-]*(\d+(?:[._]\d+)?)/i);
  if (chMatch) {
    // Normalise separator so "0006.2" and "0006_2" both become 6.2
    ch = parseFloat(chMatch[1].replace('_', '.'));
  }

  // Fallback: first numeric run that isn't a 4-digit year (e.g. 2023)
  // A bare volume number like "v03" has already been captured above so
  // we skip any number already used as vol to avoid double-counting.
  if (ch === -1) {
    // Only match standalone numbers — skip those adjacent to letters (e.g. group tags like '1r0n')
    const numRe = /(?<!\w)(\d+(?:[._]\d+)?)(?!\w)/g;
    let m;
    while ((m = numRe.exec(name)) !== null) {
      const n = parseFloat(m[1].replace('_', '.'));
      // Skip 4-digit years and the volume number we already parsed
      if (m[1].length === 4 && n > 1900 && n < 2100) continue;
      if (n === vol && vol !== 0) continue;
      ch = n;
      break;
    }
    if (ch === -1) ch = 0;
  }

  return [vol, ch];
}

/**
 * Comparator for chapter folder/file names.
 * Sorts by chapter number only (decimals like 6.5 supported).
 * Volume is displayed but not used for ordering.
 * Falls back to natCmp for equal chapter numbers.
 */
function chapterCmp(a, b) {
  const [, ca] = parseChapterKey(a);
  const [, cb] = parseChapterKey(b);
  if (ca !== cb) return ca - cb;
  return natCmp(a, b);
}

/** Strips Vol/Ch prefix, language tag, and group name from a folder name. */
function cleanChTitle(raw) {
  return raw
    .replace(/^vol(?:ume)?[\s._-]*\d+[\s._-]*/i, '')
    .replace(/^ch(?:apter)?[\s._-]*[\d.]+[\s._-]*/i, '')
    .replace(/\s*\((?:en|jp|es|fr|de|ko|zh|pt|ru|ar|it|pl)\)/gi, '')
    .replace(/\s*\[[^\]]+\]\s*$/g, '')
    .trim();
}

/** Extracts group name from [Group Name] at end of folder name. */
function extractGroup(raw) {
  const m = raw.match(/\[([^\]]+)\]\s*$/);
  return m ? m[1] : '';
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024)               return `${bytes} B`;
  if (bytes < 1024 * 1024)        return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// ── Reader placeholder images ─────────────────────────────────────────────────

const BLANK = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
const LOADING_PAGE = 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#111"/><text x="200" y="306" text-anchor="middle" fill="#f5f5f5" font-family="monospace" font-size="13">LOADING…</text></svg>');
const CONN_LOST_SVG = 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#111"/><text x="200" y="290" text-anchor="middle" fill="#b89ee8" font-family="monospace" font-size="13">FAILED TO LOAD</text><text x="200" y="315" text-anchor="middle" fill="#9690a2" font-family="monospace" font-size="11">Image could not be read from disk</text></svg>');

// ── Icons (Lucide MIT) ────────────────────────────────────────────────────────

const _svg = (paths, size = 16) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICON = {
  // Navigation
  back:    _svg('<path d="M19 12H5"/><path d="m12 5-7 7 7 7"/>'),
  forward: _svg('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  rescan:  _svg('<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>'),
  // App actions
  settings:  _svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  bookmark:  _svg('<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>'),
  identify:  _svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'),
  dots:      _svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),
  cover:     _svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'),
  folder:    _svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
};
