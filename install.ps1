# Installs Better Clips for OBS on Windows and connects it to your clips app.
# Copy the command from your app (Settings > OBS), or run in PowerShell:
#
#   $env:CLIPS_SETUP_CODE='<setup code>'; irm https://raw.githubusercontent.com/aarsh21/better-clips/main/install.ps1 | iex
#
# Without a setup code it only installs the plugin. Windows asks once for
# permission, because OBS loads plugins from C:\ProgramData.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is much faster without it
# Windows PowerShell 5.1 may not offer TLS 1.2 to GitHub by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072

$Repo = 'aarsh21/better-clips'
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

$Temp = Join-Path ([IO.Path]::GetTempPath()) ("better-clips-" + [Guid]::NewGuid())
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
        $Asset = "better-clips-$Version-windows-x64.zip"
        Say "Downloading Better Clips $Version..."
        $Zip = Join-Path $Temp $Asset
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/releases/download/$Version/$Asset" -OutFile $Zip
    }

    # Unpack here first, then copy, so the elevated step is one short command.
    $Unpacked = Join-Path $Temp 'unpacked'
    Expand-Archive -Path $Zip -DestinationPath $Unpacked -Force
    $Source = Join-Path $Unpacked 'better-clips'
    if (-not (Test-Path (Join-Path $Source 'bin\64bit\better-clips.dll'))) { Fail 'The download has no plugin in it.' }

    $Plugins = Join-Path $env:ProgramData 'obs-studio\plugins'
    $Plugin = Join-Path $Plugins 'better-clips'
    $ObsDir = (Get-ItemProperty -ErrorAction SilentlyContinue -Path 'HKLM:\SOFTWARE\OBS Studio').'(default)'
    if (-not $ObsDir) { $ObsDir = Join-Path $env:ProgramFiles 'obs-studio' }
    if (-not [Environment]::Is64BitProcess) { Fail 'Run the installer in 64-bit PowerShell.' }
    # Resolve the module against the installed OBS runtime before requesting elevation.
    if (-not ('Native.BetterClipsLoader' -as [type])) {
        Add-Type -Name BetterClipsLoader -Namespace Native -MemberDefinition @'
[DllImport("kernel32", CharSet=CharSet.Unicode, ExactSpelling=true)] public static extern IntPtr AddDllDirectory(string path);
[DllImport("kernel32")] public static extern bool RemoveDllDirectory(IntPtr cookie);
[DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
[DllImport("kernel32", CharSet=CharSet.Ansi, ExactSpelling=true)] public static extern IntPtr GetProcAddress(IntPtr module, string name);
[DllImport("kernel32")] public static extern bool FreeLibrary(IntPtr module);
'@
    }
    $Dll = Join-Path $Source 'bin\64bit\better-clips.dll'
    $Cookie = [Native.BetterClipsLoader]::AddDllDirectory((Join-Path $ObsDir 'bin\64bit'))
    try {
        $Module = [Native.BetterClipsLoader]::LoadLibraryEx($Dll, [IntPtr]::Zero, 0xD00)
        if ($Module -eq [IntPtr]::Zero) { Fail 'The new plugin or one of its OBS dependencies could not be loaded. Check your OBS installation.' }
        try {
            if ([Native.BetterClipsLoader]::GetProcAddress($Module, 'obs_module_load') -eq [IntPtr]::Zero) { Fail 'Not an OBS plugin.' }
        } finally { [void][Native.BetterClipsLoader]::FreeLibrary($Module) }
    } finally { if ($Cookie -ne [IntPtr]::Zero) { [void][Native.BetterClipsLoader]::RemoveDllDirectory($Cookie) } }
    $Hash = (Get-FileHash -LiteralPath $Dll).Hash
    Say 'Installing the plugin...'
    function Quote($Path) { "'" + $Path.Replace("'", "''") + "'" }
    $Swap = {
        param($Plugins, $Source, $Hash)
        $ErrorActionPreference = 'Stop'
        $Plugin = Join-Path $Plugins 'better-clips'
        $Backups = Join-Path (Split-Path $Plugins) 'plugin-backups'
        $Backup = Join-Path $Backups 'better-clips'
        $Stage = Join-Path $Backups ([Guid]::NewGuid().ToString())
        New-Item -ItemType Directory -Force -Path $Plugins, $Backups | Out-Null
        try {
            Copy-Item -LiteralPath $Source -Recurse -Destination $Stage
            if ((Get-FileHash -LiteralPath (Join-Path $Stage 'bin\64bit\better-clips.dll')).Hash -ne $Hash -or
                !(Test-Path -LiteralPath (Join-Path $Stage 'data\locale\en-US.ini') -PathType Leaf)) { throw 'Incomplete plugin copy.' }
            if (Test-Path -LiteralPath $Plugin) {
                if (Test-Path -LiteralPath $Backup) { Remove-Item -LiteralPath $Backup -Recurse -Force }
                Move-Item -LiteralPath $Plugin -Destination $Backup
            }
            try { Move-Item -LiteralPath $Stage -Destination $Plugin } catch {
                if (Test-Path -LiteralPath $Backup) { Move-Item -LiteralPath $Backup -Destination $Plugin }
                throw
            }
        } finally { if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force } }
    }
    $Copy = "`$ErrorActionPreference = 'Stop'; & { $Swap } $(Quote $Plugins) $(Quote $Source) $(Quote $Hash)"
    foreach ($Old in @((Join-Path $Plugins 'obs-replay-r2'),
                       (Join-Path $ObsDir 'obs-plugins\64bit\obs-replay-r2.dll'),
                       (Join-Path $ObsDir 'data\obs-plugins\obs-replay-r2'))) {
        $Copy += "; if (Test-Path -LiteralPath $(Quote $Old)) { Remove-Item -LiteralPath $(Quote $Old) -Recurse -Force }"
    }
    $Admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).
        IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($Admin) {
        Invoke-Expression $Copy
    } else {
        $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Copy))
        try {
            $Process = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden `
                -ArgumentList '-NoProfile', '-EncodedCommand', $Encoded
        } catch [System.ComponentModel.Win32Exception] {
            if ($_.Exception.NativeErrorCode -eq 1223) { Fail 'Installation cancelled at the Windows permission prompt.' }
            throw
        }
        if ($Process.ExitCode -ne 0) { Fail 'The elevated plugin copy, validation or cleanup failed.' }
    }
    if (-not (Test-Path (Join-Path $Plugin 'bin\64bit\better-clips.dll'))) { Fail "The plugin wasn't installed to $Plugin." }
    $Old = Join-Path $env:APPDATA 'obs-studio\plugins\obs-replay-r2'
    if (Test-Path -LiteralPath $Old) { Remove-Item -LiteralPath $Old -Recurse -Force }

    if ($Code) {
        # The plugin reads this on OBS's next start, then deletes it.
        $Config = Join-Path $env:APPDATA 'obs-studio\plugin_config\better-clips'
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
    Say 'In OBS, open Tools > Better Clips Settings and paste the setup code from your clips app.'
}

# Open OBS. It must start from its own folder to find its files.
$ObsBin = Join-Path $ObsDir 'bin\64bit'
if (Test-Path (Join-Path $ObsBin 'obs64.exe')) {
    Start-Process -FilePath (Join-Path $ObsBin 'obs64.exe') -WorkingDirectory $ObsBin
} else {
    Say 'Open OBS to finish.'
}
