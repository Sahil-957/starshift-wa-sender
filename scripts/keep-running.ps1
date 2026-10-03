# Keeps the licence backend and its ngrok tunnel up.
# Checks both every 30 seconds and restarts whichever one has died.
# Started automatically at logon by install-autostart.ps1; can also be run by hand.

$ErrorActionPreference = "Stop"

$Root     = Split-Path -Parent $PSScriptRoot
$Backend  = Join-Path $Root "backend"
$LogDir   = Join-Path $Root "logs"
$Domain   = "civic-facsimile-dimly.ngrok-free.dev"
$Interval = 30          # seconds between checks
$MaxLog   = 5MB         # truncate a log once it grows past this

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force $LogDir | Out-Null }

# PORT lives in backend/.env - read it so the two stay in step.
$Port = 5001
$envFile = Join-Path $Backend ".env"
if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
    if ($line) { $Port = [int]$line.Matches[0].Groups[1].Value }
}

function Write-Log($msg) {
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $path = Join-Path $LogDir "watchdog.log"
    if ((Test-Path $path) -and ((Get-Item $path).Length -gt $MaxLog)) { Clear-Content $path }
    Add-Content -Path $path -Value "$stamp  $msg" -Encoding utf8
}

function Test-Port($p) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $client.Connect("127.0.0.1", $p)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

# The tunnel is only really up when ngrok's local API reports it online.
function Test-Tunnel {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 5
        foreach ($t in $r.tunnels) { if ($t.public_url -like "*$Domain*") { return $true } }
        return $false
    } catch {
        return $false
    }
}

function Trim-Log($path) {
    if ((Test-Path $path) -and ((Get-Item $path).Length -gt $MaxLog)) { Clear-Content $path }
}

function Start-Backend {
    $out = Join-Path $LogDir "backend.log"
    $err = Join-Path $LogDir "backend.err.log"
    Trim-Log $out; Trim-Log $err
    Start-Process -FilePath "node" -ArgumentList "server.js" `
        -WorkingDirectory $Backend -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err
    Write-Log "started backend on port $Port"
}

function Start-Tunnel {
    # Any stale agent holds the reserved domain, and the free plan allows only one.
    Get-Process ngrok -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $out = Join-Path $LogDir "ngrok.log"
    $err = Join-Path $LogDir "ngrok.err.log"
    Trim-Log $out; Trim-Log $err
    Start-Process -FilePath "ngrok" -ArgumentList "http", "$Port", "--domain=$Domain", "--log=stdout" `
        -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
    Write-Log "started ngrok tunnel -> https://$Domain"
}

Write-Log "watchdog up (port $Port, domain $Domain)"

while ($true) {
    try {
        if (-not (Test-Port $Port)) {
            Write-Log "backend is down"
            Start-Backend
            Start-Sleep -Seconds 4   # let it bind before ngrok is checked
        }
        if (-not (Test-Tunnel)) {
            Write-Log "tunnel is down"
            Start-Tunnel
        }
    } catch {
        Write-Log "check failed: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds $Interval
}
