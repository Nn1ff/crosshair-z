<#
.SYNOPSIS
  Verifies the spike overlay: finds its window, prints extended styles, and counts pure-red
  pixels in a screen capture of the primary monitor center (what the user would see).
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CzWin {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[void][CzWin]::SetProcessDPIAware()

$GWL_EXSTYLE = -20
$want = @{ LAYERED = 0x80000; TRANSPARENT = 0x20; TOPMOST = 0x8; NOACTIVATE = 0x8000000; TOOLWINDOW = 0x80 }

$h = [CzWin]::FindWindowW('CzSpikeOverlay', $null)
if ($h -eq [IntPtr]::Zero) { throw 'overlay window not found' }
$ex = [CzWin]::GetWindowLongPtrW($h, $GWL_EXSTYLE).ToInt64()
'visible: {0}' -f [CzWin]::IsWindowVisible($h)
foreach ($k in $want.Keys) { '  WS_EX_{0,-12} {1}' -f $k, (($ex -band $want[$k]) -ne 0) }

$sw = [CzWin]::GetSystemMetrics(0); $sh = [CzWin]::GetSystemMetrics(1)
$size = 64
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen([int](($sw - $size) / 2), [int](($sh - $size) / 2), 0, 0, $bmp.Size)
  $red = 0
  for ($y = 0; $y -lt $size; $y++) { for ($x = 0; $x -lt $size; $x++) {
    $c = $bmp.GetPixel($x, $y); if ($c.R -eq 255 -and $c.G -eq 0 -and $c.B -eq 0) { $red++ } } }
  # plus sign: 4 arms * 12 px * 2 px thickness = 96 pixels
  'screen {0}x{1}, red pixels in center 64x64: {2} (expected 96)' -f $sw, $sh, $red
} finally { $g.Dispose(); $bmp.Dispose() }
