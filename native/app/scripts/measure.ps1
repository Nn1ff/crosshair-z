<#
.SYNOPSIS
  Private working set + CPU of a process and ALL its descendants (WebView2 spawns grandchildren).
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$CpuSeconds = 10
)
$ErrorActionPreference = 'Stop'

$roots = @(Get-Process -Name $Name -ErrorAction SilentlyContinue)
if ($roots.Count -eq 0) { throw "no process named '$Name'" }

$all = @(Get-CimInstance Win32_Process)

function Get-Descendants([int]$procId) {
  $procId
  foreach ($child in ($all | Where-Object { $_.ParentProcessId -eq $procId })) {
    Get-Descendants ([int]$child.ProcessId)
  }
}

# Root = topmost process with this name (portable launchers start a second copy of themselves).
$rootIds = $roots | ForEach-Object { $_.Id }
$top = $roots | Where-Object {
  $parent = ($all | Where-Object ProcessId -eq $_.Id).ParentProcessId
  $rootIds -notcontains $parent
} | Select-Object -First 1
$ids = @(Get-Descendants $top.Id | Sort-Object -Unique)

function Get-Perf { @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains [int]$_.IDProcess }) }

$perf = Get-Perf
$totalMb = (($perf | Measure-Object WorkingSetPrivate -Sum).Sum) / 1MB
'{0} processes, private working set {1:N1} MB' -f $ids.Count, $totalMb
$perf | Sort-Object WorkingSetPrivate -Descending | ForEach-Object {
  '  {0,-28} pid {1,-7} {2,8:N1} MB' -f $_.Name, $_.IDProcess, ($_.WorkingSetPrivate / 1MB)
}

# Measure-Object cannot read nested properties (TotalProcessorTime.TotalMilliseconds) -> sum by loop
$cpu0 = 0
foreach ($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $cpu0 += $p.TotalProcessorTime.TotalMilliseconds }
$t0 = Get-Date
Start-Sleep -Seconds $CpuSeconds
$cpu1 = 0
foreach ($p in (Get-Process -Id $ids -ErrorAction SilentlyContinue)) { $cpu1 += $p.TotalProcessorTime.TotalMilliseconds }
$wallMs = ((Get-Date) - $t0).TotalMilliseconds
$cores = [Environment]::ProcessorCount
'CPU over {0}s: {1:N2} % of total machine' -f $CpuSeconds, (100 * ($cpu1 - $cpu0) / ($wallMs * $cores))
