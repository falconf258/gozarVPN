@echo off
rem Builds the OpenVPN 2 client (from ics-openvpn, GPLv2) for Android arm64-v8a and armeabi-v7a.
rem Output: %GOZAR_SRC%\openvpn-out\<abi>\libovpnexec.so (executable) + libopenvpn.so (its library).
rem GozarVpn runs it as a separate process; nothing of it is linked into the app.
rem Everything shown here is also written to %GOZAR_SRC%\openvpn-build.log.
rem Settings: GOZAR_ENV = optional .cmd that puts JDK / Android SDK / NDK / Go / Gradle on PATH;
rem           GOZAR_SRC = folder for the upstream sources and outputs (default: "src" next to this script).
if defined GOZAR_ENV call "%GOZAR_ENV%"
if not defined GOZAR_SRC set "GOZAR_SRC=%~dp0src"
if not "%~1"=="run" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "& cmd /c '\"%~f0\" run' 2>&1 | Tee-Object -FilePath %GOZAR_SRC%\openvpn-build.log"
  echo.
  echo Log: %GOZAR_SRC%\openvpn-build.log
  pause
  exit /b
)
cd /d %GOZAR_SRC%\ics-openvpn || exit /b 1
git rev-parse HEAD
set CMAKEVER=3.31.6
if not exist %ANDROID_HOME%\cmake\%CMAKEVER%\bin\cmake.exe (
  echo y| call sdkmanager --sdk_root=%ANDROID_HOME% "cmake;%CMAKEVER%" || exit /b 1
)
set PATH=%ANDROID_HOME%\cmake\%CMAKEVER%\bin;%PATH%
if not exist %GOZAR_SRC%\openvpn-out mkdir %GOZAR_SRC%\openvpn-out
for %%a in (arm64-v8a armeabi-v7a) do (
  if exist %GOZAR_SRC%\openvpn-build\%%a rmdir /s /q %GOZAR_SRC%\openvpn-build\%%a
  rem the "skeleton" output path is ics-openvpn's own switch for building OpenVPN 2 only
  rem (no OpenVPN 3 / SWIG Java bindings, which GozarVpn does not use)
  cmake -S main\src\main\cpp -B %GOZAR_SRC%\openvpn-build\%%a -G Ninja ^
    -DCMAKE_TOOLCHAIN_FILE=%ANDROID_NDK_HOME%\build\cmake\android.toolchain.cmake ^
    -DANDROID_ABI=%%a -DANDROID_PLATFORM=android-24 -DCMAKE_BUILD_TYPE=Release ^
    "-DCMAKE_C_FLAGS=-ffile-prefix-map=%GOZAR_SRC:\=/%/ics-openvpn/main/src/main/cpp=. -ffile-prefix-map=%GOZAR_SRC%\ics-openvpn\main\src\main\cpp=." ^
    -DCMAKE_LIBRARY_OUTPUT_DIRECTORY=%GOZAR_SRC:\=/%/openvpn-build/%%a/build/intermediates/cmake/skeleton/obj/%%a/ || exit /b 1
  cmake --build %GOZAR_SRC%\openvpn-build\%%a --target openvpn libovpnexec.so || exit /b 1
  if not exist %GOZAR_SRC%\openvpn-out\%%a mkdir %GOZAR_SRC%\openvpn-out\%%a
  for /r %GOZAR_SRC%\openvpn-build\%%a %%f in (libopenvpn.so libovpnexec.so) do if exist "%%f" copy /y "%%f" %GOZAR_SRC%\openvpn-out\%%a\ >nul
  %ANDROID_NDK_HOME%\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-strip.exe %GOZAR_SRC%\openvpn-out\%%a\libopenvpn.so %GOZAR_SRC%\openvpn-out\%%a\libovpnexec.so || exit /b 1
)
for /r %GOZAR_SRC%\openvpn-out %%f in (*.so) do certutil -hashfile "%%f" SHA256 | findstr /v "hash CertUtil"
echo BUILD_OK
