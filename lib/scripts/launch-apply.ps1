# Launch the background switch worker through WMI so it survives DSH being closed.
#
# A plain Start-Process (or a detached spawn from Node) still leaves the worker in
# the caller's job object / process tree, so it can be killed together with DSH.
# Win32_Process.Create parents the new process to WmiPrvSE instead.
param(
  [Parameter(Mandatory = $true)][string]$RequestPath
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $RequestPath
$worker = Join-Path $dir 'apply-switch.ps1'
$cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $worker + '" -RequestPath "' + $RequestPath + '"'

$result = @{ ok = $false; pid = 0; error = '' }
try {
  $res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
  $result.ok = ($res.ReturnValue -eq 0)
  $result.pid = [int]$res.ProcessId
  if ($res.ReturnValue -ne 0) {
    $result.error = 'Win32_Process.Create returned ' + $res.ReturnValue
  }
} catch {
  $result.error = $_.Exception.Message
}

$out = Join-Path $dir 'apply-launch.json'
try {
  # Windows PowerShell 5.1 writes a BOM with -Encoding UTF8; write UTF-8 without BOM instead.
  $json = ConvertTo-Json $result -Compress
  [System.IO.File]::WriteAllText($out, $json, (New-Object System.Text.UTF8Encoding($false)))
} catch { }
exit 0
