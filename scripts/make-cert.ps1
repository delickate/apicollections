<#
  Creates a SELF-SIGNED code-signing certificate for signing the build.

  A self-signed certificate proves the installer has not been altered since you
  built it, and it makes the signing pipeline work end to end. It does NOT stop
  Windows SmartScreen's "unknown publisher" warning for other people, because no
  trusted authority vouches for it. For public distribution, buy an OV or EV
  code-signing certificate and point CSC_LINK / CSC_KEY_PASSWORD at it instead.

  Output (all git-ignored, never commit them):
    build/certs/code-sign.pfx        the certificate + private key
    build/certs/password.txt         the .pfx password (used by build.ps1)
    build/certs/code-sign.cer        public certificate, to trust on test machines

  Usage:
    npm run make-cert
    npm run make-cert -- -Subject "Your Company" -Password "yourPassword"
#>
param(
  [string]$Subject = "Delickate",
  [string]$Password = "",
  [int]$Years = 5
)

$ErrorActionPreference = "Stop"
$certDir = Join-Path $PSScriptRoot "..\build\certs"
New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$pfxPath = Join-Path $certDir "code-sign.pfx"
$cerPath = Join-Path $certDir "code-sign.cer"
$pwdPath = Join-Path $certDir "password.txt"

if ([string]::IsNullOrWhiteSpace($Password)) {
  # Generate a strong random password so nothing weak is hard-coded.
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Password = [Convert]::ToBase64String($bytes)
}

Write-Host "Creating a self-signed code-signing certificate for '$Subject'..."
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=$Subject" `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA `
  -KeyLength 3072 `
  -HashAlgorithm SHA256 `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears($Years) `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")

$securePwd = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePwd | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
Set-Content -Path $pwdPath -Value $Password -Encoding UTF8 -NoNewline

# Remove the key from the personal store; the .pfx is the source of truth now.
Remove-Item -Path ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Certificate : $pfxPath"
Write-Host "  Password    : $pwdPath  (keep private; already git-ignored)"
Write-Host "  Thumbprint  : $($cert.Thumbprint)"
Write-Host ""
Write-Host "Next: npm run dist:signed"
Write-Host "To silence SmartScreen on a TEST machine only, import build/certs/code-sign.cer"
Write-Host "into 'Trusted Root Certification Authorities'. Do not do this on machines you"
Write-Host "do not control."
