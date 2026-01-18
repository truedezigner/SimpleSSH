param()

$repoRoot = Split-Path -Parent $PSScriptRoot
$iconsDir = Join-Path $repoRoot "assets\\icons"
$pngPath = Join-Path $iconsDir "app-256.png"
$icoPath = Join-Path $iconsDir "app.ico"

if (-not (Test-Path $iconsDir)) {
  New-Item -ItemType Directory -Path $iconsDir | Out-Null
}

if (-not (Test-Path $pngPath)) {
  if (Test-Path $icoPath) {
    Write-Host "app-256.png not found; keeping existing app.ico."
    exit 0
  }
  throw "Missing $pngPath and $icoPath. Add app-256.png to generate app.ico."
}

Add-Type -AssemblyName System.Drawing

$base = [System.Drawing.Bitmap]::FromFile($pngPath)
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$iconImages = @()

foreach ($size in $sizes) {
  $bitmap = New-Object System.Drawing.Bitmap $size, $size
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.DrawImage($base, 0, 0, $size, $size)
  $graphics.Dispose()

  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()

  $iconImages += ,@{
    Size = $size
    Data = $stream.ToArray()
  }
  $stream.Dispose()
}

$base.Dispose()

$fileStream = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter($fileStream)

$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$iconImages.Count)

$offset = 6 + (16 * $iconImages.Count)
foreach ($entry in $iconImages) {
  $size = [int]$entry.Size
  $dimension = if ($size -eq 256) { 0 } else { $size }
  $writer.Write([Byte]$dimension)
  $writer.Write([Byte]$dimension)
  $writer.Write([Byte]0)
  $writer.Write([Byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$entry.Data.Length)
  $writer.Write([UInt32]$offset)
  $offset += $entry.Data.Length
}

foreach ($entry in $iconImages) {
  $writer.Write($entry.Data)
}

$writer.Flush()
$writer.Dispose()
$fileStream.Dispose()

Write-Host "Wrote $icoPath"
