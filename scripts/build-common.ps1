function Get-ReleaseHash([string]$LiteralPath) {
    $stream = [System.IO.File]::OpenRead($LiteralPath)
    $hash = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','') }
    finally { $hash.Dispose(); $stream.Dispose() }
}
