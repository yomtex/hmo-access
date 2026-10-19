@echo off
rem HMO Access command menu for Windows (PowerShell or Command Prompt).
rem   .\hmo            interactive menu
rem   .\hmo update     run one command (.\hmo help lists them)
rem Runs hmo.sh with Git Bash (installed with Git for Windows). WSL's bash is not used on purpose:
rem it can't see your Windows Node.js or the Docker database the same way.
setlocal
set "GITBASH="
if exist "%ProgramFiles%\Git\bin\bash.exe" set "GITBASH=%ProgramFiles%\Git\bin\bash.exe"
if not defined GITBASH if exist "%ProgramFiles(x86)%\Git\bin\bash.exe" set "GITBASH=%ProgramFiles(x86)%\Git\bin\bash.exe"
if not defined GITBASH if exist "%LocalAppData%\Programs\Git\bin\bash.exe" set "GITBASH=%LocalAppData%\Programs\Git\bin\bash.exe"
if not defined GITBASH for /f "delims=" %%G in ('where git 2^>nul') do if not defined GITBASH if exist "%%~dpG..\bin\bash.exe" set "GITBASH=%%~dpG..\bin\bash.exe"
if not defined GITBASH (
  echo Git Bash was not found. Install Git for Windows from https://git-scm.com/download/win
  echo Meanwhile the plain commands work in PowerShell, e.g.:  npm run db:migrate   npm run dev
  exit /b 1
)
"%GITBASH%" "%~dp0hmo.sh" %*
exit /b %ERRORLEVEL%
