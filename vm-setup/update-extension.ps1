$ErrorActionPreference = 'Stop'

$repo = 'nhannguyenalien/automation'
$branch = 'main'
$installDir = 'C:\Automation'
$extensionDir = Join-Path $installDir 'flow-extension'
$stateDir = 'C:\FlowWorkerUpdater'
$commitFile = Join-Path $stateDir 'installed-commit.txt'
$logFile = Join-Path $stateDir 'update.log'
$statusFile = Join-Path $stateDir 'status.json'
$flowProjectUrl = 'https://labs.google/fx/vi/tools/flow/project/75580504-a36e-453d-8da7-089e73b3508e'

function Restart-FlowApi {
    [Environment]::SetEnvironmentVariable('FLOW_PROJECT_URL', $flowProjectUrl, 'User')
    $env:FLOW_PROJECT_URL = $flowProjectUrl
    Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'C:\Automation\vm-setup\start-api.cmd' -WindowStyle Minimized
}

function Test-FlowApiHealthy {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:8787/health'
        return $response.StatusCode -eq 200
    }
    catch {
        return $false
    }
}

function Write-UpdateStatus($ok, $version, $sha, $updated, $errorMessage = '') {
    @{
        ok = [bool]$ok
        version = [string]$version
        sha = [string]$sha
        updated = [bool]$updated
        error = [string]$errorMessage
        checkedAt = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -Path $statusFile -Encoding UTF8
}

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
        $version = (Get-Content (Join-Path $extensionDir 'manifest.json') -Raw | ConvertFrom-Json).version
        # This task runs every five minutes. Restarting a healthy API here
        # interrupts long image/video jobs and makes Tailscale Funnel return
        # HTTP 502 while clients poll /jobs/:id.
        if (-not (Test-FlowApiHealthy)) {
            Restart-FlowApi
            Write-Output 'API was unhealthy and has been restarted.'
        }
        Write-UpdateStatus $true $version $remoteSha $false
        Write-Output "Already current: $remoteSha"
        return
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
        # Refresh the maintenance scripts too, so future fixes do not require
        # reinstalling the updater manually.
        Copy-Item (Join-Path $installDir 'vm-setup\update-extension.ps1') (Join-Path $stateDir 'update-extension.ps1') -Force
        Copy-Item (Join-Path $installDir 'vm-setup\update-service.ps1') (Join-Path $stateDir 'update-service.ps1') -Force
        Set-Content -Path $commitFile -Value $remoteSha -Encoding ASCII
        $version = (Get-Content (Join-Path $extensionDir 'manifest.json') -Raw | ConvertFrom-Json).version
        Restart-FlowApi
        Write-UpdateStatus $true $version $remoteSha $true
        Write-Output "Updated to $remoteSha (extension v$version)"
    }
    finally {
        Remove-Item $workDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
catch {
    Write-UpdateStatus $false '' '' $false $_.Exception.Message
    Write-Error $_
}
finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
}
