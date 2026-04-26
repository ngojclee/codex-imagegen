param(
    [string]$ShortcutName = "Codex ImageGen.lnk"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ShortcutPath = Join-Path $ProjectRoot $ShortcutName
$LauncherPath = Join-Path $ProjectRoot "run_app.bat"
$IconPath = Join-Path $ProjectRoot "icon.ico"

if (-not (Test-Path -LiteralPath $LauncherPath)) {
    throw "Launcher not found: $LauncherPath"
}

if (-not (Test-Path -LiteralPath $IconPath)) {
    throw "Icon not found: $IconPath"
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "$env:ComSpec"
$Shortcut.Arguments = '/c "' + $LauncherPath + '"'
$Shortcut.WorkingDirectory = $ProjectRoot

# Keep the icon path relative so the shortcut can follow this folder.
$Shortcut.IconLocation = "icon.ico,0"
$Shortcut.WindowStyle = 7
$Shortcut.Description = "Start Codex ImageGen Proxy"
$Shortcut.Save()

Write-Host "Shortcut updated: $ShortcutPath"
