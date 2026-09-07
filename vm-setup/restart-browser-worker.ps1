$ErrorActionPreference = 'Stop'

$chrome = 'C:\ChromeForTesting\chrome-win64\chrome.exe'
$profile = 'C:\ChromeProfile'
$extension = 'C:\Automation\flow-extension'
$taskName = 'FlowWorker Browser'

if (-not (Test-Path $chrome)) { throw "Chrome for Testing not found: $chrome" }
if (-not (Test-Path (Join-Path $extension 'manifest.json'))) { throw "Extension not found: $extension" }

# Let the API finish its HTTP response before the browser connection drops.
& "$env:SystemRoot\System32\taskkill.exe" /F /T /IM chrome.exe 2>$null | Out-Null
Start-Sleep -Seconds 3
$remaining = Get-Process -Name chrome -ErrorAction SilentlyContinue
if ($remaining) { throw "Could not stop $(@($remaining).Count) existing Chrome process(es)" }

# The API and updater run as SYSTEM in session 0. A browser started there has
# no interactive desktop and Chrome for Testing can fail with a side-by-side
# startup error. Register the launch against the currently logged-on user so
# the worker always owns a visible, automation-capable browser session.
$interactiveUser = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $interactiveUser) { throw 'No interactive Windows user is logged on' }
$chromeArgs = @(
    "--user-data-dir=$profile"
    "--load-extension=$extension"
    '--no-first-run'
    '--no-default-browser-check'
    'https://gemini.google.com/app'
)
$action = New-ScheduledTaskAction -Execute $chrome -Argument ($chromeArgs -join ' ')
$principal = New-ScheduledTaskPrincipal -UserId $interactiveUser -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 7)
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$deadline = (Get-Date).AddSeconds(20)
do {
    Start-Sleep -Seconds 1
    $worker = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq 'chrome.exe' -and
            $_.CommandLine -match '--user-data-dir[=\"]+C:\\ChromeProfile'
        } |
        Select-Object -First 1
} while (-not $worker -and (Get-Date) -lt $deadline)

if (-not $worker) {
    $task = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    throw "Chrome did not start for $interactiveUser (scheduled task result: $($task.LastTaskResult))"
}
Write-Output "Chrome browser worker restarted for $interactiveUser and extension files will be reloaded."
