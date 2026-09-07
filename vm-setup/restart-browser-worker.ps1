$ErrorActionPreference = 'Stop'

$chrome = 'C:\ChromeForTesting\chrome-win64\chrome.exe'
$profile = 'C:\ChromeProfile'
$extension = 'C:\Automation\flow-extension'

if (-not (Test-Path $chrome)) { throw "Chrome for Testing not found: $chrome" }
if (-not (Test-Path (Join-Path $extension 'manifest.json'))) { throw "Extension not found: $extension" }

# Let the API finish its HTTP response before the browser connection drops.
Start-Sleep -Seconds 2
Get-Process -Name chrome -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Start-Process -FilePath $chrome -ArgumentList @(
    "--user-data-dir=$profile"
    "--load-extension=$extension"
    '--no-first-run'
    '--no-default-browser-check'
    'https://gemini.google.com/app'
)
