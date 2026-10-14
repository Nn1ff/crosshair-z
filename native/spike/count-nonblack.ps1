<# Counts non-black pixels in the primary monitor's center 200x200 (fake game is pure black). #>
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace CzDpi -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);'
[void][CzDpi.U]::SetProcessDPIAware()
$sw = [CzDpi.U]::GetSystemMetrics(0); $sh = [CzDpi.U]::GetSystemMetrics(1); $n = 200
$bmp = New-Object System.Drawing.Bitmap $n, $n
$g = [System.Drawing.Graphics]::FromImage($bmp)
try {
  $g.CopyFromScreen([int](($sw - $n) / 2), [int](($sh - $n) / 2), 0, 0, $bmp.Size)
  $c = 0
  for ($y = 0; $y -lt $n; $y++) { for ($x = 0; $x -lt $n; $x++) { $p = $bmp.GetPixel($x, $y); if ($p.R + $p.G + $p.B -gt 30) { $c++ } } }
  "non-black pixels in center ${n}x${n}: $c"
} finally { $g.Dispose(); $bmp.Dispose() }
