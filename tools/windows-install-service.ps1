<#
.SYNOPSIS
  Registers and configures MediNest as a persistent Windows Service via NSSM
  with PostgreSQL dependency ordering, rotating stdout/stderr logs, auto-restart,
  and a Private-profile Windows Defender Firewall rule for TCP port 3000.

.DESCRIPTION
  Run this script as Administrator on the Windows Server / host PC after:
    1. PostgreSQL 15+ is installed and initialized.
    2. .env is configured in the MediNest installation directory.
    3. npm install && npm run build have completed.
    4. NSSM (nssm.exe) is available in PATH or passed via -NssmPath.
#>

[CmdletBinding()]
param(
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$ServiceName = "MediNestServer",
  [string]$PgServiceName = "",
  [string]$NodePath = "",
  [string]$NssmPath = "nssm.exe",
  [int]$Port = 3000,
  [string]$DataDir = "C:\ProgramData\MediNest"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# 1. Verify Administrator privileges
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Please run PowerShell as Administrator to install the Windows Service and Firewall rule."
}

# 2. Verify build artifacts and .env
$serverEntry = Join-Path $AppDir "server.ts"
$distEntry = Join-Path $AppDir "dist\index.html"
$envFile = Join-Path $AppDir ".env"

if (-not (Test-Path $serverEntry)) {
  throw "Could not find server.ts in $AppDir"
}
if (-not (Test-Path $distEntry)) {
  throw "Production frontend build missing ($distEntry). Run 'npm run build' first."
}
if (-not (Test-Path $envFile)) {
  throw "Missing .env file in $AppDir. Copy .env.example to .env and configure PostgreSQL credentials first."
}

# 3. Resolve Node.js v22+ and NSSM
if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $NodePath = $nodeCmd.Source
  } elseif (Test-Path "C:\Program Files\nodejs\node.exe") {
    $NodePath = "C:\Program Files\nodejs\node.exe"
  } else {
    throw "Could not locate node.exe. Install Node.js 22 LTS or pass -NodePath."
  }
}

$nssmCmd = Get-Command $NssmPath -ErrorAction SilentlyContinue
if (-not $nssmCmd) {
  throw "Could not locate NSSM ($NssmPath). Download NSSM and add it to PATH or pass -NssmPath."
}
$ResolvedNssm = $nssmCmd.Source

# 4. Auto-detect installed PostgreSQL Windows Service if not specified
if ([string]::IsNullOrWhiteSpace($PgServiceName)) {
  $pgSvc = Get-Service -Name "postgresql*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pgSvc) {
    $PgServiceName = $pgSvc.Name
    Write-Host "Detected PostgreSQL Windows Service: $PgServiceName" -ForegroundColor Cyan
  } else {
    Write-Warning "No postgresql* service detected automatically. Continuing without DependOnService."
  }
}

# 5. Prepare persistent data & log directories
$LogDir = Join-Path $DataDir "logs"
$BackupDir = Join-Path $DataDir "backups"
$UploadDir = Join-Path $DataDir "uploads"
foreach ($dir in @($DataDir, $LogDir, $BackupDir, $UploadDir)) {
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
}

# 6. Install or reconfigure NSSM service cleanly
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Stopping existing $ServiceName service before updating configuration..." -ForegroundColor Yellow
  if ($existing.Status -ne "Stopped") {
    & $ResolvedNssm stop $ServiceName | Out-Null
    Start-Sleep -Seconds 2
  }
  & $ResolvedNssm set $ServiceName Application $NodePath | Out-Null
  & $ResolvedNssm set $ServiceName AppParameters "`"$serverEntry`"" | Out-Null
} else {
  & $ResolvedNssm install $ServiceName $NodePath "`"$serverEntry`"" | Out-Null
}

& $ResolvedNssm set $ServiceName DisplayName "MediNest Pharmacy Management Server" | Out-Null
& $ResolvedNssm set $ServiceName Description "MediNest POS, Inventory & Accounting Server (PostgreSQL-backed)" | Out-Null
& $ResolvedNssm set $ServiceName AppDirectory $AppDir | Out-Null
& $ResolvedNssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $ResolvedNssm set $ServiceName AppEnvironmentExtra "NODE_ENV=production" "PORT=$Port" | Out-Null
& $ResolvedNssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $ResolvedNssm set $ServiceName AppExit Default Restart | Out-Null

# Log capture and 10 MB rotation
& $ResolvedNssm set $ServiceName AppStdout (Join-Path $LogDir "medinest-stdout.log") | Out-Null
& $ResolvedNssm set $ServiceName AppStderr (Join-Path $LogDir "medinest-stderr.log") | Out-Null
& $ResolvedNssm set $ServiceName AppRotateFiles 1 | Out-Null
& $ResolvedNssm set $ServiceName AppRotateOnline 1 | Out-Null
& $ResolvedNssm set $ServiceName AppRotateBytes 10485760 | Out-Null

if (-not [string]::IsNullOrWhiteSpace($PgServiceName)) {
  & $ResolvedNssm set $ServiceName DependOnService $PgServiceName | Out-Null
}

# 7. Configure Private-profile Windows Defender Firewall rule for TCP port (keep 5432 closed)
$RuleName = "MediNest LAN Server (TCP $Port)"
$existingRule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
if (-not $existingRule) {
  New-NetFirewallRule `
    -DisplayName $RuleName `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Private `
    -Action Allow `
    -Description "Allows counter terminals on the Private pharmacy LAN to access MediNest HTTP server." | Out-Null
  Write-Host "Created Private-profile firewall rule: $RuleName" -ForegroundColor Green
} else {
  Write-Host "Firewall rule already exists: $RuleName" -ForegroundColor Cyan
}

# 8. Start service and run local health probe
Write-Host "Starting service $ServiceName..." -ForegroundColor Cyan
& $ResolvedNssm start $ServiceName | Out-Null
Start-Sleep -Seconds 3

$healthUrl = "http://127.0.0.1:$Port/api/health"
try {
  $resp = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10
  Write-Host "Health check OK: $($resp | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
  Write-Warning "Service started, but $healthUrl did not respond immediately. Check $LogDir\medinest-stderr.log."
}
