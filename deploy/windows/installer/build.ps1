<#
.SYNOPSIS
  Build the Windows hub installer, dist\Aeneas-Hub-Setup-VERSION.exe, and its SHA-256, on Windows.
.DESCRIPTION
  Uses NSIS 3: the copy Tauri keeps (%LOCALAPPDATA%\tauri\NSIS, there after building the Windows app) or one installed
  from nsis.sourceforge.io.
    powershell -ExecutionPolicy Bypass -File deploy\windows\installer\build.ps1
  Its version is the repository's (tools\version.mjs), the one the hub and every app say; a version given must be the same.
#>
param([string]$Version)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$repoVersion = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
if (-not $Version) { $Version = $repoVersion }
if ($Version -notmatch '^[0-9.]+$') { throw 'the version is numbers and dots, like 1.0.2' }
if ($Version -ne $repoVersion) { throw "the installer's version is the repository's ($repoVersion), so the hub it installs says the same; not $Version" }
$out = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$nsis = @((Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'), "${env:ProgramFiles(x86)}\NSIS\makensis.exe", "$env:ProgramFiles\NSIS\makensis.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $nsis) { throw 'NSIS 3 is needed: build the Windows app once (Tauri brings it), or install it from nsis.sourceforge.io' }
& $nsis /V2 "/DVERSION=$Version" "/DOUTDIR=$out" (Join-Path $PSScriptRoot 'aeneas-hub.nsi')
if ($LASTEXITCODE) { throw "makensis failed ($LASTEXITCODE)" }
$exe = Join-Path $out "Aeneas-Hub-Setup-$Version.exe"
$sum = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
[IO.File]::WriteAllText("$exe.sha256", "$sum  $(Split-Path $exe -Leaf)`n")
"built $exe ($([math]::Round((Get-Item $exe).Length / 1KB)) KB), sha256 $sum"
