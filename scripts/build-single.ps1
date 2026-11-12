param([string]$OutputPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-common.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
$distRoot = Join-Path $projectRoot 'dist'
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
$payloadRoot = Join-Path $projectRoot (".build\portable-payload-$version")
$payloadArchive = Join-Path $projectRoot (".build\portable-payload-$version.zip")
$singleOutput = if ($OutputPath) { [System.IO.Path]::GetFullPath($OutputPath) } else { Join-Path $distRoot ("Letterpane Portable $version.exe") }
$originalExecutable = Join-Path $projectRoot 'dist\Posta\Posta.exe'
$originalArchive = Join-Path $projectRoot 'dist\Posta-portable-win-x64.zip'
$originalHashes = @{}
New-Item -ItemType Directory -Path $distRoot -Force | Out-Null
foreach ($original in @($originalExecutable,$originalArchive) + @(Get-ChildItem -LiteralPath $distRoot -File | Where-Object { $_.Extension -in @('.exe','.zip') -and $_.FullName -ne $singleOutput } | ForEach-Object { $_.FullName })) {
    if (Test-Path -LiteralPath $original) { $originalHashes[$original] = Get-ReleaseHash $original }
}
& (Join-Path $PSScriptRoot 'build.ps1') -Zip -OutputDirectory $payloadRoot -ZipOutput $payloadArchive
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($payloadArchive)
try {
    if (@($archive.Entries | Where-Object { $_.FullName -match '(^|/)\.data/' }).Count) { throw 'A user profile must never be embedded.' }
    foreach ($required in @('Letterpane.exe','runtime/node.exe','src/server.mjs','src/settings.mjs','public/index.html','public/themes.css','public/customize.js','public/view-model.js','public/i18n.js','shared/i18n.mjs','shared/messages.mjs','shared/locales/ru.mjs','shared/locales/en.mjs','shared/locales/uk.mjs','PORTABLE.md')) { if (-not $archive.GetEntry($required)) { throw "Missing embedded file: $required" } }
} finally { $archive.Dispose() }
$payloadHash = Get-ReleaseHash $payloadArchive
$generatedSource = Join-Path $projectRoot '.build\PortablePayload.cs'
[System.IO.File]::WriteAllText($generatedSource,('internal static class PortablePayload { internal const string Sha256 = "' + $payloadHash + '"; }'))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$compilerArgs = @('/nologo','/target:winexe','/platform:x64','/optimize+',('/out:' + $singleOutput),('/win32icon:' + (Join-Path $projectRoot '.build\Letterpane.ico')),('/win32manifest:' + (Join-Path $projectRoot 'native\Letterpane.manifest')),('/resource:' + $payloadArchive + ',Letterpane.Payload.zip'))
foreach ($reference in @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.IO.Compression.dll')) { $compilerArgs += '/reference:' + $reference }
$compilerArgs += Join-Path $projectRoot 'native\Portable.cs'
$compilerArgs += Join-Path $projectRoot 'native\NativeText.cs'
$compilerArgs += Join-Path $projectRoot 'native\NativeTheme.cs'
$compilerArgs += Join-Path $projectRoot '.build\NativeThemeCatalog.cs'
$compilerArgs += Join-Path $projectRoot '.build\NativeCatalog.cs'
$compilerArgs += Join-Path $projectRoot '.build\AssemblyInfo.cs'
$compilerArgs += $generatedSource
& $compiler @compilerArgs
if ($LASTEXITCODE -ne 0) { throw 'Single-file launcher compilation failed.' }
foreach ($original in $originalHashes.Keys) {
    if ((Get-ReleaseHash $original) -ne $originalHashes[$original]) { throw "Existing release was unexpectedly modified: $original" }
}
Write-Output $singleOutput
Write-Output ('MiB: ' + [math]::Round((Get-Item -LiteralPath $singleOutput).Length/1MB,1))
Write-Output 'Existing folder release and archive were preserved.'
