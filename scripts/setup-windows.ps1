<#
  InterviewLab — one-shot setup from source for Windows (with GPU/CUDA).

  Installs every build dependency via winget, then builds (or runs) the app from source.
  Detects an Nvidia GPU and builds the CUDA (GPU) variant automatically; falls back to CPU.

  Usage (from the repo root, in PowerShell):
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1            # install deps + build installer
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Run       # install deps + run the app (tauri dev)
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -NoGpu      # force a CPU build
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -CudaArch 89  # build for a different GPU arch

  Re-running is safe: anything already installed is skipped.
#>
[CmdletBinding()]
param(
  [switch]$Run,
  [switch]$NoGpu,
  [string]$CudaArch = "120"  # RTX 50-series (Blackwell, sm_120). 89=Ada(40xx), 86=Ampere(30xx).
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot          # repo root (scripts\ is one level down)
$app  = Join-Path $repo "interviewlab"

function Info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m){ Write-Host "  ok: $m" -ForegroundColor Green }
function Warn($m){ Write-Host "  ! $m" -ForegroundColor Yellow }

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget not found. Install 'App Installer' from the Microsoft Store, then re-run."
}

# Install a winget package if a probe command/path is missing. Idempotent.
function Ensure($id, $probe, [string[]]$override) {
  if (& $probe) { Ok "$id already present"; return }
  Info "installing $id ..."
  $args = @("install","-e","--id",$id,"--accept-source-agreements","--accept-package-agreements","--disable-interactivity")
  if ($override) { $args += @("--override", ($override -join " ")) }
  winget @args
  if (-not (& $probe)) { Warn "$id installed but probe still failing — a new shell / PATH refresh may be needed." }
}

Info "InterviewLab setup — repo: $repo"

# --- detect Nvidia GPU ------------------------------------------------------------------
$gpu = $false
try { $gpu = [bool](Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" }) } catch {}
if ($NoGpu) { $gpu = $false }
if ($gpu) { Info "Nvidia GPU detected → GPU (CUDA) build" } else { Info "no Nvidia GPU (or -NoGpu) → CPU build" }

# --- core build deps --------------------------------------------------------------------
Ensure "Git.Git"            { Get-Command git -ErrorAction SilentlyContinue }
Ensure "OpenJS.NodeJS.LTS"  { Get-Command node -ErrorAction SilentlyContinue }
Ensure "Rustlang.Rustup"    { Get-Command rustc -ErrorAction SilentlyContinue }
Ensure "LLVM.LLVM"          { Test-Path "C:\Program Files\LLVM\bin\libclang.dll" }
Ensure "Kitware.CMake"      { Get-Command cmake -ErrorAction SilentlyContinue }
Ensure "Ninja-build.Ninja"  { Get-Command ninja -ErrorAction SilentlyContinue }

# VS 2022 Build Tools + the C++ workload (MSVC, Windows SDK) — the native toolchain Tauri/whisper need.
Ensure "Microsoft.VisualStudio.2022.BuildTools" `
  { Test-Path "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" } `
  @("--quiet","--wait","--norestart",
    "--add","Microsoft.VisualStudio.Workload.VCTools",
    "--add","Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
    "--add","Microsoft.VisualStudio.Component.Windows11SDK.22621")

if ($gpu) {
  # CUDA Toolkit (nvcc + cuBLAS) — needed to compile the whisper.cpp CUDA kernels.
  Ensure "Nvidia.CUDA" { Test-Path "$env:CUDA_PATH\bin\nvcc.exe" }
}

# --- resolve toolchain paths ------------------------------------------------------------
$vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
$vsRoot  = & $vswhere -products * -latest -property installationPath
if (-not $vsRoot) { throw "Visual Studio Build Tools not found after install." }
$vcvars  = Join-Path $vsRoot "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }
Ok "MSVC: $vsRoot"

$cudaPath = $env:CUDA_PATH
if ($gpu -and -not (Test-Path "$cudaPath\bin\nvcc.exe")) {
  # CUDA_PATH may not be in this shell yet right after install — find the newest v* dir.
  $cudaPath = (Get-ChildItem "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA" -Directory -ErrorAction SilentlyContinue |
               Sort-Object Name -Descending | Select-Object -First 1).FullName
}
if ($gpu) { Ok "CUDA: $cudaPath" }

$llvmBin = "C:\Program Files\LLVM\bin"

# --- build (or run) inside a vcvars64 environment ---------------------------------------
$features = if ($gpu) { "--features cuda" } else { "" }
$tauriCmd = if ($Run) { "npm run tauri dev -- $features" } else { "npm run tauri build -- $features" }

# Compose a .cmd that sets the proven build env (mirrors _e2e/gpu_dev.cmd) and runs the build.
$cudaEnv = ""
if ($gpu) {
  $cudaEnv = @"
set "CUDA_PATH=$cudaPath"
set "PATH=%CUDA_PATH%\bin;%PATH%"
set "CMAKE_GENERATOR=Ninja"
set "CMAKE_GENERATOR_INSTANCE="
set "CMAKE_CUDA_ARCHITECTURES=$CudaArch"
"@
}
$cmd = @"
@echo off
call "$vcvars" >nul 2>&1
set "PATH=$llvmBin;%USERPROFILE%\.cargo\bin;%PATH%"
set "LIBCLANG_PATH=$llvmBin"
$cudaEnv
cd /d "$app"
echo === npm install ===
call npm install || exit /b 1
echo === $tauriCmd ===
call $tauriCmd
exit /b %ERRORLEVEL%
"@
$cmdFile = Join-Path $env:TEMP "interviewlab-build.cmd"
Set-Content -Path $cmdFile -Value $cmd -Encoding Ascii

Info ("building from source " + ($(if($gpu){"(GPU/CUDA, sm_$CudaArch)"}else{"(CPU)"})) + " — this compiles whisper.cpp and can take a while...")
& cmd /c "`"$cmdFile`""
if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE). See output above." }

if ($Run) {
  Ok "app launched (tauri dev)."
} else {
  $bundle = Join-Path $app "src-tauri\target\release\bundle"
  Info "build done. Installers / app here:"
  Get-ChildItem $bundle -Recurse -Include *.exe,*.msi -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host "    $($_.FullName)" }
  Write-Host ""
  Ok "Done. Install from the .msi/.exe above, or re-run with -Run to launch directly."
}
