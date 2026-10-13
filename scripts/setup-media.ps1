$ErrorActionPreference = 'Stop'
$shelfProject = Split-Path -Parent $PSScriptRoot
$shelfTools = Join-Path $shelfProject 'tools'
$shelfCache = Join-Path $shelfProject '.cache\media'
function Get-ShelfSha([string]$File) {
  $shelfStream = [System.IO.File]::OpenRead($File)
  $shelfHasher = [System.Security.Cryptography.SHA256]::Create()
  try { return ([System.BitConverter]::ToString($shelfHasher.ComputeHash($shelfStream))).Replace('-','').ToLowerInvariant() }
  finally { $shelfStream.Dispose(); $shelfHasher.Dispose() }
}
if ((Test-Path (Join-Path $shelfTools 'manifest.json')) -and (Test-Path (Join-Path $shelfTools 'yt-dlp.exe')) -and (Test-Path (Join-Path $shelfTools 'ffmpeg.exe')) -and (Test-Path (Join-Path $shelfTools 'ffprobe.exe'))) {
  $shelfManifest = Get-Content -LiteralPath (Join-Path $shelfTools 'manifest.json') -Raw | ConvertFrom-Json
  foreach ($shelfEntry in $shelfManifest.files) {
    $shelfActual = Get-ShelfSha (Join-Path $shelfTools $shelfEntry.name)
    if ($shelfActual -ne $shelfEntry.sha256) { throw "Bundled media binary checksum mismatch: $($shelfEntry.name)" }
  }
  Write-Output 'Bundled media tools already prepared and checksum verified.'
  exit 0
}
New-Item -ItemType Directory -Path $shelfTools,$shelfCache -Force | Out-Null
function Get-ShelfDownload([string]$Url,[string]$File) {
  if (-not (Test-Path -LiteralPath $File) -or (Get-Item -LiteralPath $File).Length -eq 0) {
    $shelfPartial = $File + '.part'
    & curl.exe -fL --retry 2 --connect-timeout 20 --max-time 600 --silent --show-error -o $shelfPartial $Url
    if ($LASTEXITCODE -ne 0) { throw 'Unable to download upstream media tools. Please retry setup:media.' }
    Move-Item -LiteralPath $shelfPartial -Destination $File -Force
  }
}
function Get-ShelfText([string]$Url) {
  $shelfContent = (Invoke-WebRequest -UseBasicParsing -Uri $Url).Content
  if ($shelfContent -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($shelfContent) }
  return [string]$shelfContent
}
function Assert-ShelfHash([string]$File,[string]$Checksums,[string]$Name) {
  $shelfLine = ($Checksums -split "`n" | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($Name) + '\s*$') } | Select-Object -First 1)
  if (-not $shelfLine) { throw "Missing official checksum: $Name" }
  $shelfExpected = ($shelfLine.Trim() -split '\s+')[0].ToLowerInvariant()
  if ((Get-ShelfSha $File) -ne $shelfExpected) { throw "Download checksum mismatch: $Name" }
}
$shelfYtVersion = '2026.08.19'
$shelfYtBase = "https://github.com/yt-dlp/yt-dlp/releases/download/$shelfYtVersion"
$shelfYtFile = Join-Path $shelfCache "yt-dlp-$shelfYtVersion.exe"
Get-ShelfDownload "$shelfYtBase/yt-dlp.exe" $shelfYtFile
$shelfYtHashes = Get-ShelfText "$shelfYtBase/SHA2-256SUMS"
Assert-ShelfHash $shelfYtFile $shelfYtHashes 'yt-dlp.exe'
Copy-Item -LiteralPath $shelfYtFile -Destination (Join-Path $shelfTools 'yt-dlp.exe') -Force
Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$shelfYtVersion/THIRD_PARTY_LICENSES.txt" -OutFile (Join-Path $shelfTools 'yt-dlp-THIRD_PARTY_LICENSES.txt')
Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/yt-dlp/yt-dlp/$shelfYtVersion/LICENSE" -OutFile (Join-Path $shelfTools 'yt-dlp-LICENSE.txt')
$shelfFfName = 'ffmpeg-n8.1-latest-win64-lgpl-8.1.zip'
$shelfFfBase = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest'
$shelfFfFile = Join-Path $shelfCache $shelfFfName
Get-ShelfDownload "$shelfFfBase/$shelfFfName" $shelfFfFile
$shelfFfHashes = Get-ShelfText "$shelfFfBase/checksums.sha256"
Assert-ShelfHash $shelfFfFile $shelfFfHashes $shelfFfName
$shelfExpanded = Join-Path $shelfCache 'ffmpeg-8.1'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$shelfZip = [System.IO.Compression.ZipFile]::OpenRead($shelfFfFile)
try {
  $shelfExpandRoot = [System.IO.Path]::GetFullPath($shelfExpanded) + [System.IO.Path]::DirectorySeparatorChar
  foreach ($shelfZipEntry in $shelfZip.Entries) {
    $shelfZipTarget = [System.IO.Path]::GetFullPath((Join-Path $shelfExpanded $shelfZipEntry.FullName))
    if (-not $shelfZipTarget.StartsWith($shelfExpandRoot,[System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry escapes extraction directory.' }
    if ($shelfZipEntry.Name) {
      [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($shelfZipTarget)) | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($shelfZipEntry,$shelfZipTarget,$true)
    }
  }
} finally { $shelfZip.Dispose() }
foreach ($shelfName in @('ffmpeg.exe','ffprobe.exe')) {
  $shelfBinary = Get-ChildItem -LiteralPath $shelfExpanded -File -Recurse -Filter $shelfName | Select-Object -First 1
  if (-not $shelfBinary) { throw "FFmpeg archive is missing $shelfName" }
  Copy-Item -LiteralPath $shelfBinary.FullName -Destination (Join-Path $shelfTools $shelfName) -Force
}
$shelfNotices = Join-Path $shelfTools 'ffmpeg-notices'
New-Item -ItemType Directory -Path $shelfNotices -Force | Out-Null
Get-ChildItem -LiteralPath $shelfExpanded -Recurse -File | Where-Object { $_.Name -match '^(LICENSE|COPYING|README)' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $shelfNotices $_.Name) -Force }
$shelfFiles = @('yt-dlp.exe','ffmpeg.exe','ffprobe.exe') | ForEach-Object { @{name=$_;sha256=(Get-ShelfSha (Join-Path $shelfTools $_))} }
@{ytDlpVersion=$shelfYtVersion;ffmpegArchive=$shelfFfName;ffmpegArchiveSha256=(Get-ShelfSha $shelfFfFile);ytDlpSource="https://github.com/yt-dlp/yt-dlp/tree/$shelfYtVersion";ffmpegBuildSource='https://github.com/BtbN/FFmpeg-Builds';ffmpegSource='https://ffmpeg.org/releases/';files=$shelfFiles} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $shelfTools 'manifest.json') -Encoding utf8
Write-Output 'Media tools prepared from upstream releases; SHA-256 verified.'
