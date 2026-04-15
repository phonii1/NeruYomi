#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// bump-version.js
// Reads the version from src-tauri/Cargo.toml and patches it
// into every file that hardcodes it as a fallback or display string.
//
// Usage:
//   node scripts/bump-version.js
//
// Wire into your build:
//   package.json → "tauri:build": "node scripts/bump-version.js && tauri build"
//
// Cargo.toml is the single source of truth — edit the version
// there only, then let this script propagate it everywhere else.
// ═══════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

// ── Read version from Cargo.toml ─────────────────────────────────────────────

const cargoPath = path.resolve(__dirname, '../src-tauri/Cargo.toml');
const cargo     = fs.readFileSync(cargoPath, 'utf8');
const match     = cargo.match(/^version\s*=\s*"([^"]+)"/m);

if (!match) {
  console.error('[bump-version] ERROR: Could not find version in', cargoPath);
  process.exit(1);
}

const version = match[1]; // e.g. "0.48.5"
console.log(`[bump-version] version from Cargo.toml: v${version}`);

// ── Patch targets ─────────────────────────────────────────────────────────────
//
// Each entry needs:
//   file        — path relative to the project root
//   pattern     — RegExp that matches the existing version string in that file
//   replacement — string (may reference `version`) to replace the match with
//
// Add more entries here whenever a new file hardcodes the version.

const patches = [
  {
    file:        'src/update.js',
    pattern:     /let _appVersion = '[^']+'/,
    replacement: `let _appVersion = '${version}'`,
    description: 'JS cold-start fallback in update.js',
  },
  {
    // Matches the <title> tag — preserves any suffix like 'b' after the number
    // e.g. "NeruYomi V0.48.5b"  →  "NeruYomi V0.49.0b"
    file:        'index.html',
    pattern:     /(NeruYomi V)\d+\.\d+\.\d+/gi,
    replacement: `$1${version}`,
    description: '<title> and comment header in index.html',
  },
];

// ── Apply patches ─────────────────────────────────────────────────────────────

let allOk = true;

for (const { file, pattern, replacement, description } of patches) {
  const fullPath = path.resolve(__dirname, '..', file);

  if (!fs.existsSync(fullPath)) {
    console.warn(`[bump-version] SKIP (file not found): ${file}`);
    continue;
  }

  const original = fs.readFileSync(fullPath, 'utf8');
  const updated  = original.replace(pattern, replacement);

  if (updated === original) {
    console.warn(`[bump-version] SKIP (no match — already up to date or pattern changed): ${file}`);
    console.warn(`               target: ${description}`);
    allOk = false;
    continue;
  }

  fs.writeFileSync(fullPath, updated, 'utf8');
  console.log(`[bump-version] OK: ${file}  (${description})`);
}

if (!allOk) {
  console.warn('[bump-version] Completed with warnings — review SKIPs above.');
} else {
  console.log(`[bump-version] All files patched to v${version}.`);
}
