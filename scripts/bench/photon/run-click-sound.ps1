# Run mw-click-sound.exe in the console session of a Windows client reached
# over ssh (an ssh session lands in session 0: no desktop pixel to read, no
# click to send, and not the user's audio session). A one-shot Interactive
# scheduled task, waited for, then its output printed and the task removed.
# Same pattern as run-in-console.ps1.
#   powershell -File run-click-sound.ps1 -Tag a1-n95 -Arguments "--tick 120 --window MoonlightWeb"
#   powershell -File run-click-sound.ps1 -Tag a1-n95c -Arguments "--clicks 30 --window MoonlightWeb"
# -Wait: how long to wait for it, in seconds (default: 60 more than a --tick).
param(
    [Parameter(Mandatory)] [string] $Tag,
    [string] $Arguments = '--tick 60',
    [int] $Wait = 0,
    [string] $Dir = ''
)
# $PSScriptRoot is empty in a param default under Windows PowerShell 5.1.
if (-not $Dir) { $Dir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$exe = Join-Path $Dir 'mw-click-sound.exe'
$out = Join-Path $Dir "$Tag.json"
$log = Join-Path $Dir "$Tag.txt"
$task = 'MwClickSound'
if ($Wait -le 0) {
    $tick = 0
    if ($Arguments -match '--tick\s+([\d.]+)') { $tick = [double]$Matches[1] }
    $Wait = [int]($tick + 60)
    if ($Arguments -match '--clicks\s+(\d+)') { $Wait = [int]$Matches[1] * 3 + 60 }
}
$cmd = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"& '$exe' $Arguments --out '$out' *> '$log'`""
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $cmd
$user = (Get-CimInstance Win32_ComputerSystem).UserName
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive
Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null
Remove-Item $log, $out -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $task
$deadline = (Get-Date).AddSeconds($Wait)
do { Start-Sleep -Seconds 2 } while ((Get-ScheduledTask -TaskName $task).State -eq 'Running' -and (Get-Date) -lt $deadline)
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path $log) { Get-Content $log } else { "no output ($log)" }
if (Test-Path $out) { Get-Content $out }
