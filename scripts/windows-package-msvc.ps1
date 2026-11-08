param(
  [string]$ArtifactsRoot = "",
  [switch]$SkipRustInstall,
  [switch]$SkipNpmCi,
  [switch]$CleanArtifacts
)

$ErrorActionPreference = "Stop"
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = Join-Path $appRoot "src-tauri\target\x86_64-pc-windows-msvc\release"
if ([string]::IsNullOrWhiteSpace($ArtifactsRoot)) {
  $ArtifactsRoot = Join-Path $appRoot ".artifacts\windows-msvc"
}

function Add-PathEntry($PathEntry) {
  if ([string]::IsNullOrWhiteSpace($PathEntry) -or -not (Test-Path $PathEntry)) { return }
  if (($env:PATH -split ";") -notcontains $PathEntry) { $env:PATH = "$PathEntry;$env:PATH" }
}

function Test-Command($Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-RustMsvcToolchain {
  $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
  Add-PathEntry $cargoBin
  $toolchains = if (Test-Command "rustup") { & rustup toolchain list 2>$null } else { @() }
  if ((Test-Command "cargo") -and (Test-Command "rustc") -and ($toolchains -match "stable-x86_64-pc-windows-msvc")) {
    Write-Host "[ok] Rust MSVC toolchain already installed"
    return
  }
  if ($SkipRustInstall) { throw "Rust MSVC toolchain is missing. Re-run without -SkipRustInstall to install it automatically." }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $rustupInit = Join-Path $env:TEMP "rustup-init-x86_64-pc-windows-msvc.exe"
  Invoke-WebRequest -Uri "https://win.rustup.rs/x86_64" -OutFile $rustupInit
  & $rustupInit -y --default-toolchain stable-x86_64-pc-windows-msvc
  Add-PathEntry $cargoBin
  & rustup toolchain install stable-x86_64-pc-windows-msvc
  & rustup default stable-x86_64-pc-windows-msvc
  if (-not (Test-Command "cargo") -or -not (Test-Command "rustc")) { throw "Rust installation finished, but cargo/rustc is not available in PATH." }
}

function Find-VsDevCmd {
  $candidates = @()
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if (-not [string]::IsNullOrWhiteSpace($installPath)) { $candidates += Join-Path $installPath "Common7\Tools\VsDevCmd.bat" }
  }
  foreach ($candidate in $candidates) { if (Test-Path $candidate) { return (Resolve-Path $candidate).Path } }
  throw "VsDevCmd.bat not found. Install Visual Studio Build Tools with the Desktop development with C++ workload."
}

function Reset-ArtifactsRoot {
  if (-not $CleanArtifacts) { New-Item -ItemType Directory -Force -Path $ArtifactsRoot | Out-Null; return }
  $resolvedAppRoot = (Resolve-Path $appRoot).Path
  if (Test-Path $ArtifactsRoot) {
    $resolvedArtifactsRoot = (Resolve-Path $ArtifactsRoot).Path
    if (-not $resolvedArtifactsRoot.StartsWith($resolvedAppRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "-CleanArtifacts refuses to delete output outside the app root: $resolvedArtifactsRoot"
    }
    Remove-Item -LiteralPath $resolvedArtifactsRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $ArtifactsRoot | Out-Null
}

Push-Location $appRoot
try {
  Write-Host "[info] App root: $appRoot"
  Install-RustMsvcToolchain
  $vsDevCmd = Find-VsDevCmd
  Write-Host "[ok] VsDevCmd.bat -> $vsDevCmd"
  if (-not (Test-Command "node") -or -not (Test-Command "npm.cmd")) { throw "Node.js/npm.cmd not found." }
  if ($SkipNpmCi) {
    if (-not (Test-Path (Join-Path $appRoot "node_modules"))) { throw "-SkipNpmCi was set, but node_modules does not exist." }
    Write-Host "[info] Skipping npm.cmd ci"
  } else {
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
  }
  . (Join-Path $PSScriptRoot "prepare-windows-sherpa.ps1") -AppRoot $appRoot
  $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
  $buildCommand = "call `"$vsDevCmd`" -arch=x64 -host_arch=x64 && set `"PATH=$cargoBin;!PATH!`" && npm.cmd run tauri -- build --target x86_64-pc-windows-msvc --bundles nsis"
  & cmd.exe /V:ON /d /c $buildCommand
  if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS build failed with exit code $LASTEXITCODE." }

  $version = (Get-Content -LiteralPath (Join-Path $appRoot "package.json") -Raw | ConvertFrom-Json).version
  $installer = Join-Path $releaseRoot "bundle\nsis\言序_${version}_x64-setup.exe"
  $appExe = Join-Path $releaseRoot "yanxu.exe"
  $webView2Loader = Get-ChildItem -Path (Join-Path $releaseRoot "build") -Recurse -Filter "WebView2Loader.dll" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match "\\out\\x64\\WebView2Loader\.dll$" } | Select-Object -First 1
  if (-not (Test-Path $installer)) { throw "NSIS installer not found: $installer" }
  if (-not (Test-Path $appExe)) { throw "Release executable not found: $appExe" }
  if ($null -eq $webView2Loader) { throw "WebView2Loader.dll not found under $releaseRoot\build" }

  Reset-ArtifactsRoot
  Copy-Item -LiteralPath $installer -Destination $ArtifactsRoot -Force
  $portableRoot = Join-Path $ArtifactsRoot "YanXu_${version}_x64_portable"
  New-Item -ItemType Directory -Force -Path $portableRoot | Out-Null
  Copy-Item -LiteralPath $appExe -Destination (Join-Path $portableRoot "yanxu.exe") -Force
  Copy-Item -LiteralPath $webView2Loader.FullName -Destination (Join-Path $portableRoot "WebView2Loader.dll") -Force
  $portableZip = Join-Path $ArtifactsRoot "YanXu_${version}_x64_portable.zip"
  Compress-Archive -LiteralPath $portableRoot -DestinationPath $portableZip -CompressionLevel Optimal -Force
  Get-ChildItem -File -LiteralPath $ArtifactsRoot | Select-Object Name,Length,LastWriteTime | Format-Table -AutoSize
  Get-FileHash -Algorithm SHA256 -LiteralPath $installer,$portableZip | Select-Object Path,Hash | Format-List
} finally {
  Pop-Location
}
