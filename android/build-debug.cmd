@echo off
rem Builds the debug APK (needs JDK 21, Gradle and the Android SDK on PATH).
rem Settings: GOZAR_ENV = optional .cmd that puts JDK / Android SDK / NDK / Go / Gradle on PATH;
rem           GOZAR_SRC = folder for the upstream sources and outputs (default: "src" next to this script).
if defined GOZAR_ENV call "%GOZAR_ENV%"
if not defined GOZAR_SRC set "GOZAR_SRC=%~dp0src"
cd /d "%~dp0"
gradle :app:assembleDebug --no-daemon
echo.
echo APK: %~dp0app\build\outputs\apk\debug\app-debug.apk
