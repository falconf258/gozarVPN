@echo off
rem Windows x64 build of psiphon-tunnel-core (ConsoleClient) from the same pinned commit as the Android one.
rem Settings: GOZAR_ENV = optional .cmd that puts JDK / Android SDK / NDK / Go / Gradle on PATH;
rem           GOZAR_SRC = folder for the upstream sources and outputs (default: "src" next to this script).
if defined GOZAR_ENV call "%GOZAR_ENV%"
if not defined GOZAR_SRC set "GOZAR_SRC=%~dp0src"
cd /d %GOZAR_SRC%\psiphon-tunnel-core || exit /b 1
git rev-parse HEAD
rem the vendored TLS fork only works with the toolchain go.mod pins (go1.27 builds panic at start)
set GOTOOLCHAIN=go1.26.3
set GOPROXY=https://goproxy.cn,https://goproxy.io,direct
set CGO_ENABLED=0
set GOOS=windows
set GOARCH=amd64
set GOFLAGS=-mod=vendor
go build -trimpath -ldflags "-s -w" -o %GOZAR_SRC%\psiphon-out\psiphon-tunnel-core.exe ./ConsoleClient || exit /b 1
echo BUILD_OK
