param(
  [string]$SourcePath = "",
  [string]$OutputPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

if (-not $SourcePath) {
  $SourcePath = Join-Path $PSScriptRoot "..\assets\icon.png"
}

if (-not $OutputPath) {
  $OutputPath = Join-Path $PSScriptRoot "..\assets\icon.ico"
}

$sourceFullPath = [System.IO.Path]::GetFullPath($SourcePath)
$outputFullPath = [System.IO.Path]::GetFullPath($OutputPath)

if (-not (Test-Path $sourceFullPath)) {
  throw "Arquivo de origem nao encontrado: $sourceFullPath"
}

$outputDir = [System.IO.Path]::GetDirectoryName($outputFullPath)
if ($outputDir -and -not (Test-Path $outputDir)) {
  New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$sizes = @(16, 20, 24, 32, 40, 48, 64, 96, 128, 256)
$frames = New-Object System.Collections.Generic.List[object]

$sourceImage = [System.Drawing.Image]::FromFile($sourceFullPath)
try {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap(
      $size,
      $size,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )

    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.Clear([System.Drawing.Color]::Transparent)
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

      $scale = [Math]::Min($size / $sourceImage.Width, $size / $sourceImage.Height)
      $drawWidth = [int][Math]::Round($sourceImage.Width * $scale)
      $drawHeight = [int][Math]::Round($sourceImage.Height * $scale)
      $x = [int][Math]::Floor(($size - $drawWidth) / 2)
      $y = [int][Math]::Floor(($size - $drawHeight) / 2)

      $graphics.DrawImage($sourceImage, $x, $y, $drawWidth, $drawHeight)

      $ms = New-Object System.IO.MemoryStream
      try {
        $bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $frames.Add([PSCustomObject]@{
          Size = $size
          Data = $ms.ToArray()
        }) | Out-Null
      }
      finally {
        $ms.Dispose()
      }
    }
    finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }
}
finally {
  $sourceImage.Dispose()
}

$fileStream = [System.IO.File]::Open(
  $outputFullPath,
  [System.IO.FileMode]::Create,
  [System.IO.FileAccess]::Write
)

$writer = New-Object System.IO.BinaryWriter($fileStream)
try {
  $count = [uint16]$frames.Count

  # ICONDIR
  $writer.Write([uint16]0) # reserved
  $writer.Write([uint16]1) # type: icon
  $writer.Write($count)    # image count

  # ICONDIRENTRY table offset starts after header + entries
  $offset = 6 + (16 * $frames.Count)

  foreach ($frame in $frames) {
    $size = [int]$frame.Size
    $data = [byte[]]$frame.Data

    $dimByte = if ($size -ge 256) { [byte]0 } else { [byte]$size }

    $writer.Write($dimByte)              # width
    $writer.Write($dimByte)              # height
    $writer.Write([byte]0)               # palette
    $writer.Write([byte]0)               # reserved
    $writer.Write([uint16]1)             # planes
    $writer.Write([uint16]32)            # bit depth
    $writer.Write([uint32]$data.Length)  # image size
    $writer.Write([uint32]$offset)       # image offset

    $offset += $data.Length
  }

  foreach ($frame in $frames) {
    $writer.Write([byte[]]$frame.Data)
  }
}
finally {
  $writer.Close()
  $fileStream.Close()
}

Write-Host "Icone gerado com sucesso em: $outputFullPath"
Write-Host ("Tamanhos incluidos: " + ($sizes -join ", "))
