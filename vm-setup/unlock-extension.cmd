@echo off
reg delete "HKLM\SOFTWARE\Policies\Google\Chrome" /v ExtensionDeveloperModeSettings /f
icacls "C:\Automation" /grant Worker:(OI)(CI)F /T
taskkill /F /IM chrome.exe
start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\ChromeProfile" chrome://extensions
