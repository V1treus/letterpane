param([string]$OutputDirectory,[string]$ArchivePath,[string]$PortablePath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'build-common.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot ("dist\Letterpane $version") }
if (-not $ArchivePath) { $ArchivePath = Join-Path $projectRoot ("dist\Letterpane-$version-win-x64.zip") }
if (-not $PortablePath) { $PortablePath = Join-Path $projectRoot ("dist\Letterpane Portable $version.exe") }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-ZipReport($Archive,[string]$Name) {
    $records = @()
    $manifest = $null; $info = $null; [long]$totalSize = 0
    if ($Archive.Entries.Count -gt 10000) { throw 'Too many archive entries.' }
    foreach ($entry in $Archive.Entries) {
        $totalSize += $entry.Length
        if ($entry.Length -gt 150MB -or $totalSize -gt 500MB) { throw 'Release archive size exceeds the verification limit.' }
        $stream = $entry.Open()
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $digest = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
        finally { $hasher.Dispose(); $stream.Dispose() }
        $records += @{ path = $entry.FullName; size = $entry.Length; sha256 = $digest }
        if ($entry.FullName -eq 'release-manifest.json' -or $entry.FullName -eq 'build-info.json') {
            if ($entry.Length -gt 2MB) { throw 'Release metadata is too large.' }
            $reader = New-Object System.IO.StreamReader($entry.Open())
            try { $value = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
            if ($entry.FullName -eq 'release-manifest.json') { $manifest = $value } else { $info = $value }
        }
    }
    if (-not $manifest -or -not $info) { throw 'Missing release metadata.' }
    return @{ name = $Name; entries = $records; manifest = $manifest; info = $info }
}
$distributions = @()
$zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($ArchivePath))
try { $distributions += Read-ZipReport $zip 'ZIP' } finally { $zip.Dispose() }
# Read the resource without executing the portable launcher.
$assembly = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes([IO.Path]::GetFullPath($PortablePath)))
$payload = $assembly.GetManifestResourceStream('Letterpane.Payload.zip')
if (-not $payload) { throw 'Portable payload is missing.' }
$embedded = New-Object IO.Compression.ZipArchive($payload,[IO.Compression.ZipArchiveMode]::Read,$false)
try { $distributions += Read-ZipReport $embedded 'Portable EXE' } finally { $embedded.Dispose(); $payload.Dispose() }
$report = @{ distributions = $distributions; nativeVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $OutputDirectory 'Letterpane.exe')).ProductVersion; portableVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo([IO.Path]::GetFullPath($PortablePath)).ProductVersion }
$reportDirectory = Join-Path $projectRoot '.build\verification'
New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
$reportPath = Join-Path $reportDirectory 'release-report.json'
[IO.File]::WriteAllText($reportPath,($report | ConvertTo-Json -Depth 12),(New-Object Text.UTF8Encoding($false)))
& node (Join-Path $PSScriptRoot 'verify-release-report.mjs') $reportPath
if ($LASTEXITCODE -ne 0) { throw 'Release integrity verification failed.' }
$hashLines = @($PortablePath,$ArchivePath) | ForEach-Object { (Get-ReleaseHash $_).ToLowerInvariant() + '  ' + (Split-Path -Leaf $_) }
[IO.File]::WriteAllText((Join-Path $projectRoot ("dist\Letterpane-$version-SHA256SUMS.txt")),(($hashLines -join "`n") + "`n"),(New-Object Text.UTF8Encoding($false)))
Write-Output 'SHA256SUMS written.'
