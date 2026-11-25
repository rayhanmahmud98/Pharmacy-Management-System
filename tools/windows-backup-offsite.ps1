<#
.SYNOPSIS
  Replicates verified MediNest PostgreSQL backup archives (.dump) to an off-site
  external USB drive or local network share with SHA-256 verification and pruning.

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\MediNest\tools\windows-backup-offsite.ps1" -SourceDir "C:\ProgramData\MediNest\backups" -DestinationDir "D:\MediNestOffsiteBackups" -RetainCount 30
#>

[CmdletBinding()]
param(
  [string]$SourceDir = "C:\ProgramData\MediNest\backups",
  [Parameter(Mandatory = $true)]
  [string]$DestinationDir,
  [int]$RetainCount = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path $SourceDir)) {
  throw "Source backup directory does not exist: $SourceDir"
}

if (-not (Test-Path $DestinationDir)) {
  New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null
}

$dumps = Get-ChildItem -Path $SourceDir -Filter "*.dump" -File | Sort-Object LastWriteTimeUtc -Descending
if ($dumps.Count -eq 0) {
  Write-Host "No .dump backup files found in $SourceDir."
  exit 0
}

$copied = 0
$verified = 0

foreach ($file in $dumps) {
  $destFile = Join-Path $DestinationDir $file.Name
  $srcHash = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash

  $needsCopy = $true
  if (Test-Path $destFile) {
    $destHash = (Get-FileHash -Path $destFile -Algorithm SHA256).Hash
    if ($destHash -eq $srcHash) {
      $needsCopy = $false
    }
  }

  if ($needsCopy) {
    $tmpDest = "$destFile.tmp"
    Copy-Item -Path $file.FullName -Destination $tmpDest -Force
    $tmpHash = (Get-FileHash -Path $tmpDest -Algorithm SHA256).Hash
    if ($tmpHash -ne $srcHash) {
      Remove-Item -Path $tmpDest -Force -ErrorAction SilentlyContinue
      throw "SHA-256 verification failed while copying $($file.Name) to off-site destination."
    }
    Move-Item -Path $tmpDest -Destination $destFile -Force
    Set-Content -Path "$destFile.sha256" -Value "$srcHash  $($file.Name)" -Encoding ASCII
    $copied++
  }
  $verified++
}

# Prune older off-site archives beyond RetainCount
if ($RetainCount -gt 0) {
  $offsiteDumps = Get-ChildItem -Path $DestinationDir -Filter "*.dump" -File | Sort-Object LastWriteTimeUtc -Descending
  if ($offsiteDumps.Count -gt $RetainCount) {
    $toRemove = $offsiteDumps | Select-Object -Skip $RetainCount
    foreach ($old in $toRemove) {
      Remove-Item -Path $old.FullName -Force -ErrorAction SilentlyContinue
      Remove-Item -Path "$($old.FullName).sha256" -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "Off-site backup sync complete. Total verified: $verified, Newly copied: $copied, Destination: $DestinationDir"
