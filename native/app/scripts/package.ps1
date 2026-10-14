<#
.SYNOPSIS
  Builds the native release and stages it as release-native\Crosshair-Z.exe (the asset name the
  1.x and 2.x updaters look for). Runs the Rust tests, the JS tests and the smoke test first.
#>
param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$env:Path = "$env:USERPROFILE\.cargo\bin;$env:Path"
$app = Resolve-Path (Join-Path $PSScriptRoot '..')
$repo = Resolve-Path (Join-Path $app '..\..')
$out = Join-Path $repo 'release-native'

Push-Location $app
try {
  if (-not $SkipTests) {
    cargo test --quiet
    if ($LASTEXITCODE -ne 0) { throw 'cargo test failed' }
    Push-Location $repo; try { npm test --silent; if ($LASTEXITCODE -ne 0) { throw 'npm test failed' } } finally { Pop-Location }
  }
  cargo build --release
  if ($LASTEXITCODE -ne 0) { throw 'cargo build failed' }
  if (-not $SkipTests) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'smoke.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'smoke test failed' }
  }
} finally { Pop-Location }

New-Item -ItemType Directory -Force $out | Out-Null
$exe = Join-Path $out 'Crosshair-Z.exe'
Copy-Item (Join-Path $app 'target\release\crosshair-z.exe') $exe -Force
$item = Get-Item $exe
'{0}  {1:N2} MB  {2}' -f $item.FullName, ($item.Length / 1MB), $item.VersionInfo.ProductVersion
