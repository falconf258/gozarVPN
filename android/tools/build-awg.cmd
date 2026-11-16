@echo off
rem Builds wireproxy-awg (AmneziaWG userspace client exposing SOCKS5) for Windows x64, Android arm64 and armv7.
rem Settings: GOZAR_ENV = optional .cmd that puts JDK / Android SDK / NDK / Go / Gradle on PATH;
rem           GOZAR_SRC = folder for the upstream sources and outputs (default: "src" next to this script).
if defined GOZAR_ENV call "%GOZAR_ENV%"
if not defined GOZAR_SRC set "GOZAR_SRC=%~dp0src"
cd /d %GOZAR_SRC%\wireproxy-awg || exit /b 1
git rev-parse HEAD
rem pin the Go toolchain to the version go.mod names (a newer Go broke psiphon's vendored TLS fork)
set GOTOOLCHAIN=go1.26.3
set GOPROXY=https://goproxy.cn,https://goproxy.io,direct
set CGO_ENABLED=0
if not exist %GOZAR_SRC%\awg-out mkdir %GOZAR_SRC%\awg-out
set GOOS=windows
set GOARCH=amd64
go build -trimpath -ldflags "-s -w" -o %GOZAR_SRC%\awg-out\awg-proxy.exe ./cmd/wireproxy || exit /b 1
set GOOS=linux
set GOARCH=arm64
go build -trimpath -ldflags "-s -w" -o %GOZAR_SRC%\awg-out\awg-proxy-arm64 ./cmd/wireproxy || exit /b 1
set GOARCH=arm
set GOARM=7
go build -trimpath -ldflags "-s -w" -o %GOZAR_SRC%\awg-out\awg-proxy-armv7 ./cmd/wireproxy || exit /b 1
for %%f in (%GOZAR_SRC%\awg-out\awg-proxy.exe %GOZAR_SRC%\awg-out\awg-proxy-arm64 %GOZAR_SRC%\awg-out\awg-proxy-armv7) do certutil -hashfile %%f SHA256 | findstr /v "hash CertUtil"
echo BUILD_OK
pause
