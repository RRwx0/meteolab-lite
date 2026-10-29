param(
    [ValidateSet('start', 'stop', 'status', 'autostart-on', 'autostart-off')]
    [string]$Action = 'start',
    [int]$Port = 0,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Port -le 0) {
    if ($env:WTS_PORT) { $Port = [int]$env:WTS_PORT } else { $Port = 8770 }
}
$url = "http://127.0.0.1:$Port/"
$health = "$url" + "api/wts/health"
$startupName = 'MeteoLab WtS.lnk'

function Get-PythonPath {
    foreach ($name in @('python', 'python3', 'py')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    return $null
}

function Test-Wts {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $health
        return ($response.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Wait-Wts([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Wts) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return (Test-Wts)
}

function Get-WorkingProcess {
    try {
        $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
        if ($connection) { return Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue }
    } catch {
        return $null
    }
    return $null
}

function Start-Wts {
    if (Test-Wts) {
        if (-not $NoBrowser) { Start-Process $url }
        return 0
    }
    $python = Get-PythonPath
    if (-not $python) {
        Write-Host 'Python не найден. Установите Python 3.9+ и повторите запуск.' -ForegroundColor Red
        return 2
    }
    $command = '"{0}" -m wts --port {1}' -f $python, $Port
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $command -WorkingDirectory $root -WindowStyle Hidden | Out-Null

    if (Wait-Wts 20) {
        if (-not $NoBrowser) { Start-Process $url }
        return 0
    }

    Write-Host 'Сервер не поднялся за 20 секунд. Открываю окно с выводом Python.' -ForegroundColor Yellow
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $command -WorkingDirectory $root
    return 1
}

function Stop-Wts {
    $process = Get-WorkingProcess
    if (-not $process) {
        Write-Host 'WtS уже остановлен.' -ForegroundColor Yellow
        return 0
    }
    Stop-Process -Id $process.Id -Force
    Write-Host ("WtS остановлен (PID {0})." -f $process.Id)
    return 0
}

function Show-Status {
    if (Test-Wts) {
        $info = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $health
        Write-Host ("WtS работает: {0}" -f $url) -ForegroundColor Green
        Write-Host $info.Content
        $process = Get-WorkingProcess
        if ($process) { Write-Host ("PID {0}, {1}" -f $process.Id, $process.ProcessName) }
        return 0
    }
    Write-Host ("WtS не запущен. Порт {0} свободен." -f $Port) -ForegroundColor Yellow
    return 1
}

function Set-Autostart([bool]$enable) {
    $startup = [Environment]::GetFolderPath('Startup')
    $shortcutPath = Join-Path $startup $startupName
    if (-not $enable) {
        if (Test-Path -LiteralPath $shortcutPath) {
            Remove-Item -LiteralPath $shortcutPath -Force
            Write-Host 'Автозапуск WtS выключен.' -ForegroundColor Yellow
        } else {
            Write-Host 'Автозапуск WtS уже выключен.' -ForegroundColor Yellow
        }
        return 0
    }
    $python = Get-PythonPath
    if (-not $python) {
        Write-Host 'Python не найден — автозапуск не настроен.' -ForegroundColor Red
        return 2
    }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $script = Join-Path $root 'wts-service.ps1'
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Action start -NoBrowser' -f $script
    $shortcut.WorkingDirectory = $root
    $shortcut.WindowStyle = 7
    $shortcut.Description = 'MeteoLab Lite: сервер массовой загрузки зондов WtS'
    $shortcut.Save()
    Write-Host ("Автозапуск WtS включён: {0}" -f $shortcutPath) -ForegroundColor Green
    return 0
}

switch ($Action) {
    'start' { exit (Start-Wts) }
    'stop' { exit (Stop-Wts) }
    'status' { exit (Show-Status) }
    'autostart-on' { exit (Set-Autostart $true) }
    'autostart-off' { exit (Set-Autostart $false) }
}
