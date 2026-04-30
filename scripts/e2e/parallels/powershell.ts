export function psSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function psArray(values: string[]): string {
  return `@(${values.map(psSingleQuote).join(", ")})`;
}

export function encodePowerShell(script: string): string {
  return Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, "utf16le").toString(
    "base64",
  );
}

export const windowsOpenClawResolver = String.raw`function Resolve-OpenClawCommand {
  if ($script:OpenClawResolvedCommand) { return $script:OpenClawResolvedCommand }
  $shimCandidates = @()
  if ($env:APPDATA) {
    $shimCandidates += Join-Path $env:APPDATA 'npm\openclaw.cmd'
    $shimCandidates += Join-Path $env:APPDATA 'npm\openclaw.ps1'
  }
  foreach ($name in @('openclaw.cmd', 'openclaw.ps1', 'openclaw')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and $command.Source) { $shimCandidates += $command.Source }
  }
  $npmPrefix = $null
  try {
    $npmPrefix = (& npm.cmd prefix -g 2>$null | Select-Object -First 1)
  } catch {}
  if ($npmPrefix) {
    $shimCandidates += Join-Path $npmPrefix 'openclaw.cmd'
    $shimCandidates += Join-Path $npmPrefix 'openclaw.ps1'
  }
  foreach ($candidate in $shimCandidates) {
    if ($candidate -and (Test-Path $candidate)) {
      $script:OpenClawResolvedCommand = @{ Kind = 'shim'; Path = $candidate }
      return $script:OpenClawResolvedCommand
    }
  }
  $entryCandidates = @()
  if ($env:APPDATA) {
    $entryCandidates += Join-Path $env:APPDATA 'npm\node_modules\openclaw\openclaw.mjs'
  }
  if ($npmPrefix) {
    $entryCandidates += Join-Path $npmPrefix 'node_modules\openclaw\openclaw.mjs'
  }
  foreach ($candidate in $entryCandidates) {
    if ($candidate -and (Test-Path $candidate)) {
      $script:OpenClawResolvedCommand = @{ Kind = 'node'; Path = $candidate }
      return $script:OpenClawResolvedCommand
    }
  }
  throw 'openclaw command not found in PATH, APPDATA npm, or npm global prefix'
}
function Invoke-OpenClaw {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]] $OpenClawArgs)
  $command = Resolve-OpenClawCommand
  $previousErrorActionPreference = $ErrorActionPreference
  $previousNativeErrorActionPreference = $PSNativeCommandUseErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $PSNativeCommandUseErrorActionPreference = $false
  try {
    if ($command.Kind -eq 'node') {
      & node.exe $command.Path @OpenClawArgs
    } else {
      & $command.Path @OpenClawArgs
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $previousNativeErrorActionPreference
  }
}`;
