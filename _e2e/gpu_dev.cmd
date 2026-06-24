@echo off
REM GPU dev launcher: CUDA build env (mirrors src-tauri/target/cuda-build.cmd) + WebView2 remote-debug + npm tauri dev --features cuda.
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set "CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3"
set "PATH=C:\Users\stas\.cargo\bin;%CUDA_PATH%\bin;C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja;%PATH%"
set "CMAKE_GENERATOR=Ninja"
set "CMAKE_GENERATOR_INSTANCE="
set "CMAKE_CUDA_ARCHITECTURES=120"
set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222"
cd /d C:\ai-interview\interviewlab
call npm run tauri dev -- --features cuda
