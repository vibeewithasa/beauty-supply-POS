@echo off
rem Estetica Leal POS - doble clic para preparar la base de demostracion en esta laptop (ver LEEME.txt).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Preparar-Base-Demo.ps1" %*
exit /b %ERRORLEVEL%
