<#
  InterviewLab — one-shot setup from source for Windows (with GPU/CUDA).

  DETECTS your configuration (GPU + which build dependencies are present), INSTALLS only the
  missing heavy dependencies via winget, then builds (or runs) the app from source. Builds the
  CUDA (GPU) variant when an Nvidia GPU is present, otherwise a CPU build.

  Usage (from the repo root, in PowerShell):
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1            # detect + install missing + build
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Check     # detect ONLY: report config + what's missing
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Run       # ... + run the app (tauri dev)
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -NoGpu     # force a CPU build
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -CudaArch 89  # build for a different GPU arch

  Re-running is safe: anything already installed is skipped.
#>
[CmdletBinding()]
param(
  [switch]$Run,
  [switch]$Check,
  [switch]$NoGpu,
  [string]$CudaArch = "120"  # RTX 50-series (Blackwell, sm_120). 89=Ada(40xx), 86=Ampere(30xx).
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$app  = Join-Path $repo "interviewlab"

function Info($m){ Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m){ Write-Host "  [ok]      $m" -ForegroundColor Green }
function Miss($m){ Write-Host "  [missing] $m" -ForegroundColor Yellow }

# --- detect configuration ---------------------------------------------------------------
Info "InterviewLab setup — detecting configuration (repo: $repo)"

$hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
if (-not $hasWinget -and -not $Check) {
  throw "winget not found. Install 'App Installer' from the Microsoft Store, then re-run."
}

$gpuName = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1).Name
$gpu = [bool]$gpuName -and -not $NoGpu
Write-Host ("  GPU: " + ($(if($gpuName){"$gpuName"}else{"no Nvidia GPU"})) + ($(if($NoGpu){"  (-NoGpu → CPU build)"}elseif($gpu){"  → CUDA build"}else{"  → CPU build"}))) -ForegroundColor White

# Heavy build dependencies, as data so detect + install share one source of truth.
$cudaProbe = {
  if ($env:CUDA_PATH -and (Test-Path "$env:CUDA_PATH\bin\nvcc.exe")) { return $true }
  return [bool](Get-ChildItem "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\*\bin\nvcc.exe" -ErrorAction SilentlyContinue)
}
$deps = @(
  @{ id="Git.Git";                                  name="Git";                  probe={ [bool](Get-Command git   -ErrorAction SilentlyContinue) } }
  @{ id="OpenJS.NodeJS.LTS";                         name="Node.js (LTS)";        probe={ [bool](Get-Command node  -ErrorAction SilentlyContinue) } }
  @{ id="Rustlang.Rustup";                           name="Rust (rustup)";        probe={ [bool](Get-Command rustc -ErrorAction SilentlyContinue) -or (Test-Path "$env:USERPROFILE\.cargo\bin\rustc.exe") } }
  @{ id="LLVM.LLVM";                                 name="LLVM / libclang";      probe={ Test-Path "C:\Program Files\LLVM\bin\libclang.dll" } }
  @{ id="Kitware.CMake";                             name="CMake";                probe={ [bool](Get-Command cmake -ErrorAction SilentlyContinue) } }
  @{ id="Ninja-build.Ninja";                         name="Ninja";                probe={ [bool](Get-Command ninja -ErrorAction SilentlyContinue) } }
  @{ id="Microsoft.VisualStudio.2022.BuildTools";    name="VS 2022 Build Tools (C++)"; probe={ Test-Path "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" }
     override=@("--quiet","--wait","--norestart","--add","Microsoft.VisualStudio.Workload.VCTools","--add","Microsoft.VisualStudio.Component.VC.Tools.x86.x64","--add","Microsoft.VisualStudio.Component.Windows11SDK.22621") }
)
if ($gpu) { $deps += @{ id="Nvidia.CUDA"; name="CUDA Toolkit"; probe=$cudaProbe } }

Info "dependency status:"
$missing = @()
foreach ($d in $deps) {
  if (& $d.probe) { Ok $d.name } else { Miss $d.name; $missing += $d }
}

if ($Check) {
  Write-Host ""
  Info ("plan: " + ($(if($missing.Count){"install $($missing.Count) missing package(s), then "}else{"all deps present, "})) +
        "build " + ($(if($gpu){"GPU/CUDA (sm_$CudaArch)"}else{"CPU"})) + " from source.")
  Info "re-run without -Check to install + build."
  return
}

# --- install only the missing deps ------------------------------------------------------
foreach ($d in $missing) {
  Info "installing $($d.name) ($($d.id)) ..."
  $args = @("install","-e","--id",$d.id,"--accept-source-agreements","--accept-package-agreements","--disable-interactivity")
  if ($d.override) { $args += @("--override", ($d.override -join " ")) }
  winget @args
  if (-not (& $d.probe)) { Write-Host "  ! $($d.name) installed but still not detected — a PATH refresh / new shell may be needed." -ForegroundColor Yellow }
}
if ($missing.Count -eq 0) { Ok "all dependencies already present" }

# --- resolve toolchain paths ------------------------------------------------------------
$vswhere = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
$vsRoot  = & $vswhere -products * -latest -property installationPath
if (-not $vsRoot) { throw "Visual Studio Build Tools not found after install." }
$vcvars  = Join-Path $vsRoot "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat not found at $vcvars" }

$cudaPath = $env:CUDA_PATH
if ($gpu -and -not ($cudaPath -and (Test-Path "$cudaPath\bin\nvcc.exe"))) {
  $cudaPath = (Get-ChildItem "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA" -Directory -ErrorAction SilentlyContinue |
               Sort-Object Name -Descending | Select-Object -First 1).FullName
}
$llvmBin = "C:\Program Files\LLVM\bin"

# --- build (or run) inside a vcvars64 environment ---------------------------------------
$features = if ($gpu) { "--features cuda" } else { "" }
$tauriCmd = if ($Run) { "npm run tauri dev -- $features" } else { "npm run tauri build -- $features" }

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
  Get-ChildItem $bundle -Recurse -Include *.exe,*.msi -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "    $($_.FullName)" }
  Write-Host ""
  Ok "Done. Install from the .msi/.exe above, or re-run with -Run to launch directly."
}
