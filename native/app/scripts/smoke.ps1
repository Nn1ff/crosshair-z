<#
.SYNOPSIS
  End-to-end smoke test of the native app with an isolated data dir (CZ_USERDATA):
  first start renders sprites in a hidden WebView2 and draws the crosshair, the webview goes away,
  RAM stays in budget, a second instance exits, a restart draws from the disk cache without a webview.
.PARAMETER Exe  path to crosshair-z.exe (default: release build)
#>
param(
  [string]$Exe = (Join-Path $PSScriptRoot '..\target\release\crosshair-z.exe'),
  [int]$RamBudgetMb = 15
)
$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path $Exe).Path
$name = [IO.Path]::GetFileNameWithoutExtension($Exe)
$data = Join-Path $env:TEMP "cz-smoke-$PID"
Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $data | Out-Null

# Known config: first shipped preset, unusual toggle key so a running 1.x instance does not interfere.
$preset = Get-Content (Join-Path $PSScriptRoot '..\resources\first-preset.json') -Raw | ConvertFrom-Json
$cfg = @{
  version = 5; enabled = $true; activeProfileId = 'smoke'
  profiles = @(@{ id = 'smoke'; name = $preset.name; hotkey = ''; crosshair = $preset.crosshair })
  display = @{ monitorId = $null; offsetX = 0; offsetY = 0; scale = 2 }
  hotkeys = @{ toggle = 'Ctrl+Alt+Shift+F20' }
}
$cfg | ConvertTo-Json -Depth 32 | Set-Content -Encoding utf8 (Join-Path $data 'config.json')

Add-Type -AssemblyName System.Drawing
Add-Type -Namespace CzSmoke -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);'
[void][CzSmoke.U]::SetProcessDPIAware()
function Capture-Center {
  $n = 160; $sw = [CzSmoke.U]::GetSystemMetrics(0); $sh = [CzSmoke.U]::GetSystemMetrics(1)
  $bmp = New-Object System.Drawing.Bitmap $n, $n
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try { $g.CopyFromScreen([int](($sw - $n) / 2), [int](($sh - $n) / 2), 0, 0, $bmp.Size)
    $px = New-Object 'int[]' ($n * $n)
    for ($y = 0; $y -lt $n; $y++) { for ($x = 0; $x -lt $n; $x++) { $px[$y * $n + $x] = $bmp.GetPixel($x, $y).ToArgb() } }
    return ,$px
  } finally { $g.Dispose(); $bmp.Dispose() }
}
# Pixels close to the preset line color: robust even over a moving game/video background.
$hex = $preset.crosshair.layers[0].lines.color
$want = @([Convert]::ToInt32($hex.Substring(1, 2), 16), [Convert]::ToInt32($hex.Substring(3, 2), 16), [Convert]::ToInt32($hex.Substring(5, 2), 16))
function Count-Crosshair($px) { $c = 0; foreach ($argb in $px) { $r = ($argb -shr 16) -band 255; $g = ($argb -shr 8) -band 255; $b = $argb -band 255
    if ([Math]::Abs($r - $want[0]) + [Math]::Abs($g - $want[1]) + [Math]::Abs($b - $want[2]) -le 24) { $c++ } }; $c }
function Get-Tree([int]$rootId) {
  $all = @(Get-CimInstance Win32_Process)
  $ids = @($rootId); $i = 0
  while ($i -lt $ids.Count) { $ids += @($all | Where-Object { $_.ParentProcessId -eq $ids[$i] } | ForEach-Object { [int]$_.ProcessId }); $i++ }
  $ids
}
function Start-App { $env:CZ_USERDATA = $data; try { Start-Process $Exe -PassThru } finally { Remove-Item Env:CZ_USERDATA } }
$failures = @()
function Check($ok, $what) { if ($ok) { "PASS  $what" } else { "FAIL  $what"; $script:failures += $what } }

$before = Count-Crosshair (Capture-Center)
$p = Start-App
$sprites = Join-Path $data 'sprites'
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline -and -not (Get-ChildItem $sprites -Filter *.bin -ErrorAction SilentlyContinue)) { Start-Sleep -Milliseconds 200 }
Check ([bool](Get-ChildItem $sprites -Filter *.bin -ErrorAction SilentlyContinue)) 'first start renders and caches sprites'
Start-Sleep -Milliseconds 800
$seen = (Count-Crosshair (Capture-Center)) - $before
Check ($seen -gt 20) "crosshair drawn at screen center ($seen px in line color)"

Start-Sleep -Seconds 12
$tree = Get-Tree $p.Id
$web = @(Get-CimInstance Win32_Process | Where-Object { $tree -contains [int]$_.ProcessId -and $_.Name -like 'msedgewebview2*' })
Check ($web.Count -eq 0) "renderer webview gone after idle ($($web.Count) left)"
$ws = (Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $tree -contains [int]$_.IDProcess } | Measure-Object WorkingSetPrivate -Sum).Sum / 1MB
Check ($ws -le $RamBudgetMb) ("private working set {0:N1} MB <= {1} MB" -f $ws, $RamBudgetMb)

$second = Start-App
$exited = $second.WaitForExit(5000)
Check $exited 'second instance exits'
if (-not $exited) { Stop-Process -Id $second.Id -Force }

Stop-Process -Id $p.Id -Force
Start-Sleep -Milliseconds 800
$before2 = Count-Crosshair (Capture-Center)
$p2 = Start-App
Start-Sleep -Milliseconds 1500
$seen2 = (Count-Crosshair (Capture-Center)) - $before2
Check ($seen2 -gt 20) "restart draws from disk cache ($seen2 px in line color)"
$tree2 = Get-Tree $p2.Id
$web2 = @(Get-CimInstance Win32_Process | Where-Object { $tree2 -contains [int]$_.ProcessId -and $_.Name -like 'msedgewebview2*' })
Check ($web2.Count -eq 0) 'restart needs no webview'
Stop-Process -Id $p2.Id -Force

$log = Join-Path $data 'logs\crosshair-z.log'
$errors = @(Select-String -Path $log -Pattern ' ERROR ' -ErrorAction SilentlyContinue)
Check ($errors.Count -eq 0) "no ERROR lines in log ($($errors.Count))"
if ($errors.Count) { $errors | Select-Object -First 5 | ForEach-Object { "      $($_.Line)" } }

if ($failures.Count) { "SMOKE FAILED: $($failures.Count) check(s)"; exit 1 } else { 'SMOKE OK'; Remove-Item -Recurse -Force $data -ErrorAction SilentlyContinue }
