@echo off
REM Builds probe.exe. Finds the Build Tools install itself so there is nothing
REM to configure -- run it from a normal shell, not a developer prompt.

setlocal

set VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe
if not exist "%VSWHERE%" (
  echo Visual Studio Build Tools not found. Install with:
  echo   winget install Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
  exit /b 1
)

for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set VSPATH=%%i

if "%VSPATH%"=="" (
  echo Found Visual Studio but not the C++ tools. Re-run the winget command above.
  exit /b 1
)

call "%VSPATH%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1

cd /d "%~dp0"
cl /nologo /std:c++17 /EHsc /W3 probe.cpp /Fe:probe.exe /link ole32.lib mmdevapi.lib

if errorlevel 1 (
  echo.
  echo Build failed. If the error names audioclientactivationparams.h, the
  echo Windows 11 SDK component is missing -- that header does not ship with
  echo the Windows 10 SDK.
  exit /b 1
)

echo.
echo Built probe.exe. Run it with something playing:
echo   probe.exe              ^(captures everything^)
echo   probe.exe ^<discord-pid^>  ^(captures everything except Discord^)
