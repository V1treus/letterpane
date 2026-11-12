param([switch]$Demo)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$executable = Join-Path $projectRoot ("dist\Letterpane $version\Letterpane.exe")
if (-not (Test-Path -LiteralPath $executable)) { & (Join-Path $PSScriptRoot 'build.ps1') }
if ($Demo) { Start-Process -FilePath $executable -ArgumentList '--demo' }
else { Start-Process -FilePath $executable }
