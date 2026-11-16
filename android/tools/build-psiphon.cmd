@echo off
rem Builds psiphon-tunnel-core (ConsoleClient) for linux/arm64 at the commit Aether v2.4.0 pins.
rem Settings: GOZAR_ENV = optional .cmd that puts JDK / Android SDK / NDK / Go / Gradle on PATH;
rem           GOZAR_SRC = folder for the upstream sources and outputs (default: "src" next to this script).
if defined GOZAR_ENV call "%GOZAR_ENV%"
if not defined GOZAR_SRC set "GOZAR_SRC=%~dp0src"
cd /d %GOZAR_SRC%
if not exist psiphon-tunnel-core git clone --depth 50 -b shirokhorshid https://github.com/CluvexStudio/psiphon-tunnel-core.git
cd psiphon-tunnel-core
git checkout 83aa73b9b982e7421e00117f5b0c5aceb5dda452 || exit /b 1
git log -1 --format=%%H
rem the vendored TLS fork only works with the toolchain go.mod pins (go1.27 builds panic at start)
set GOTOOLCHAIN=go1.26.3
set GOPROXY=https://goproxy.cn,https://goproxy.io,direct
set CGO_ENABLED=0
set GOOS=linux
set GOARCH=arm64
set GOFLAGS=-mod=vendor
go version
go build -trimpath -ldflags "-s -w" -o %GOZAR_SRC%\psiphon-out\psiphon-tunnel-core ./ConsoleClient || exit /b 1
echo BUILD_OK
