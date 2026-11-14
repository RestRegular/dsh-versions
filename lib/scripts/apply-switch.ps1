# Close the running DSH, install the requested version silently, relaunch it.
#
# All parameters live in switch-request.json next to this script, so nothing has
# to be interpolated into a PowerShell command line.
param(
  [Parameter(Mandatory = $true)][string]$RequestPath
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$req = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$logPath = $req.logPath

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string]$message) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $message
  # Append without a BOM so the log parses as plain UTF-8 on the Node side.
  try { [System.IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, $utf8NoBom) } catch { }
}

# The path sweep below is only safe for a *narrow* install directory. If the
# reported install dir is a system/root directory (bad detection, bad config),
# sweeping it would kill unrelated processes, so refuse to sweep at all.
function Test-SweepablePrefix([string]$prefix) {
  if ([string]::IsNullOrWhiteSpace($prefix)) { return $false }
  $normalized = $prefix.TrimEnd('\')
  if ($normalized.Length -lt 4) { return $false }
  # A bare drive root such as C: is never an app install directory.
  if ($normalized -match '^[A-Za-z]:$') { return $false }
  $guarded = @($env:SystemRoot, $env:ProgramFiles, $env:ProgramData, $env:USERPROFILE)
  foreach ($g in $guarded) {
    if ([string]::IsNullOrWhiteSpace($g)) { continue }
    $root = $g.TrimEnd('\')
    # Same directory, or a subdirectory of it (C:\Windows\System32, C:\Program Files\...).
    if ($normalized.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    if ($normalized.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    # Or an ancestor of it (C:\Windows' parent, a whole drive).
    if ($root.StartsWith($normalized + '\', [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  return $true
}

# Every process of this app: matched by image name, plus anything whose executable
# lives under the install directory (host children, helper processes).
function Get-AppProcesses {
  $found = @()
  foreach ($p in @(Get-Process -Name $req.exeName -ErrorAction SilentlyContinue)) {
    $found += $p
  }
  if (-not (Test-SweepablePrefix $req.installDirPrefix)) { return $found }
  foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
    try {
      if ($p.Path -and $p.Path.StartsWith($req.installDirPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        $hit = $false
        foreach ($f in $found) { if ($f.Id -eq $p.Id) { $hit = $true } }
        if (-not $hit) { $found += $p }
      }
    } catch { }
  }
  return $found
}

Write-Log ('worker started pid=' + $PID + ' version=' + $req.version)

if ($req.dryRun) {
  $probe = @(Get-AppProcesses)
  Write-Log ('dry run: would close ' + $probe.Count + ' process(es) of ' + $req.exeName)
  Write-Log ('dry run: would run ' + $req.installerPath + ' /S /currentuser /D=' + $req.installDir)
  Write-Log 'dry run: done'
  exit 0
}

# Let the HTTP response and the panel notice land before the window disappears.
Start-Sleep -Milliseconds 1500

$procs = @(Get-AppProcesses)
Write-Log ('closing ' + $procs.Count + ' process(es) of ' + $req.exeName)
foreach ($p in $procs) {
  try { $null = $p.CloseMainWindow() } catch { }
}

$deadline = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $deadline) {
  if (@(Get-AppProcesses).Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
}

$left = @(Get-AppProcesses)
if ($left.Count -gt 0) {
  Write-Log ('force stopping ' + $left.Count + ' process(es)')
  foreach ($p in $left) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
  }
}

# Wait until the executable is actually unlocked before handing it to the installer.
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
  if (@(Get-AppProcesses).Count -eq 0) { break }
  Start-Sleep -Milliseconds 300
}
Start-Sleep -Milliseconds 800
Write-Log 'app closed'

$installer = $req.installerPath
if (-not (Test-Path -LiteralPath $installer)) {
  Write-Log ('installer missing: ' + $installer)
  exit 2
}

$argLine = '/S /currentuser /D=' + $req.installDir
$code = -1
Write-Log ('running installer: ' + $installer + ' ' + $argLine)
try {
  $proc = Start-Process -FilePath $installer -ArgumentList $argLine -PassThru -Wait
  $code = $proc.ExitCode
} catch {
  Write-Log ('silent install error: ' + $_.Exception.Message)
}
Write-Log ('silent install exit=' + $code)

if ($code -ne 0) {
  Write-Log 'falling back to the interactive installer'
  try {
    $proc2 = Start-Process -FilePath $installer -PassThru -Wait
    $code = $proc2.ExitCode
    Write-Log ('interactive install exit=' + $code)
  } catch {
    Write-Log ('interactive install error: ' + $_.Exception.Message)
  }
}

$exePath = Join-Path $req.installDir $req.exeFile
if ($req.relaunch -and (Test-Path -LiteralPath $exePath)) {
  $running = @(Get-Process -Name $req.exeName -ErrorAction SilentlyContinue)
  if ($running.Count -eq 0) {
    try {
      Start-Process -FilePath $exePath
      Write-Log 'relaunched'
    } catch {
      Write-Log ('relaunch error: ' + $_.Exception.Message)
    }
  }
}

Write-Log ('done exit=' + $code)
exit 0
