$ErrorActionPreference = 'Stop'

$chrome = 'C:\ChromeForTesting\chrome-win64\chrome.exe'
$profile = 'C:\ChromeProfile'
$extension = 'C:\Automation\flow-extension'

if (-not (Test-Path $chrome)) { throw "Chrome for Testing not found: $chrome" }
if (-not (Test-Path (Join-Path $extension 'manifest.json'))) { throw "Extension not found: $extension" }

# Let the API finish its HTTP response before the browser connection drops.
& "$env:SystemRoot\System32\taskkill.exe" /F /T /IM chrome.exe 2>$null | Out-Null
Start-Sleep -Seconds 3
$remaining = Get-Process -Name chrome -ErrorAction SilentlyContinue
if ($remaining) { throw "Could not stop $(@($remaining).Count) existing Chrome process(es)" }
Start-Process -FilePath $chrome -ArgumentList @(
    "--user-data-dir=$profile"
    "--load-extension=$extension"
    '--no-first-run'
    '--no-default-browser-check'
    'https://gemini.google.com/app'
)
Write-Output 'Chrome browser worker restarted and extension files will be reloaded.'
