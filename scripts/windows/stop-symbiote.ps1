[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [int]$ExcludeProcessId = 0,
  [switch]$ExcludeGateway
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\')
$unixRoot = '/' + $root.Substring(0, 1).ToLowerInvariant() + '/' + $root.Substring(3).Replace('\', '/')

function Test-CommandBelongsToWorkspace {
  param([string]$CommandLine)

  if (-not $CommandLine) { return $false }
  $normalized = $CommandLine.Replace('/', '\') -replace '\\{2,}', '\'
  return $normalized.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 `
    -or $CommandLine.IndexOf($unixRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

$roots = @()
foreach ($item in @(
  Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'"
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
)) {
  if ($item.Name -ieq 'electron.exe' -and $item.CommandLine -match 'desktop[\\/]+main\.cjs') {
    if (Test-CommandBelongsToWorkspace $item.CommandLine) { $roots += $item }
    continue
  }

  if (-not $ExcludeGateway -and $item.Name -ieq 'node.exe' -and $item.CommandLine -match 'dist[\\/]+gateway[\\/]+daemon\.js' -and (Test-CommandBelongsToWorkspace $item.CommandLine)) {
    $roots += $item
  }
}

$ids = [System.Collections.Generic.HashSet[int]]::new()
$pending = [System.Collections.Generic.Queue[int]]::new()
$electronPaths = @{}
foreach ($item in $roots) {
  $processId = [int]$item.ProcessId
  if (-not $ids.Add($processId)) { continue }
  if ($item.Name -ieq 'electron.exe' -and $item.ExecutablePath) {
    $electronPaths[$processId] = $item.ExecutablePath
    $pending.Enqueue($processId)
  }
}
while ($pending.Count -gt 0) {
  $parentId = $pending.Dequeue()
  foreach ($item in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $parentId")) {
    if ($item.Name -ine 'electron.exe' -or -not $item.ExecutablePath -or $item.ExecutablePath -ine $electronPaths[$parentId]) {
      continue
    }
    $processId = [int]$item.ProcessId
    if ($ids.Add($processId)) {
      $electronPaths[$processId] = $item.ExecutablePath
      $pending.Enqueue($processId)
    }
  }
}

if ($ExcludeProcessId -gt 0) {
  [void]$ids.Remove($ExcludeProcessId)
}

if ($WhatIfPreference) {
  foreach ($processId in $ids) { Write-Output "Would stop Symbiote process $processId." }
  return
}

foreach ($processId in $ids) {
  try {
    Stop-Process -Id $processId -Force -ErrorAction Stop
  } catch {
    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
      throw "Could not stop Symbiote process $($processId): $($_.Exception.Message)"
    }
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(30)
while ($true) {
  $remaining = if ($ids.Count -gt 0) { @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue) } else { @() }
  if ($remaining.Count -eq 0) { break }
  if ([DateTime]::UtcNow -ge $deadline) {
    throw "Symbiote processes did not exit within thirty seconds: $(($remaining.Id) -join ', ')."
  }
  Start-Sleep -Milliseconds 500
}

Write-Output "Stopped $($ids.Count) Symbiote process(es) for $root."
