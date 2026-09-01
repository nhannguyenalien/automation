$ErrorActionPreference = 'Stop'

$repo = 'nhannguyenalien/automation'
$branch = 'main'
$installDir = 'C:\Automation'
$extensionDir = Join-Path $installDir 'flow-extension'
$stateDir = 'C:\FlowWorkerUpdater'
$commitFile = Join-Path $stateDir 'installed-commit.txt'
$logFile = Join-Path $stateDir 'update.log'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$chromeArgs = @(
    '--user-data-dir=C:\ChromeProfile'
    '--load-extension=C:\Automation\flow-extension'
    '--no-first-run'
    '--no-default-browser-check'
    'https://gemini.google.com/app'
)

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Start-Transcript -Path $logFile -Append | Out-Null

try {
    $headers = @{
        Accept = 'application/vnd.github+json'
        'User-Agent' = 'FlowWorker-Windows-Updater'
    }
    $commit = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$repo/commits/$branch"
    $remoteSha = [string]$commit.sha
    $installedSha = if (Test-Path $commitFile) { (Get-Content $commitFile -Raw).Trim() } else { '' }

    if ($remoteSha -and $remoteSha -eq $installedSha -and (Test-Path $extensionDir)) {
        Write-Output "Already current: $remoteSha"
        exit 0
    }

    $workDir = Join-Path $env:TEMP ("flow-worker-update-" + [guid]::NewGuid().ToString('N'))
    $zipFile = Join-Path $workDir 'automation.zip'
    $extractDir = Join-Path $workDir 'source'
    New-Item -ItemType Directory -Force -Path $extractDir | Out-Null

    try {
        Invoke-WebRequest "https://github.com/$repo/archive/$remoteSha.zip" -OutFile $zipFile
        Expand-Archive $zipFile $extractDir -Force
        $newSource = Get-ChildItem $extractDir -Directory | Select-Object -First 1
        if (-not $newSource -or -not (Test-Path (Join-Path $newSource.FullName 'flow-extension\manifest.json'))) {
            throw 'Downloaded repository does not contain flow-extension\manifest.json'
        }

        $runtimeConfig = Join-Path $extensionDir 'runtime-config.js'
        $savedRuntime = if (Test-Path $runtimeConfig) { Get-Content $runtimeConfig -Raw } else { $null }

        New-Item -ItemType Directory -Force -Path $installDir | Out-Null
        Copy-Item (Join-Path $newSource.FullName '*') $installDir -Recurse -Force
        if ($null -ne $savedRuntime) {
            Set-Content -Path $runtimeConfig -Value $savedRuntime -Encoding UTF8
        }
        Set-Content -Path $commitFile -Value $remoteSha -Encoding ASCII

        Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
        Start-Sleep -Seconds 2
        Start-Process -FilePath $chrome -ArgumentList $chromeArgs
        Write-Output "Updated to $remoteSha and restarted Chrome"
    }
    finally {
        Remove-Item $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
catch {
    Write-Error $_
    exit 1
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
