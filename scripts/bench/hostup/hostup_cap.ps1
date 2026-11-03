<#
.SYNOPSIS
    The bench's hand-made cap on the host's other uploads during a stream:
    two QoS policies in the ActiveStore, set and removed by hand.

.DESCRIPTION
    Plan « le stream passe avant un gros envoi du PC hôte » (24/10/2026), trial
    S0. A SYSTEM CHANGE: run only with Bruno's go for this trial, from a
    PowerShell he elevated himself, and end every trial with -Off then -Show.

    Two policies, in the ActiveStore only (gone at the next reboot, never
    written to the registry):
      "MW bench host cap"   all TCP and UDP of the machine, throttled to -Mbps;
      "MW bench stream"     the MoonlightWeb executable -Exe, its DSCP (-Dscp,
                            34 like PacketMarking's default), not throttled.
    Windows applies one policy per outbound flow, the most specific one, and a
    policy naming an application's path beats one with no application
    (Microsoft, "Manage QoS Policy", precedence rules). So the stream keeps its
    rate and everything else on the machine shares the cap. Whether the cap is
    shared or per connection is what the trial checks: the host's upload on the
    adapter must fall to about -Mbps with several connections running.

    -Catch Default makes the cap the "Default" policy (traffic no other policy
    matches) instead of an all-TCP-and-UDP one: the fallback if the first form
    turns out to throttle the stream too.

.EXAMPLE
    # in an elevated PowerShell, with Bruno's go
    .\hostup_cap.ps1 -On -Mbps 20 -Exe E:\Code\moonlight-web\build\MoonlightWeb.exe
    .\hostup_cap.ps1 -Show
    .\hostup_cap.ps1 -Off
    .\hostup_cap.ps1 -Show     # must list nothing of ours
    # what it would run, without elevation and without changing anything
    .\hostup_cap.ps1 -On -Mbps 20 -DryRun
#>
param(
    [switch]$On,
    [switch]$Off,
    [switch]$Show,
    [int]$Mbps = 20,
    [string]$Exe = 'E:\Code\moonlight-web\build\MoonlightWeb.exe',
    [ValidateRange(0, 63)][int]$Dscp = 34,
    [ValidateSet('Both', 'Default')][string]$Catch = 'Both',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$capName = 'MW bench host cap'
$streamName = 'MW bench stream'

if ((@($On, $Off, $Show) | Where-Object { $_ }).Count -ne 1) { throw 'one of -On, -Off, -Show' }
if ($Mbps -lt 1 -or $Mbps -gt 10000) { throw "-Mbps $Mbps is out of 1-10000" }

function Run([string]$What, [scriptblock]$Do) {
    if ($DryRun) { "would run: $What"; return }
    & $Do
}

if (-not $DryRun) {
    $me = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Error 'not elevated: run it from a PowerShell started as administrator (and only with the go for this trial)'
        exit 2
    }
}

if ($Show) {
    Run 'Get-NetQosPolicy -PolicyStore ActiveStore' {
        $all = @(Get-NetQosPolicy -PolicyStore ActiveStore)
        "ActiveStore: $($all.Count) policies"
        $all | Select-Object Name, Owner, AppPathName, IPProtocol, DSCPAction, ThrottleRateActionBitsPerSecond |
            Format-Table -AutoSize | Out-String -Width 200
        $ours = @($all | Where-Object { $_.Name -in $capName, $streamName })
        if ($ours.Count -eq 0) { "none of ours ($capName, $streamName)" } else { "ours: $($ours.Count)" }
    }
    return
}

if ($Off) {
    foreach ($n in $capName, $streamName) {
        Run "Remove-NetQosPolicy -Name '$n' -PolicyStore ActiveStore -Confirm:`$false" {
            $p = Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object Name -eq $n
            if ($p) {
                Remove-NetQosPolicy -Name $n -PolicyStore ActiveStore -Confirm:$false
                "removed $n"
            } else { "$n was not there" }
        }
    }
    return
}

# -On
if (-not $DryRun -and -not (Test-Path -LiteralPath $Exe)) { throw "no such executable: $Exe" }
$bits = [uint64]$Mbps * 1000000
foreach ($n in $capName, $streamName) {
    Run "Remove-NetQosPolicy -Name '$n' (a leftover)" {
        if (Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object Name -eq $n) {
            Remove-NetQosPolicy -Name $n -PolicyStore ActiveStore -Confirm:$false
            "removed a leftover $n"
        }
    }
}
Run "New-NetQosPolicy -Name '$streamName' -PolicyStore ActiveStore -AppPathNameMatchCondition '$Exe' -IPProtocolMatchCondition Both -DSCPAction $Dscp" {
    New-NetQosPolicy -Name $streamName -PolicyStore ActiveStore -AppPathNameMatchCondition $Exe `
        -IPProtocolMatchCondition Both -DSCPAction $Dscp | Out-Null
    "set $streamName ($Exe, DSCP $Dscp, no cap)"
}
if ($Catch -eq 'Default') {
    Run "New-NetQosPolicy -Name '$capName' -PolicyStore ActiveStore -Default -ThrottleRateActionBitsPerSecond $bits" {
        New-NetQosPolicy -Name $capName -PolicyStore ActiveStore -Default -ThrottleRateActionBitsPerSecond $bits | Out-Null
        "set $capName (Default, $Mbps Mbit/s)"
    }
} else {
    Run "New-NetQosPolicy -Name '$capName' -PolicyStore ActiveStore -IPProtocolMatchCondition Both -ThrottleRateActionBitsPerSecond $bits" {
        New-NetQosPolicy -Name $capName -PolicyStore ActiveStore -IPProtocolMatchCondition Both `
            -ThrottleRateActionBitsPerSecond $bits | Out-Null
        "set $capName (all TCP and UDP, $Mbps Mbit/s)"
    }
}
