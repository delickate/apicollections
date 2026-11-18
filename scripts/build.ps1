<#
  Builds the signed installer + portable exe with electron-builder.

  It reads the self-signed certificate made by make-cert.ps1 and passes it to
  electron-builder through the standard CSC_LINK / CSC_KEY_PASSWORD environment
  variables, so the password is never written into package.json. Swap in a real
  OV/EV certificate by setting those two variables yourself and running
  `npm run dist` instead.

  Usage:  npm run dist:signed
#>
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$pfx = "build\certs\code-sign.pfx"
$pwdFile = "build\certs\password.txt"

if (-not (Test-Path $pfx) -or -not (Test-Path $pwdFile)) {
  Write-Host "No signing certificate found at $pfx." -ForegroundColor Yellow
  Write-Host "Run 'npm run make-cert' first, or 'npm run dist' to build unsigned."
  exit 1
}

# ELECTRON_RUN_AS_NODE is set in some host shells; it would break electron-builder's
# helper electron processes, so clear it for this build.
$env:ELECTRON_RUN_AS_NODE = $null

$env:CSC_LINK = (Resolve-Path $pfx).Path
$env:CSC_KEY_PASSWORD = (Get-Content $pwdFile -Raw)

Write-Host "Building signed installer + portable exe..." -ForegroundColor Cyan
npx electron-builder --win nsis portable --x64
$code = $LASTEXITCODE

$env:CSC_LINK = $null
$env:CSC_KEY_PASSWORD = $null

if ($code -ne 0) { exit $code }
Write-Host ""
Write-Host "Build complete. Artifacts are in the 'dist' folder." -ForegroundColor Green
