@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SELF=%~f0"
set "STAGE=start"
if /I "%~1"=="--stage" if not "%~2"=="" set "STAGE=%~2"

echo.
echo Clawdbot WSL2 installer
echo.
echo This will:
echo   1) Enable WSL2 + reboot if needed
echo   2) Install Ubuntu
echo   3) Enable systemd
echo   4) Install Node.js 22, pnpm, and clawdbot
echo.

if /I "%STAGE%"=="postreboot" (
  echo Resuming after reboot...
) else (
  call :require_admin
  call :enable_wsl_features
  if "!REBOOT_REQUIRED!"=="1" (
    call :schedule_runonce postreboot
    call :reboot "WSL features enabled. Rebooting now..."
    goto :eof
  )
)

call :ensure_wsl_tools
call :ensure_ubuntu
if "!UBUNTU_READY!"=="0" goto :eof

call :enable_systemd
call :check_clawdbot
if "!SKIP_INSTALL!"=="1" (
  call :final_message
  exit /b 0
)
call :install_stack

call :final_message
exit /b 0

:require_admin
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: This installer must be run as Administrator.
  echo Right-click install.bat and choose "Run as administrator".
  exit /b 1
)
exit /b 0

:enable_wsl_features
set "REBOOT_REQUIRED=0"
call :enable_feature Microsoft-Windows-Subsystem-Linux
call :enable_feature VirtualMachinePlatform
exit /b 0

:enable_feature
set "FEATURE_NAME=%~1"
dism /online /enable-feature /featurename:%FEATURE_NAME% /all /norestart >nul
if %errorlevel%==3010 set "REBOOT_REQUIRED=1"
if %errorlevel%==0 exit /b 0
if %errorlevel%==3010 exit /b 0
echo ERROR: Failed to enable %FEATURE_NAME%.
exit /b 1

:ensure_wsl_tools
where wsl >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: WSL command not found. Reboot and re-run install.bat.
  exit /b 1
)

wsl --set-default-version 2 >nul 2>&1
exit /b 0

:ensure_ubuntu
set "UBUNTU_READY=1"
set "NEEDS_FIRST_RUN=0"
set "UBUNTU_DISTRO="

for /f "usebackq delims=" %%D in (`wsl -l -q 2^>nul`) do (
  echo %%D | findstr /I "^Ubuntu" >nul
  if !errorlevel! == 0 if not defined UBUNTU_DISTRO set "UBUNTU_DISTRO=%%D"
)

if not defined UBUNTU_DISTRO (
  echo Installing Ubuntu...
  wsl --install -d Ubuntu
  if %errorlevel% neq 0 (
    echo ERROR: Ubuntu install did not start.
    echo Re-run install.bat or ensure WSL is updated.
    set "UBUNTU_READY=0"
    exit /b 1
  )
  set "NEEDS_FIRST_RUN=1"
  set "UBUNTU_DISTRO=Ubuntu"
) else (
  echo Found %UBUNTU_DISTRO%.
)

if "%NEEDS_FIRST_RUN%"=="1" (
  echo.
  echo Launching Ubuntu for first-time setup.
  echo Complete username/password, then type "exit" to continue.
  wsl -d "%UBUNTU_DISTRO%"
)

wsl -d "%UBUNTU_DISTRO%" -- bash -lc "id -u" >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo Ubuntu setup is not complete yet.
  echo Open Ubuntu from the Start Menu, finish setup, then re-run install.bat.
  set "UBUNTU_READY=0"
  exit /b 1
)

wsl --set-version "%UBUNTU_DISTRO%" 2 >nul 2>&1
exit /b 0

:enable_systemd
for /f "usebackq delims=" %%A in (`wsl -d "%UBUNTU_DISTRO%" -- bash -lc "if grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then echo 1; else echo 0; fi"`) do set "SYSTEMD_ENABLED=%%A"

if "%SYSTEMD_ENABLED%"=="0" (
  echo Enabling systemd in WSL...
  wsl -d "%UBUNTU_DISTRO%" -- bash -lc "printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf >/dev/null"
  if %errorlevel% neq 0 (
    echo ERROR: Failed to enable systemd.
    exit /b 1
  )
  wsl --shutdown
) else (
  echo systemd already enabled.
)

exit /b 0

:check_clawdbot
set "SKIP_INSTALL=0"
wsl -d "%UBUNTU_DISTRO%" -- bash -lc "command -v clawdbot >/dev/null 2>&1"
if %errorlevel%==0 (
  echo clawdbot already installed in WSL.
  set "SKIP_INSTALL=1"
)
exit /b 0

:install_stack
echo Installing Node.js 22, pnpm, and clawdbot...

wsl -d "%UBUNTU_DISTRO%" -- bash -lc "set -e; sudo apt-get update; sudo apt-get install -y curl ca-certificates gnupg; curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -; sudo apt-get install -y nodejs; sudo npm install -g pnpm; sudo npm install -g clawdbot"
if %errorlevel% neq 0 (
  echo ERROR: Failed to install Node.js or clawdbot inside WSL.
  exit /b 1
)

exit /b 0

:schedule_runonce
set "NEXT_STAGE=%~1"
reg add "HKLM\Software\Microsoft\Windows\CurrentVersion\RunOnce" /v ClawdbotInstaller /t REG_SZ /d "\"%SELF%\" --stage %NEXT_STAGE%" /f >nul
exit /b 0

:reboot
echo %~1
shutdown /r /t 5
exit /b 0

:final_message
echo.
echo Done.
echo Open Ubuntu (WSL) and run:
echo   clawdbot onboard
echo.
exit /b 0
