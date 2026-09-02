$ErrorActionPreference = 'Stop'

$stateDir = 'C:\FlowWorkerUpdater'
$updater = Join-Path $stateDir 'update-extension.ps1'
$service = Join-Path $stateDir 'update-service.ps1'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

Invoke-WebRequest 'https://raw.githubusercontent.com/nhannguyenalien/automation/main/vm-setup/update-extension.ps1' -OutFile $updater
Invoke-WebRequest 'https://raw.githubusercontent.com/nhannguyenalien/automation/main/vm-setup/update-service.ps1' -OutFile $service

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $updater"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName 'FlowWorker Auto Update' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

$serviceAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $service"
$serviceTrigger = New-ScheduledTaskTrigger -AtStartup
$serviceSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'FlowWorker Update Service' -Action $serviceAction -Trigger $serviceTrigger -Settings $serviceSettings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updater
Start-ScheduledTask -TaskName 'FlowWorker Update Service'

# One-time bootstrap: the currently loaded unpacked extension may still be an
# older version that does not know how to contact the local update service.
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$chromeArgs = @(
    '--user-data-dir=C:\ChromeProfile'
    '--load-extension=C:\Automation\flow-extension'
    '--no-first-run'
    '--no-default-browser-check'
    'https://gemini.google.com/app'
)
Start-Process -FilePath $chrome -ArgumentList $chromeArgs
