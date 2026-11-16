@echo off
rem Builds %GOZAR_SRC%\libbox\libbox-arm64-armv7.aar (arm64-v8a + armeabi-v7a) from %GOZAR_SRC%\sing-box (v1.14.4).
rem Settings: GOZAR_ENV = optional .cmd that puts JDK / Android SDK / NDK / Go / Gradle on PATH;
rem           GOZAR_SRC = folder for the upstream sources and outputs (default: "src" next to this script).
if defined GOZAR_ENV call "%GOZAR_ENV%"
if not defined GOZAR_SRC set "GOZAR_SRC=%~dp0src"
rem proxy.golang.org answers 403 for some modules from this exit IP; go.sum still pins every hash.
set "GOPROXY=https://goproxy.io,https://goproxy.cn,direct"
cd /d %GOZAR_SRC%\sing-box
rem targets live here, not on the command line: cmd splits arguments at commas
set "TARGETS=android/arm64,android/arm"
gomobile bind -v -o %GOZAR_SRC%\libbox\libbox-arm64-armv7.aar -target %TARGETS% -androidapi 24 -javapkg=io.nekohasekai -libname=box -trimpath -buildvcs=false -ldflags "-X github.com/sagernet/sing-box/constant.Version=1.14.4 -X runtime.godebugDefault=multipathtcp=0,tlssha1=1 -checklinkname=0 -s -w -buildid=" -tags "with_gvisor,with_quic,with_wireguard,with_utls,with_clash_api,badlinkname,tfogo_checklinkname0,with_low_memory" ./experimental/libbox
echo BIND_DONE %ERRORLEVEL%
