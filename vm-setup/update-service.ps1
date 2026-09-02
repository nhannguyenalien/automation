$ErrorActionPreference = 'Continue'

$stateDir = 'C:\FlowWorkerUpdater'
$updater = Join-Path $stateDir 'update-extension.ps1'
$statusFile = Join-Path $stateDir 'status.json'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add('http://127.0.0.1:8765/')

function Read-UpdateStatus {
    if (Test-Path $statusFile) {
        try { return Get-Content $statusFile -Raw | ConvertFrom-Json } catch {}
    }
    return [pscustomobject]@{ ok = $false; error = 'Updater has not run yet' }
}

function Send-Json($context, $statusCode, $body) {
    $json = $body | ConvertTo-Json -Depth 5 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $context.Response.StatusCode = $statusCode
    $context.Response.ContentType = 'application/json; charset=utf-8'
    $context.Response.Headers['Access-Control-Allow-Origin'] = '*'
    $context.Response.Headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    $context.Response.Headers['Access-Control-Allow-Headers'] = 'content-type'
    $context.Response.ContentLength64 = $bytes.Length
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $context.Response.Close()
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Set-Content -Path (Join-Path $stateDir 'service.pid') -Value $PID -Encoding ASCII
$listener.Start()

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        if ($context.Request.HttpMethod -eq 'OPTIONS') {
            Send-Json $context 200 @{ ok = $true }
            continue
        }
        if ($context.Request.Url.AbsolutePath -eq '/status' -and $context.Request.HttpMethod -eq 'GET') {
            Send-Json $context 200 (Read-UpdateStatus)
            continue
        }
        if ($context.Request.Url.AbsolutePath -eq '/update' -and $context.Request.HttpMethod -eq 'POST') {
            & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $updater
            $result = Read-UpdateStatus
            Send-Json $context ($(if ($result.ok) { 200 } else { 500 })) $result
            continue
        }
        Send-Json $context 404 @{ ok = $false; error = 'Not found' }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
