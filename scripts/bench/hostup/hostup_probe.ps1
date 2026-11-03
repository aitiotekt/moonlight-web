<#
.SYNOPSIS
    Where does the queue sit when the host itself uploads a lot? Timestamped
    pings to several targets at once, plus the host's NIC byte counters, into
    one folder that hostup_report.py reads.

.DESCRIPTION
    Plan « le stream passe avant un gros envoi du PC hôte » (24/10/2026), phase M.
    The 24/10 evening's freezes came with TeraBox uploading 40-125 Mbit/s from
    DualRTX: a ping to the box, without any stream, rose to 240-746 ms. Pinging
    several targets along the path at the same time tells where the queue is:
    the repeater's own wired address (no Wi-Fi crossed), a machine on the same
    switch (the host's own NIC and vSwitch), the box (across the repeaters'
    Wi-Fi link), a Wi-Fi client of the repeater.

    No new executable and nothing that listens: System.Net.NetworkInformation
    (ICMP echo, the adapter's counters), no elevation. One runspace per target,
    each at its own steady pace, so a lost ping to one target never delays the
    others.

    Files in -OutDir:
      ping-<name>.csv  time,target,ip,status,rtt_ms   (one line per ping)
      nic.csv          time,adapter,sent_bytes,received_bytes   (once a second)
      marks.csv        time,phase   (written by -Mark; each mark opens a phase)
      meta.txt         what was asked

    Stop early by creating <OutDir>\stop.

.EXAMPLE
    # the measurement, in the background, ten minutes at most
    .\hostup_probe.ps1 -OutDir C:\...\m1 -Seconds 600 `
        -Target box=192.168.1.254,repeater=192.168.1.x,um=192.168.1.y,m3=192.168.1.21
    # each time Bruno pauses or resumes the upload
    .\hostup_probe.ps1 -OutDir C:\...\m1 -Mark b-upload-on
#>
param(
    [Parameter(Mandatory = $true)][string]$OutDir,
    # name=address, several. The first one's route picks the adapter.
    [string[]]$Target = @('box=192.168.1.254'),
    [int]$Seconds = 600,
    [int]$IntervalMs = 200,
    [int]$TimeoutMs = 1000,
    # The adapter whose counters are read; by default the one the route to the
    # first target leaves by (vEthernet (LAN) on DualRTX).
    [string]$Adapter = '',
    # Append a phase mark to marks.csv and exit.
    [string]$Mark = ''
)

$ErrorActionPreference = 'Stop'

function Stamp { (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') }

if ($Mark) {
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    $marks = Join-Path $OutDir 'marks.csv'
    if (-not (Test-Path $marks)) { 'time,phase' | Out-File -Encoding ascii $marks }
    "$(Stamp),$Mark" | Out-File -Append -Encoding ascii $marks
    "marked $Mark"
    return
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stopFile = Join-Path $OutDir 'stop'
if (Test-Path $stopFile) { Remove-Item $stopFile }

$targets = @()
foreach ($t in $Target) {
    foreach ($one in ($t -split ',')) {
        $kv = $one -split '=', 2
        if ($kv.Count -ne 2 -or -not $kv[0] -or -not $kv[1]) { throw "target '$one' is not name=address" }
        if ($kv[0] -notmatch '^[A-Za-z0-9_-]+$') { throw "target name '$($kv[0])' must be [A-Za-z0-9_-]" }
        $targets += [pscustomobject]@{ Name = $kv[0]; Ip = $kv[1] }
    }
}
if ($targets.Count -eq 0) { throw 'no target' }

if (-not $Adapter) {
    try {
        $route = Find-NetRoute -RemoteIPAddress $targets[0].Ip -ErrorAction Stop | Select-Object -First 1
        $Adapter = $route.InterfaceAlias
    } catch {
        throw "no route to $($targets[0].Ip) to pick the adapter from; pass -Adapter"
    }
}
$nic = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
    Where-Object { $_.Name -eq $Adapter } | Select-Object -First 1
if (-not $nic) { throw "adapter '$Adapter' not found" }

$endTicks = (Get-Date).ToUniversalTime().AddSeconds($Seconds).Ticks
@(
    "start $(Stamp)"
    "seconds $Seconds, interval $IntervalMs ms, timeout $TimeoutMs ms"
    "adapter $Adapter"
    ($targets | ForEach-Object { "target $($_.Name) $($_.Ip)" })
) | Out-File -Encoding ascii (Join-Path $OutDir 'meta.txt')

$pingLoop = {
    param($Name, $Ip, $File, $EndTicks, $IntervalMs, $TimeoutMs, $StopFile)
    $p = New-Object System.Net.NetworkInformation.Ping
    $w = New-Object System.IO.StreamWriter($File, $false, [System.Text.Encoding]::ASCII)
    $w.AutoFlush = $true
    $w.WriteLine('time,target,ip,status,rtt_ms')
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $next = 0
    while ([DateTime]::UtcNow.Ticks -lt $EndTicks -and -not (Test-Path $StopFile)) {
        $at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
        try {
            $r = $p.Send($Ip, $TimeoutMs)
            $status = [string]$r.Status
            $rtt = if ($r.Status -eq 'Success') { [string]$r.RoundtripTime } else { '' }
        } catch {
            $status = 'Error'
            $rtt = ''
        }
        $w.WriteLine("$at,$Name,$Ip,$status,$rtt")
        # A steady pace: a slow reply eats into the next wait, never adds to it.
        $next += $IntervalMs
        $wait = $next - $sw.ElapsedMilliseconds
        if ($wait -gt 0) { Start-Sleep -Milliseconds $wait } else { $next = $sw.ElapsedMilliseconds }
    }
    $w.Close()
}

$nicLoop = {
    param($Adapter, $File, $EndTicks, $StopFile)
    $w = New-Object System.IO.StreamWriter($File, $false, [System.Text.Encoding]::ASCII)
    $w.AutoFlush = $true
    $w.WriteLine('time,adapter,sent_bytes,received_bytes')
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $next = 0
    while ([DateTime]::UtcNow.Ticks -lt $EndTicks -and -not (Test-Path $StopFile)) {
        $n = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
            Where-Object { $_.Name -eq $Adapter } | Select-Object -First 1
        $at = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
        if ($n) {
            $s = $n.GetIPStatistics()
            $w.WriteLine("$at,$Adapter,$($s.BytesSent),$($s.BytesReceived)")
        }
        $next += 1000
        $wait = $next - $sw.ElapsedMilliseconds
        if ($wait -gt 0) { Start-Sleep -Milliseconds $wait } else { $next = $sw.ElapsedMilliseconds }
    }
    $w.Close()
}

$pool = [RunspaceFactory]::CreateRunspacePool(1, $targets.Count + 1)
$pool.Open()
$jobs = @()
function Start-Loop($Script, $Arguments, $Name) {
    $ps = [PowerShell]::Create()
    $ps.RunspacePool = $pool
    [void]$ps.AddScript($Script)
    foreach ($a in $Arguments) { [void]$ps.AddArgument($a) }
    [pscustomobject]@{ Ps = $ps; Handle = $ps.BeginInvoke(); Name = $Name }
}
foreach ($t in $targets) {
    $file = Join-Path $OutDir "ping-$($t.Name).csv"
    $jobs += Start-Loop $pingLoop @($t.Name, $t.Ip, $file, $endTicks, $IntervalMs, $TimeoutMs, $stopFile) $t.Name
}
$jobs += Start-Loop $nicLoop @($Adapter, (Join-Path $OutDir 'nic.csv'), $endTicks, $stopFile) 'nic'

"probing $($targets.Count) target(s) on '$Adapter' into $OutDir until $((Get-Date).AddSeconds($Seconds).ToString('HH:mm:ss')) (or $stopFile)"
foreach ($j in $jobs) {
    try {
        $j.Ps.EndInvoke($j.Handle) | Out-Null
    } catch {
        "loop $($j.Name) failed: $($_.Exception.Message)"
    }
    foreach ($e in $j.Ps.Streams.Error) { "loop $($j.Name): $e" }
    $j.Ps.Dispose()
}
$pool.Close()
"done $(Stamp)"
