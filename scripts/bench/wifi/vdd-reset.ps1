# The virtual display left primary by a pass killed mid-way: a short --dev start
# resets it (the host turns it off at start-up), then that instance is stopped.
# The screens are listed at the end (monitors.ps1).
#
# The product's display is told by its device node being switched on, not by
# its number: Windows numbered it DISPLAY34 and DISPLAY38 on 13/10/2026, where
# a DISPLAY1xx was assumed, and the reset left it on.
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..\..')
$out = Join-Path $repo 'bench-out\wifi'
New-Item -ItemType Directory -Force $out | Out-Null
$mon = Join-Path $repo 'scripts\bench\monitors.ps1'
$virtual = {
    $null -ne (Get-PnpDevice -FriendlyName 'MoonlightWeb Virtual Display' -ErrorAction SilentlyContinue |
        Where-Object Status -eq 'OK')
}
if (& $virtual) {
    Start-Process -FilePath (Join-Path $repo 'build\MoonlightWeb.exe') -ArgumentList '--dev', '--autostart', '--log', (Join-Path $out 'dev-reset.log') | Out-Null
    $end = (Get-Date).AddSeconds(90)
    do { Start-Sleep -Seconds 3 } while ((& $virtual) -and (Get-Date) -lt $end)
    Get-CimInstance Win32_Process -Filter "Name='MoonlightWeb.exe'" | Where-Object { $_.CommandLine -like '*--dev*dev-reset.log*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
powershell -NoProfile -File $mon
