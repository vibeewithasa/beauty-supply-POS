@echo off
rem Scheduled backup wrapper for Windows Task Scheduler (see docs/OPERATIONS.md).
rem Reads DATABASE_URL from the project's .env (or the environment), writes a verified backup to POS_BACKUP_DIR
rem (default %USERPROFILE%\Backups\beauty-pos), keeps the newest 14 and logs the result to task.log in that folder.
setlocal
cd /d "%~dp0.."
if "%POS_BACKUP_DIR%"=="" set "POS_BACKUP_DIR=%USERPROFILE%\Backups\beauty-pos"
if not exist "%POS_BACKUP_DIR%" mkdir "%POS_BACKUP_DIR%"
rem Optional second location (external drive...): set POS_BACKUP_SECOND_DIR; the script copies and verifies there, never overwrites.
node scripts\db-backup.mjs --label diario --keep 14 >> "%POS_BACKUP_DIR%\task.log" 2>&1
exit /b %ERRORLEVEL%
