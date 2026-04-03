# download-assets.ps1
# Run once from the directory that contains index.html.
# Downloads all font files and the PDF.js worker so the app works fully offline.
#
# Usage:  powershell -ExecutionPolicy Bypass -File .\download-assets.ps1

$ErrorActionPreference = 'Stop'

# Chrome UA is required — Google Fonts and Fontshare only serve woff2 to modern browsers
$ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

New-Item -ItemType Directory -Force -Path 'assets\fonts' | Out-Null

# ---------------------------------------------------------------------------
# Helper: fetch a CSS sheet and extract the URL that appears directly before
# format('woff2') — this works regardless of whether the URL itself ends in
# .woff2 (Fontshare uses dynamic serve endpoints that don't have extensions).
# ---------------------------------------------------------------------------
function Get-FontWoff2 {
    param(
        [string]$CssUrl,
        [string]$OutFile,
        [string]$Label
    )
    Write-Host "[$Label] Fetching CSS from $CssUrl ..."
    $css = (Invoke-WebRequest -Uri $CssUrl -UserAgent $ua -UseBasicParsing).Content

    # Match the URL that immediately precedes format('woff2') or format("woff2")
    $match = [regex]::Match($css, "url\(['""]?(https://[^'""\)]+)['""]?\)\s+format\(['""]woff2['""]?\)")
    if (-not $match.Success) {
        Write-Host "[$Label] CSS response was:"
        Write-Host $css
        throw "[$Label] Could not find a woff2 URL in the CSS response (see above)."
    }
    $fontUrl = $match.Groups[1].Value
    Write-Host "[$Label] Downloading from: $fontUrl"
    Invoke-WebRequest -Uri $fontUrl -UserAgent $ua -OutFile $OutFile -UseBasicParsing
    Write-Host "[$Label] Saved to $OutFile"
}

# ---------------------------------------------------------------------------
# 1. League Spartan — variable font (covers weights 100-900 in one file)
# ---------------------------------------------------------------------------
Get-FontWoff2 `
    -CssUrl 'https://fonts.googleapis.com/css2?family=League+Spartan:wght@100..900&display=swap' `
    -OutFile 'assets\fonts\LeagueSpartan-VariableFont_wght.woff2' `
    -Label '1/4 League Spartan'

# ---------------------------------------------------------------------------
# 2. Hachi Maru Pop
# ---------------------------------------------------------------------------
Get-FontWoff2 `
    -CssUrl 'https://fonts.googleapis.com/css2?family=Hachi+Maru+Pop&display=swap' `
    -OutFile 'assets\fonts\HachiMaruPop-Regular.woff2' `
    -Label '2/4 Hachi Maru Pop'

# ---------------------------------------------------------------------------
# 3. Family And Friends (Fontshare)
#    Try CSS extraction first. If Fontshare's API is down or changes format,
#    prompt the user to download it manually — the app falls back to Arial.
# ---------------------------------------------------------------------------
Write-Host "[3/4 Family And Friends] Trying CSS extraction..."
$fafSuccess = $false
try {
    Get-FontWoff2 `
        -CssUrl 'https://api.fontshare.com/v2/css?f[]=family-and-friends@400&display=swap' `
        -OutFile 'assets\fonts\FamilyAndFriends-Regular.woff2' `
        -Label '3/4 Family And Friends'
    $fafSuccess = $true
} catch {
    Write-Host ""
    Write-Host "[3/4 Family And Friends] Automatic download failed." -ForegroundColor Yellow
    Write-Host "To get this font manually:" -ForegroundColor Yellow
    Write-Host "  1. Go to https://www.fontshare.com/fonts/family-and-friends" -ForegroundColor Yellow
    Write-Host "  2. Click Download" -ForegroundColor Yellow
    Write-Host "  3. Extract the zip and copy any .woff2 file into assets\fonts\" -ForegroundColor Yellow
    Write-Host "  4. Rename it to FamilyAndFriends-Regular.woff2" -ForegroundColor Yellow
    Write-Host "  (The app will use Arial as a fallback in the meantime.)" -ForegroundColor Yellow
    Write-Host ""
}

# ---------------------------------------------------------------------------
# 4. PDF.js worker — must match the version of pdf.min.js already bundled
# ---------------------------------------------------------------------------
Write-Host "[4/4 PDF.js worker] Downloading..."
Invoke-WebRequest `
    -Uri 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js' `
    -OutFile 'pdf.worker.min.js' `
    -UseBasicParsing
Write-Host "[4/4 PDF.js worker] Saved to pdf.worker.min.js"

Write-Host ""
if ($fafSuccess) {
    Write-Host "All assets downloaded. The app is now fully offline." -ForegroundColor Green
} else {
    Write-Host "Done (Family And Friends requires a manual step above)." -ForegroundColor Yellow
    Write-Host "League Spartan, Hachi Maru Pop, and the PDF.js worker are ready." -ForegroundColor Green
}
