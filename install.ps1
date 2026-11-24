# Installs Replay to R2 for OBS on Windows and connects it to your clips app.
# Copy the command from your app (Settings > OBS), or run in PowerShell:
#
#   $env:CLIPS_SETUP_CODE='<setup code>'; irm https://raw.githubusercontent.com/aarsh21/obs-replay-r2/main/install.ps1 | iex
#
# Without a setup code it only installs the plugin. Windows asks once for
# permission, because OBS loads plugins from C:\ProgramData.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is much faster without it
# Windows PowerShell 5.1 may not offer TLS 1.2 to GitHub by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

$Repo = 'aarsh21/obs-replay-r2'
$Code = "$env:CLIPS_SETUP_CODE".Trim()
Remove-Item Env:CLIPS_SETUP_CODE -ErrorAction SilentlyContinue

function Say($Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail($Text) { Write-Host "Error: $Text" -ForegroundColor Red; throw $Text }

if ($Code -and $Code -notmatch '^r2obs[12]:') {
    Fail "That doesn't look like a setup code. Copy it again from Settings > OBS in your clips app."
}
if (-not [Environment]::Is64BitOperatingSystem) { Fail 'Only 64-bit Windows is supported.' }

# The plugin replaces files OBS has open, so OBS must be closed.
if (Get-Process obs64 -ErrorAction SilentlyContinue) {
    Say 'Close OBS to continue. Waiting for it to quit...'
    while (Get-Process obs64 -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }
}

$Temp = Join-Path ([IO.Path]::GetTempPath()) ("obs-replay-r2-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $Temp | Out-Null
try {
    # OBS_R2_PACKAGE installs a local zip instead, for testing.
    if ($env:OBS_R2_PACKAGE) {
        $Zip = $env:OBS_R2_PACKAGE
    } else {
        # /releases/latest redirects to /releases/tag/<version>. The GitHub API
        # would say the same, but it is rate limited.
        $Request = [Net.WebRequest]::Create("https://github.com/$Repo/releases/latest")
        $Request.Method = 'HEAD'
        $Response = $Request.GetResponse()
        $Version = $Response.ResponseUri.AbsolutePath.Split('/')[-1]
        $Response.Close()
        $Asset = "obs-replay-r2-$Version-windows-x64.zip"
        Say "Downloading Replay to R2 $Version..."
        $Zip = Join-Path $Temp $Asset
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/releases/download/$Version/$Asset" -OutFile $Zip
    }

    # Unpack here first, then copy, so the elevated step is one short command.
    $Unpacked = Join-Path $Temp 'unpacked'
    Expand-Archive -Path $Zip -DestinationPath $Unpacked -Force
    $Source = Join-Path $Unpacked 'obs-replay-r2'
    if (-not (Test-Path (Join-Path $Source 'bin\64bit\obs-replay-r2.dll'))) { Fail 'The download has no plugin in it.' }

    $Plugins = Join-Path $env:ProgramData 'obs-studio\plugins'
    $Plugin = Join-Path $Plugins 'obs-replay-r2'
    Say 'Installing the plugin...'
    function Quote($Path) { "'" + $Path.Replace("'", "''") + "'" }
    $Copy = "New-Item -ItemType Directory -Force -Path $(Quote $Plugins) | Out-Null; " +
        "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -Path $(Quote $Plugin); " +
        "Copy-Item -Recurse -Force -Path $(Quote $Source) -Destination $(Quote $Plugins)"
    $Admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
        IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($Admin) {
        Invoke-Expression $Copy
    } else {
        $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Copy))
        try {
            Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden `
                -ArgumentList '-NoProfile', '-EncodedCommand', $Encoded
        } catch {
            Fail 'Windows did not allow installing to C:\ProgramData. Run the command again and click Yes.'
        }
    }
    if (-not (Test-Path (Join-Path $Plugin 'bin\64bit\obs-replay-r2.dll'))) { Fail "The plugin wasn't installed to $Plugin." }

    if ($Code) {
        # The plugin reads this on OBS's next start, then deletes it.
        $Config = Join-Path $env:APPDATA 'obs-studio\plugin_config\obs-replay-r2'
        New-Item -ItemType Directory -Force -Path $Config | Out-Null
        [IO.File]::WriteAllText((Join-Path $Config 'setup-code.txt'), $Code)
    }
} finally {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue -Path $Temp
}

Say "Installed to $Plugin"
if ($Code) {
    Say 'When OBS opens, it connects to your clips app and starts the Replay Buffer.'
    Say 'Press Ctrl+Alt+R to save a replay (change it in Settings > Hotkeys).'
} else {
    Say 'In OBS, open Tools > Replay to R2 Settings and paste the setup code from your clips app.'
}

# Open OBS. It must start from its own folder to find its files.
$ObsDir = (Get-ItemProperty -ErrorAction SilentlyContinue -Path 'HKLM:\SOFTWARE\OBS Studio').'(default)'
if (-not $ObsDir) { $ObsDir = Join-Path $env:ProgramFiles 'obs-studio' }
$ObsBin = Join-Path $ObsDir 'bin\64bit'
if (Test-Path (Join-Path $ObsBin 'obs64.exe')) {
    Start-Process -FilePath (Join-Path $ObsBin 'obs64.exe') -WorkingDirectory $ObsBin
} else {
    Say 'Open OBS to finish.'
}
