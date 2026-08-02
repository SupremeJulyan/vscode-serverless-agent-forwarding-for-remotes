# Windows-side launcher for the TCP relay.
param(
    [Parameter(Mandatory = $true)]
    [string]$RelayScript,

    [Parameter(Mandatory = $true)]
    [string]$TargetHost,

    [int]$TargetPort = 22,

    [double]$IdleExitSeconds = 0
)

$ErrorActionPreference = "Stop"

$python = & py.exe -3 -c "import sys; print(sys.executable)"
if (-not $python -or -not (Test-Path $python)) {
    throw "Windows Python 3 executable was not found"
}

$probe = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
)
$probe.Start()
$listenPort = ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port
$probe.Stop()

$arguments = @(
    $RelayScript,
    "--listen-host", "127.0.0.1",
    "--listen-port", $listenPort,
    "--target-host", $TargetHost,
    "--target-port", $TargetPort
)
if ($IdleExitSeconds -gt 0) {
    $arguments += @("--idle-exit-seconds", $IdleExitSeconds)
}
$process = Start-Process `
    -FilePath $python `
    -ArgumentList $arguments `
    -WindowStyle Hidden `
    -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if ($process.HasExited) {
        throw "Relay exited during startup with code $($process.ExitCode)"
    }
    $listener = Get-NetTCPConnection `
        -State Listen `
        -LocalAddress 127.0.0.1 `
        -LocalPort $listenPort `
        -ErrorAction SilentlyContinue |
        Where-Object OwningProcess -eq $process.Id
    if ($listener) {
        $ready = $true
        break
    }
    Start-Sleep -Milliseconds 100
}

if (-not $ready) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "Relay did not listen on 127.0.0.1:$listenPort"
}

[pscustomobject]@{
    pid = $process.Id
    port = $listenPort
} | ConvertTo-Json -Compress
