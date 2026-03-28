@echo off
echo Installing DD-Dad Launcher...
cd /d "%~dp0"
npm install
npx playwright install chromium
echo.
echo Setup complete! Run "npm start" to start the launcher.
pause
