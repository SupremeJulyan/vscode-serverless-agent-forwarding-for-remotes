# Windows-side TCP relay implemented with PowerShell and the built-in .NET runtime.
param(
    [Parameter(Mandatory = $true)]
    [string]$TargetHost,

    [int]$TargetPort = 22,

    [double]$IdleExitSeconds = 0,

    [int]$ListenPort = 0,

    [switch]$RunRelay
)

$ErrorActionPreference = "Stop"

$relaySource = @'
using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;

public static class ServerlessRemoteTcpRelay
{
    private static async Task CopyAsync(NetworkStream source, NetworkStream destination)
    {
        byte[] buffer = new byte[65536];
        try
        {
            while (true)
            {
                int count = await source.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (count == 0) break;
                await destination.WriteAsync(buffer, 0, count).ConfigureAwait(false);
                await destination.FlushAsync().ConfigureAwait(false);
            }
        }
        catch (Exception) { }
    }

    private static async Task RelayAsync(
        TcpClient client, string targetHost, int targetPort, Action completed)
    {
        using (client)
        using (TcpClient remote = new TcpClient())
        {
            try
            {
                await remote.ConnectAsync(targetHost, targetPort).ConfigureAwait(false);
                NetworkStream clientStream = client.GetStream();
                NetworkStream remoteStream = remote.GetStream();
                Task first = CopyAsync(clientStream, remoteStream);
                Task second = CopyAsync(remoteStream, clientStream);
                await Task.WhenAny(first, second).ConfigureAwait(false);
            }
            catch (Exception) { }
            finally { completed(); }
        }
    }

    public static void Run(string targetHost, int targetPort, int listenPort, double idleSeconds)
    {
        TcpListener listener = new TcpListener(IPAddress.Loopback, listenPort);
        ConcurrentDictionary<int, Task> connections = new ConcurrentDictionary<int, Task>();
        int nextId = 0;
        int active = 0;
        bool hadConnection = false;
        DateTime idleSince = DateTime.UtcNow;
        listener.Start();
        try
        {
            while (true)
            {
                if (listener.Pending())
                {
                    TcpClient client = listener.AcceptTcpClient();
                    int id = Interlocked.Increment(ref nextId);
                    Interlocked.Increment(ref active);
                    hadConnection = true;
                    Task task = RelayAsync(client, targetHost, targetPort, delegate {
                        if (Interlocked.Decrement(ref active) == 0) idleSince = DateTime.UtcNow;
                        Task ignored;
                        connections.TryRemove(id, out ignored);
                    });
                    connections[id] = task;
                    continue;
                }
                if (idleSeconds > 0 && hadConnection && active == 0
                    && (DateTime.UtcNow - idleSince).TotalSeconds >= idleSeconds) break;
                Thread.Sleep(100);
            }
        }
        finally
        {
            listener.Stop();
            Task.WaitAll(connections.Values.ToArray(), TimeSpan.FromSeconds(5));
        }
    }
}
'@

if ($RunRelay) {
    Add-Type -TypeDefinition $relaySource -Language CSharp
    [ServerlessRemoteTcpRelay]::Run(
        $TargetHost,
        $TargetPort,
        $ListenPort,
        $IdleExitSeconds
    )
    exit 0
}

$probe = [System.Net.Sockets.TcpListener]::new(
    [System.Net.IPAddress]::Loopback,
    0
)
$probe.Start()
$selectedPort = ([System.Net.IPEndPoint]$probe.LocalEndpoint).Port
$probe.Stop()

function Quote-ProcessArgument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

$relayArguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', $PSCommandPath,
    '-RunRelay',
    '-TargetHost', $TargetHost,
    '-TargetPort', $TargetPort,
    '-ListenPort', $selectedPort,
    '-IdleExitSeconds', $IdleExitSeconds
) | ForEach-Object { Quote-ProcessArgument ([string]$_) }

$process = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList ($relayArguments -join ' ') `
    -WindowStyle Hidden `
    -PassThru

$ready = $false
for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if ($process.HasExited) {
        throw "Relay exited during startup with code $($process.ExitCode)"
    }
    $listener = Get-NetTCPConnection `
        -State Listen `
        -LocalAddress 127.0.0.1 `
        -LocalPort $selectedPort `
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
    throw "Relay did not listen on 127.0.0.1:$selectedPort"
}

[pscustomobject]@{
    pid = $process.Id
    port = $selectedPort
} | ConvertTo-Json -Compress
