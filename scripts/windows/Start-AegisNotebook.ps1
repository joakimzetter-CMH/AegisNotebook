<#
Idempotent starter for AegisNotebook's three dev-mode tiers (SurrealDB via
Docker, FastAPI, Next.js frontend) plus the background worker. Safe to run
repeatedly: each tier is skipped if it's already up.

Used two ways:
  - Registered as a Scheduled Task at Windows logon (silent, no -OpenBrowser).
  - Targeted by the "AegisNotebook.lnk" desktop shortcut (-OpenBrowser), which
    also covers the case where the login task hasn't run yet or a tier died.

All output is logged to %LOCALAPPDATA%\AegisNotebook\logs since a logon task
runs with no visible console.
#>

param(
    [switch]$OpenBrowser
)

$RepoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$FrontendDir = Join-Path $RepoRoot "frontend"
$LogDir = Join-Path $env:LOCALAPPDATA "AegisNotebook\logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$ScriptLog = Join-Path $LogDir "start.log"
function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $ScriptLog -Value $line
}

function Test-Port($port) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(500, $false)
        if ($ok) { $client.EndConnect($iar); $client.Close(); return $true }
        $client.Close()
        return $false
    } catch { return $false }
}

function Wait-ForPort($port, $timeoutSec, $label) {
    $elapsed = 0
    while (-not (Test-Port $port) -and $elapsed -lt $timeoutSec) {
        Start-Sleep -Seconds 2
        $elapsed += 2
    }
    if (Test-Port $port) { Log "$label ready on port $port" }
    else { Log "WARNING: $label did not become ready on port $port within ${timeoutSec}s" }
}

function Test-WorkerRunning {
    Get-CimInstance Win32_Process -Filter "Name = 'uv.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'surreal-commands-worker' } |
        Select-Object -First 1
}

Log "=== Start-AegisNotebook run (OpenBrowser=$OpenBrowser) ==="

# --- Docker Desktop ---------------------------------------------------
if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue)) {
    $dockerExe = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $dockerExe) {
        Log "Docker Desktop not running; starting it..."
        Start-Process $dockerExe
    } else {
        Log "WARNING: Docker Desktop executable not found at expected path"
    }
}

$dockerReady = $false
for ($i = 0; $i -lt 24; $i++) {
    docker info 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) { $dockerReady = $true; break }
    Start-Sleep -Seconds 5
}
if ($dockerReady) { Log "Docker daemon is ready" } else { Log "WARNING: Docker daemon not ready after 120s; continuing anyway" }

# --- SurrealDB (Docker) -------------------------------------------------
# Note: stderr is redirected to its own file rather than merged via 2>&1 -
# merging turns docker's normal progress chatter into PowerShell
# NativeCommandError records, which is noisy and can abort the script.
Push-Location $RepoRoot
try {
    $composeOutLog = Join-Path $LogDir "compose.log"
    $composeErrLog = Join-Path $LogDir "compose.err.log"
    docker compose up -d surrealdb 1>$composeOutLog 2>$composeErrLog
    if ($LASTEXITCODE -ne 0) {
        Log "WARNING: docker compose up exited with code $LASTEXITCODE (see compose.err.log)"
    } else {
        Log "docker compose up -d surrealdb succeeded"
    }
} finally {
    Pop-Location
}
Wait-ForPort 8000 30 "SurrealDB"

# --- API (FastAPI, port 5055) -------------------------------------------
if (Test-Port 5055) {
    Log "API already running on 5055"
} else {
    $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
    if ($uv) {
        Log "Starting API..."
        Start-Process -FilePath $uv `
            -ArgumentList "run --env-file .env run_api.py" `
            -WorkingDirectory $RepoRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir "api.log") `
            -RedirectStandardError (Join-Path $LogDir "api.err.log")
        Wait-ForPort 5055 60 "API"
    } else {
        Log "ERROR: uv not found on PATH; cannot start API"
    }
}

# --- Worker (surreal-commands-worker, no port) ---------------------------
if (Test-WorkerRunning) {
    Log "Worker already running"
} else {
    $uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
    if ($uv) {
        Log "Starting worker..."
        Start-Process -FilePath $uv `
            -ArgumentList "run --env-file .env surreal-commands-worker --import-modules commands --max-tasks 5" `
            -WorkingDirectory $RepoRoot `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir "worker.log") `
            -RedirectStandardError (Join-Path $LogDir "worker.err.log")
        Start-Sleep -Seconds 3
        if (Test-WorkerRunning) { Log "Worker started" } else { Log "WARNING: worker process not detected after start" }
    } else {
        Log "ERROR: uv not found on PATH; cannot start worker"
    }
}

# --- Frontend (Next.js dev, port 3000) ------------------------------------
if (Test-Port 3000) {
    Log "Frontend already running on 3000"
} else {
    $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if ($npm) {
        Log "Starting frontend..."
        Start-Process -FilePath $npm `
            -ArgumentList "run dev" `
            -WorkingDirectory $FrontendDir `
            -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $LogDir "frontend.log") `
            -RedirectStandardError (Join-Path $LogDir "frontend.err.log")
        Wait-ForPort 3000 60 "Frontend"
    } else {
        Log "ERROR: npm not found on PATH; cannot start frontend"
    }
}

Log "=== Run complete ==="

if ($OpenBrowser) {
    Wait-ForPort 3000 60 "Frontend"
    Start-Process "http://localhost:3000"
}
