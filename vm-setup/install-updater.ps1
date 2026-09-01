$ErrorActionPreference = 'Stop'

$stateDir = 'C:\FlowWorkerUpdater'
$updater = Join-Path $stateDir 'update-extension.ps1'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

Invoke-WebRequest 'https://raw.githubusercontent.com/nhannguyenalien/automation/main/vm-setup/update-extension.ps1' -OutFile $updater

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File $updater"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName 'FlowWorker Auto Update' -Action $action -Trigger $trigger -Settings $settings -User $env:USERNAME -RunLevel Highest -Force | Out-Null

& $updater
