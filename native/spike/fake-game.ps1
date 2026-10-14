<#
.SYNOPSIS
  Proxy for a borderless fullscreen game: a black, borderless, maximized, TOPMOST, focused window
  covering the primary monitor. Re-activates itself every 500 ms (games grab focus/z-order).
  Runs for -Seconds, then closes. Not a substitute for a real game test.
#>
param([int]$Seconds = 8, [switch]$Hostile)
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.WindowState = 'Maximized'
$f.BackColor = [System.Drawing.Color]::Black
$f.TopMost = [bool]$Hostile
$f.ShowInTaskbar = $false
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 500
$script:ticks = 0
$t.Add_Tick({
  $script:ticks++
  if ($Hostile) { $f.TopMost = $true }
  $f.Activate()
  if ($script:ticks * 500 -ge $Seconds * 1000) { $f.Close() }
})
$f.Add_Shown({ $f.Activate(); $t.Start() })
[void]$f.ShowDialog()
