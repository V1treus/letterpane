param([switch]$Zip,[string]$OutputDirectory,[string]$ZipOutput)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-common.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildRoot = Join-Path $projectRoot '.build'
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Release version must be x.y.z.' }
$nodePath = (Get-Command node.exe).Source
$nodeVersion = (Get-Content -LiteralPath (Join-Path $projectRoot '.node-version') -Raw).Trim()
if ((& $nodePath --version).Trim() -ne "v$nodeVersion") { throw "Release builds require Node.js $nodeVersion from .node-version." }
if ((Get-ReleaseHash $nodePath) -ne 'BA4E6D110E8C1592A1ECD390F6B05F3DA124B13871A5BE62B341A07A853C6C32') { throw 'Node.js does not match the pinned official Windows x64 binary.' }
& node (Join-Path $PSScriptRoot 'generate-native-strings.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Native localization generation failed.' }
& node (Join-Path $PSScriptRoot 'generate-native-theme.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Native theme generation failed.' }
& node (Join-Path $PSScriptRoot 'prepare-release.mjs') native
if ($LASTEXITCODE -ne 0) { throw 'Native version generation failed.' }
$outputRoot = if ($OutputDirectory) { [System.IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $projectRoot ("dist\Letterpane $version") }
$webviewVersion = '1.0.4191.47'
$sdkRoot = Join-Path $buildRoot 'webview2'
$sdkArchive = Join-Path $buildRoot 'webview2.zip'
if (-not (Test-Path -LiteralPath $sdkArchive)) {
    Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$webviewVersion/microsoft.web.webview2.$webviewVersion.nupkg" -OutFile $sdkArchive
}
if ((Get-ReleaseHash $sdkArchive) -ne 'F492BBF547D0DA329553B6727435B677579B1E9F91CC9E4A1AD029366D5F23D0') { throw 'WebView2 SDK archive checksum mismatch. Remove the cached archive and download it again.' }
Expand-Archive -LiteralPath $sdkArchive -DestinationPath $sdkRoot -Force
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\imapflow'))) { throw 'Run npm ci --ignore-scripts first.' }
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $outputRoot 'runtime') -Force | Out-Null
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(64,64)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(52,95,206))
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White,3.5)
$graphics.DrawRectangle($pen,13,19,38,28)
$graphics.DrawLines($pen,[System.Drawing.Point[]]@((New-Object System.Drawing.Point(13,20)),(New-Object System.Drawing.Point(32,35)),(New-Object System.Drawing.Point(51,20))))
$icon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())
$iconPath = Join-Path $buildRoot 'Letterpane.ico'
$iconStream = [System.IO.File]::Create($iconPath)
$icon.Save($iconStream)
$iconStream.Dispose(); $icon.Dispose(); $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$references = @('System.dll','System.Core.dll','System.Drawing.dll','System.Windows.Forms.dll','System.Web.Extensions.dll',(Join-Path $sdkRoot 'lib\net462\Microsoft.Web.WebView2.Core.dll'),(Join-Path $sdkRoot 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'))
$compilerArgs = @('/nologo','/target:winexe','/platform:x64','/optimize+',('/out:' + (Join-Path $outputRoot 'Letterpane.exe')),('/win32icon:' + $iconPath),('/win32manifest:' + (Join-Path $projectRoot 'native\Letterpane.manifest')))
foreach ($reference in $references) { $compilerArgs += '/reference:' + $reference }
$compilerArgs += Join-Path $projectRoot 'native\Letterpane.cs'
$compilerArgs += Join-Path $projectRoot 'native\NativeText.cs'
$compilerArgs += Join-Path $projectRoot 'native\NativeTheme.cs'
$compilerArgs += Join-Path $buildRoot 'NativeThemeCatalog.cs'
$compilerArgs += Join-Path $buildRoot 'NativeCatalog.cs'
$compilerArgs += Join-Path $buildRoot 'AssemblyInfo.cs'
& $compiler @compilerArgs
if ($LASTEXITCODE -ne 0) { throw 'Native launcher compilation failed.' }
Copy-Item -LiteralPath (Join-Path $outputRoot 'Letterpane.exe') -Destination (Join-Path $outputRoot 'Letterpane Demo.exe') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\Letterpane.exe.config') -Destination (Join-Path $outputRoot 'Letterpane Demo.exe.config') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'native\Letterpane.exe.config') -Destination $outputRoot -Force
Copy-Item -LiteralPath $iconPath -Destination $outputRoot -Force
foreach ($file in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll')) { Copy-Item -LiteralPath (Join-Path $sdkRoot "lib\net462\$file") -Destination $outputRoot -Force }
Copy-Item -LiteralPath (Join-Path $sdkRoot 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $outputRoot -Force
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $outputRoot 'runtime\node.exe') -Force
foreach ($directory in @('src','public','shared','node_modules')) { Copy-Item -LiteralPath (Join-Path $projectRoot $directory) -Destination $outputRoot -Recurse -Force }
foreach ($file in @('package.json','package-lock.json','README.md','README.en.md','README.uk.md','PORTABLE.md','DESIGN.md','CHANGELOG.md','CONTRIBUTING.md','RELEASE_CHECKLIST.md','SUPPORT.md','SECURITY.md','THIRD-PARTY-NOTICES.md','Letterpane Demo.cmd')) { Copy-Item -LiteralPath (Join-Path $projectRoot $file) -Destination $outputRoot -Force }
if (Test-Path -LiteralPath (Join-Path $projectRoot 'docs')) { Copy-Item -LiteralPath (Join-Path $projectRoot 'docs') -Destination $outputRoot -Recurse -Force }
$nodeLicense = Join-Path (Split-Path $nodePath -Parent) 'LICENSE'
if (-not (Test-Path -LiteralPath $nodeLicense)) {
    $nodeLicense = Join-Path $buildRoot 'NODE-LICENSE.txt'
    if (-not (Test-Path -LiteralPath $nodeLicense)) {
        $nodeVersion = (& $nodePath --version).Trim()
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$nodeVersion/LICENSE" -OutFile $nodeLicense
    }
}
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $outputRoot 'runtime\NODE-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $sdkRoot 'LICENSE.txt') -Destination (Join-Path $outputRoot 'WEBVIEW2-LICENSE.txt') -Force
Copy-Item -LiteralPath (Join-Path $sdkRoot 'NOTICE.txt') -Destination (Join-Path $outputRoot 'WEBVIEW2-NOTICE.txt') -Force
& node (Join-Path $PSScriptRoot 'prepare-release.mjs') manifest $outputRoot
if ($LASTEXITCODE -ne 0) { throw 'Release manifest generation failed.' }
if ($Zip) {
    # Explicit allowlist prevents including a user's existing .data profile in an archive.
    $releaseManifest = Get-Content -LiteralPath (Join-Path $outputRoot 'release-manifest.json') -Raw | ConvertFrom-Json
    $archiveItems = @($releaseManifest.files | ForEach-Object { Join-Path $outputRoot $_.path }) + @(Join-Path $outputRoot 'release-manifest.json')
    Add-Type -AssemblyName System.IO.Compression
    $archivePath = if ($ZipOutput) { [System.IO.Path]::GetFullPath($ZipOutput) } else { Join-Path $projectRoot ("dist\Letterpane-$version-win-x64.zip") }
    $archiveStream = [System.IO.File]::Open($archivePath,[System.IO.FileMode]::Create,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None)
    $archive = New-Object System.IO.Compression.ZipArchive($archiveStream,[System.IO.Compression.ZipArchiveMode]::Create,$false)
    try {
        foreach ($archiveItem in $archiveItems) {
            $archiveFiles = if ([System.IO.Directory]::Exists($archiveItem)) { [System.IO.Directory]::EnumerateFiles($archiveItem,'*',[System.IO.SearchOption]::AllDirectories) } else { @($archiveItem) }
            foreach ($archiveFile in $archiveFiles) {
                $entryName = $archiveFile.Substring($outputRoot.Length + 1).Replace('\','/')
                $entry = $archive.CreateEntry($entryName,[System.IO.Compression.CompressionLevel]::Optimal)
                $sourceStream = [System.IO.File]::Open($archiveFile,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
                $entryStream = $entry.Open()
                try { $sourceStream.CopyTo($entryStream) } finally { $entryStream.Dispose(); $sourceStream.Dispose() }
            }
        }
    } finally { $archive.Dispose(); $archiveStream.Dispose() }
}
Write-Output (Join-Path $outputRoot 'Letterpane.exe')
