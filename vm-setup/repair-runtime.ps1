$ErrorActionPreference = 'Stop'

$installDir = 'C:\Automation'
$runtimeFile = Join-Path $installDir 'flow-extension\runtime-config.js'
$setupFile = Join-Path $installDir 'vm-setup\setup.cmd'

if (-not (Test-Path $setupFile)) {
    throw "Missing setup file: $setupFile"
}

$setup = Get-Content $setupFile -Raw
$apiKeyMatch = [regex]::Match($setup, 'apiKey: "([^"]+)"')
if (-not $apiKeyMatch.Success) {
    throw 'Could not recover the API key from setup.cmd'
}

$apiKey = $apiKeyMatch.Groups[1].Value
$runtime = @"
export const runtimeDefaults = {
  apiUrl: "https://flow-worker-win10.tail5d608a.ts.net",
  apiKey: "$apiKey",
  workerId: "proxmox-windows",
  enabled: true,
  force: true
};
"@

[IO.File]::WriteAllText($runtimeFile, $runtime, (New-Object Text.UTF8Encoding($false)))
Write-Output "Repaired $runtimeFile"
