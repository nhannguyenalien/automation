@echo off
setlocal
set "LOG=C:\flow-worker-setup.log"
echo [%date% %time%] Starting setup>"%LOG%"

if exist "%~dp0chrome-enterprise.msi" (
  copy /y "%~dp0chrome-enterprise.msi" "C:\Windows\Temp\chrome.msi" >>"%LOG%" 2>&1
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Invoke-WebRequest 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi' -OutFile 'C:\Windows\Temp\chrome.msi'" >>"%LOG%" 2>&1
)
start /wait msiexec.exe /i "C:\Windows\Temp\chrome.msi" /qn /norestart >>"%LOG%" 2>&1
echo Chrome installed>>"%LOG%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; Remove-Item 'C:\Automation' -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item 'C:\Windows\Temp\automation.zip' -Force -ErrorAction SilentlyContinue; Invoke-WebRequest 'https://github.com/nhannguyenalien/automation/archive/refs/heads/main.zip' -OutFile 'C:\Windows\Temp\automation.zip'; Expand-Archive 'C:\Windows\Temp\automation.zip' 'C:\Windows\Temp\automation-src' -Force; Move-Item 'C:\Windows\Temp\automation-src\automation-main' 'C:\Automation' -Force; Set-Content -Encoding UTF8 'C:\Automation\flow-extension\runtime-config.js' 'export const runtimeDefaults = { apiUrl: "https://api-automation.toidayhoc.com", apiKey: "AJmzWcG3P5ZV97xjDl1vc7xOJCXM_keN", workerId: "proxmox-windows", enabled: true, force: true };'; Write-Output 'Extension installed'" >>"%LOG%" 2>&1

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force 'C:\FlowWorkerUpdater' | Out-Null; Copy-Item 'C:\Automation\vm-setup\update-extension.ps1' 'C:\FlowWorkerUpdater\update-extension.ps1' -Force; $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\FlowWorkerUpdater\update-extension.ps1'; $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5); $settings=New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries; Register-ScheduledTask -TaskName 'FlowWorker Auto Update' -Action $action -Trigger $trigger -Settings $settings -User $env:USERNAME -RunLevel Highest -Force | Out-Null; Write-Output 'Auto updater scheduled every 5 minutes'" >>"%LOG%" 2>&1

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $chrome='C:\Program Files\Google\Chrome\Application\chrome.exe'; $args='--user-data-dir=C:\ChromeProfile --load-extension=C:\Automation\flow-extension --no-first-run --no-default-browser-check https://gemini.google.com/app'; $ws=New-Object -ComObject WScript.Shell; foreach($path in @($ws.SpecialFolders('Desktop')+'\Flow Worker.lnk',$ws.SpecialFolders('Startup')+'\Flow Worker.lnk')){$s=$ws.CreateShortcut($path);$s.TargetPath=$chrome;$s.Arguments=$args;$s.WorkingDirectory='C:\Automation';$s.Save()}; Write-Output 'Shortcuts created'" >>"%LOG%" 2>&1

echo [%date% %time%] Setup complete>>"%LOG%"
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --user-data-dir="C:\ChromeProfile" --load-extension="C:\Automation\flow-extension" --no-first-run --no-default-browser-check https://gemini.google.com/app
endlocal
