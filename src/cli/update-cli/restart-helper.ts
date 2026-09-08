// Builds detached, platform-specific restart scripts for update handoff.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_GATEWAY_PORT } from "../../config/paths.js";
import {
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { renderSystemLaunchDaemonOwnershipShellProbe } from "../../daemon/launchd-system.js";
import { resolveGatewayTaskScriptPath } from "../../daemon/paths.js";
import {
  renderPosixRestartLogSetup,
  resolveGatewayRestartLogPath,
  shellEscapeRestartLogValue,
} from "../../daemon/restart-logs.js";
import {
  buildHiddenLauncherScript,
  encodeWindowsLauncherScript,
} from "../../daemon/schtasks-layout.js";
import { getWindowsSystem32ExePath } from "../../infra/windows-install-roots.js";
import { COMMAND_PROCESS_TREE_KILL_GRACE_MS, spawnCommand } from "../../process/exec-spawn.js";

/**
 * Shell-escape a string for embedding in single-quoted shell arguments.
 * Replaces every `'` with `'\''` (end quote, escaped quote, resume quote).
 * For batch scripts, validates against special characters instead.
 */
function shellEscape(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/** Validates a task name is safe for embedding in Windows restart scripts. */
function isWindowsTaskNameSafe(value: string): boolean {
  return /^[A-Za-z0-9 _\-().]+$/.test(value);
}

function powerShellSingleQuote(value: string): string {
  // The standalone helper is read through stdin, whose code page varies by host.
  if (/[^\x20-\x7e]/u.test(value)) {
    return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}')))`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveSystemdUnit(env: NodeJS.ProcessEnv): string {
  const override = normalizeOptionalString(env.OPENCLAW_SYSTEMD_UNIT);
  if (override) {
    return override.endsWith(".service") ? override : `${override}.service`;
  }
  return `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
}

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

function resolveLinuxFilesystemBusUid(busAddress: string | undefined): string | undefined {
  // Classify a single filesystem transport before decoding so custom abstract
  // buses and semicolon-separated fallback addresses are never rewritten.
  const singleUnixAddress = busAddress?.match(/^unix:([^;]+)$/u)?.[1];
  const encodedBusPath = singleUnixAddress
    ?.split(",")
    .find((parameter) => parameter.startsWith("path="))
    ?.slice("path=".length);
  if (encodedBusPath === undefined) {
    return undefined;
  }

  try {
    return decodeURIComponent(encodedBusPath).match(/^\/run\/user\/(\d+)\/bus$/u)?.[1];
  } catch {
    return undefined;
  }
}

async function renderLinuxUserBusRepair(env: NodeJS.ProcessEnv): Promise<string> {
  const uid = typeof process.geteuid === "function" ? process.geteuid() : 0;
  if (uid <= 0) {
    return "";
  }

  const expectedRuntimeDir = `/run/user/${uid}`;
  const expectedBusAddress = `unix:path=${expectedRuntimeDir}/bus`;
  const runtimeDir = normalizeOptionalString(env.XDG_RUNTIME_DIR);
  const busAddress = normalizeOptionalString(env.DBUS_SESSION_BUS_ADDRESS);
  const normalizedRuntimeDir = runtimeDir ? path.posix.normalize(runtimeDir) : undefined;
  const runtimeUid = normalizedRuntimeDir?.match(/^\/run\/user\/(\d+)\/?$/)?.[1];
  const busUid = resolveLinuxFilesystemBusUid(busAddress);
  const repairRuntimeDir = !runtimeDir || (runtimeUid !== undefined && runtimeUid !== String(uid));
  // A custom runtime owns implicit bus discovery; inventing a standard bus
  // would silently redirect an isolated session to the host user manager.
  const preserveCustomRuntimeDir = Boolean(runtimeDir) && runtimeUid === undefined;
  const repairBusAddress =
    !preserveCustomRuntimeDir && (!busAddress || (busUid !== undefined && busUid !== String(uid)));
  const clearEmptyCustomBusAddress =
    preserveCustomRuntimeDir && env.DBUS_SESSION_BUS_ADDRESS !== undefined && !busAddress;
  if (!repairRuntimeDir && !repairBusAddress && !clearEmptyCustomBusAddress) {
    return "";
  }

  try {
    const socketRuntimeDir =
      clearEmptyCustomBusAddress && runtimeDir ? runtimeDir : expectedRuntimeDir;
    const stat = await fs.stat(path.join(socketRuntimeDir, "bus"));
    if (!stat.isSocket()) {
      return "";
    }
  } catch {
    return "";
  }

  const exports = [
    repairRuntimeDir ? `export XDG_RUNTIME_DIR='${shellEscape(expectedRuntimeDir)}'` : "",
    repairBusAddress ? `export DBUS_SESSION_BUS_ADDRESS='${shellEscape(expectedBusAddress)}'` : "",
    clearEmptyCustomBusAddress ? "unset DBUS_SESSION_BUS_ADDRESS" : "",
  ].filter(Boolean);
  return `# Repair missing or cross-user D-Bus values inherited by the updater.
${exports.join("\n")}
`;
}

/**
 * Prepares a standalone script to restart the gateway service.
 * This script is written to a temporary directory and does not depend on
 * the installed package files, ensuring restart capability even if the
 * update process temporarily removes or corrupts installation files.
 */
export async function prepareRestartScript(
  env: NodeJS.ProcessEnv = process.env,
  gatewayPort: number = DEFAULT_GATEWAY_PORT,
  windowsGatewayArgv: readonly string[] = [],
): Promise<string | null> {
  const timestamp = Date.now();
  const platform = process.platform;

  let scriptContent;
  let filename;
  let windowsWrapper: string | undefined;

  try {
    if (platform === "linux") {
      const unitName = resolveSystemdUnit(env);
      const escaped = shellEscape(unitName);
      const logSetup = renderPosixRestartLogSetup({ ...process.env, ...env });
      const userBusRepair = await renderLinuxUserBusRepair({ ...process.env, ...env });
      filename = `openclaw-restart-${timestamp}.sh`;
      scriptContent = `#!/bin/sh
# Standalone restart script — survives parent process termination.
# Wait briefly to ensure file locks are released after update.
sleep 1
exec 3>&2
${logSetup}
${userBusRepair}
printf '[%s] openclaw restart attempt source=update target=%s\\n' "$(date -u +%FT%TZ)" '${escaped}' >&2
if systemctl --user is-active --quiet '${escaped}' || systemctl --user is-enabled --quiet '${escaped}'; then
  if systemctl --user restart '${escaped}'; then
    status=0
    printf '[%s] openclaw restart done source=update\\n' "$(date -u +%FT%TZ)" >&2
  else
    status=$?
    printf '[%s] openclaw restart failed source=update status=%s\\n' "$(date -u +%FT%TZ)" "$status" >&2
  fi
elif systemctl is-active --quiet '${escaped}' || systemctl is-enabled --quiet '${escaped}'; then
  status=78
  printf '[%s] system-scoped openclaw gateway unit detected; update cannot restart it without sudo. Run: sudo systemctl restart %s\\n' "$(date -u +%FT%TZ)" '${escaped}' >&2
  printf '[%s] system-scoped openclaw gateway unit detected; update cannot restart it without sudo. Run: sudo systemctl restart %s\\n' "$(date -u +%FT%TZ)" '${escaped}' >&3 2>/dev/null || true
else
  if systemctl --user restart '${escaped}'; then
    status=0
    printf '[%s] openclaw restart done source=update\\n' "$(date -u +%FT%TZ)" >&2
  else
    status=$?
    printf '[%s] openclaw restart failed source=update status=%s\\n' "$(date -u +%FT%TZ)" "$status" >&2
  fi
fi
# Self-cleanup
script_dir=$(dirname "$0")
exec 3>&-
rm -f "$0"
rmdir "$script_dir" 2>/dev/null || true
exit "$status"
`;
    } else if (platform === "darwin") {
      const label = resolveLaunchAgentLabel(env);
      const escaped = shellEscape(label);
      // Fallback to 501 if getuid is not available (though it should be on macOS)
      const uid = process.getuid ? process.getuid() : 501;
      // Resolve HOME at generation time via env/process.env to match launchd.ts,
      // and shell-escape the label in the plist filename to prevent injection.
      const home = normalizeOptionalString(env.HOME) || process.env.HOME || os.homedir();
      const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
      const escapedPlistPath = shellEscape(plistPath);
      const logSetup = renderPosixRestartLogSetup({ ...process.env, ...env });
      const systemOwnershipProbe = renderSystemLaunchDaemonOwnershipShellProbe(label);
      filename = `openclaw-restart-${timestamp}.sh`;
      scriptContent = `#!/bin/sh
# Standalone restart script — survives parent process termination.
# Wait briefly to ensure file locks are released after update.
sleep 1
# Capture launchctl output so bootstrap/kickstart failures leave a durable
# audit trail. Log setup is best-effort: restart must still run if the log path
# is temporarily unavailable.
${logSetup}
printf '[%s] openclaw restart attempt source=update target=%s\\n' "$(date -u +%FT%TZ)" '${shellEscapeRestartLogValue(label)}' >&2
${systemOwnershipProbe}
# Try kickstart first (works when the service is still registered).
# If it fails (e.g. after bootout), clear any persisted disabled state,
# then re-register via bootstrap. Bootstrap loads RunAtLoad agents, so the
# fallback must not immediately kickstart -k the freshly spawned gateway.
# The final status is captured
# before self-cleanup so a genuine failure remains observable.
status=0
if [ -n "$openclaw_system_launchd_conflict" ]; then
  status=78
  printf '[%s] openclaw restart blocked source=update reason=%s\n' "$(date -u +%FT%TZ)" "$openclaw_system_launchd_detail" >&2
elif ! launchctl kickstart -k 'gui/${uid}/${escaped}'; then
  launchctl enable 'gui/${uid}/${escaped}'
  if launchctl bootstrap 'gui/${uid}' '${escapedPlistPath}'; then
    status=0
  else
    launchctl kickstart -k 'gui/${uid}/${escaped}'
    status=$?
  fi
fi
if [ "$status" -eq 0 ]; then
  printf '[%s] openclaw restart done source=update\\n' "$(date -u +%FT%TZ)" >&2
else
  printf '[%s] openclaw restart failed source=update status=%s\\n' "$(date -u +%FT%TZ)" "$status" >&2
fi
# Self-cleanup (log is retained under the OpenClaw state logs directory).
script_dir=$(dirname "$0")
rm -f "$0"
rmdir "$script_dir" 2>/dev/null || true
exit "$status"
`;
    } else if (platform === "win32") {
      const taskName = resolveWindowsTaskName(env);
      if (!isWindowsTaskNameSafe(taskName)) {
        return null;
      }
      const port =
        Number.isFinite(gatewayPort) && gatewayPort > 0 ? gatewayPort : DEFAULT_GATEWAY_PORT;
      const restartLogPath = resolveGatewayRestartLogPath({ ...process.env, ...env });
      const quotedLogPath = powerShellSingleQuote(restartLogPath);
      const quotedTaskName = powerShellSingleQuote(taskName);
      const gatewayScriptPath = resolveGatewayTaskScriptPath({ ...process.env, ...env });
      const quotedGatewayScriptPath = powerShellSingleQuote(gatewayScriptPath);
      const expectedGatewayArgv = windowsGatewayArgv.map(powerShellSingleQuote).join(", ");
      filename = `openclaw-restart-${timestamp}.cmd`;
      windowsWrapper = `@echo off
REM Standalone restart script - survives parent process termination.
REM Read fixed commands from stdin so Group Policy file-signing restrictions
REM do not prevent recovery. The companion contains ASCII-only script text.
setlocal
set "OPENCLAW_RESTART_SCRIPT_DIR=%~dp0."
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command - < "%~dpn0.ps1" > "%~dpn0.out"
set "status=%ERRORLEVEL%"
REM PowerShell can exit zero for malformed or incomplete stdin without running it.
findstr /x /c:"OPENCLAW_RESTART_COMPLETE" "%~dpn0.out" >nul 2>&1
if errorlevel 1 set "status=1"
REM This dedicated cmd process must exit instead of returning to a deleted batch file.
(
del "%~dpn0.out" >nul 2>&1
del "%~dpn0.ps1" >nul 2>&1
del "%~f0.vbs" >nul 2>&1
del "%~f0" >nul 2>&1
rmdir "%OPENCLAW_RESTART_SCRIPT_DIR%" >nul 2>&1
exit %status%
)
`;
      scriptContent = `
# Wait briefly to ensure file locks are released after update.
$ErrorActionPreference = "Continue"
Start-Sleep -Seconds 2

$logPath = ${quotedLogPath}
try {
  $logDir = Split-Path -Parent $logPath
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format o)] openclaw restart log initialized"
} catch {
  # Restart should still run if log setup is unavailable.
}

function Write-RestartLog {
  param([string]$Message)
  try {
    Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format o)] $Message"
  } catch {
  }
}

function Join-OpenClawProcessArguments {
  param([string[]]$Arguments)
  ($Arguments | ForEach-Object {
    if ($_ -match "\\s") {
      '"' + $_ + '"'
    } else {
      $_
    }
  }) -join " "
}

function Invoke-OpenClawSchtasksWithTimeout {
  param(
    [string[]]$Arguments,
    [int]$TimeoutSeconds
  )
  $process = $null
  try {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "schtasks.exe"
    $startInfo.Arguments = Join-OpenClawProcessArguments -Arguments $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try {
        $process.Kill()
      } catch {
      }
      Write-RestartLog "openclaw restart schtasks timeout source=update args=$($Arguments -join ' ')"
      return 124
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    if ($stdout) {
      Write-RestartLog $stdout.Trim()
    }
    if ($stderr) {
      Write-RestartLog $stderr.Trim()
    }
    return $process.ExitCode
  } catch {
    Write-RestartLog "openclaw restart schtasks failed source=update args=$($Arguments -join ' ') error=$($_.Exception.Message)"
    return 1
  }
}

function Get-OpenClawScheduledTaskState {
  param([string]$TaskName)
  try {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    if ($task -and $task.State) {
      return [string]$task.State
    }
  } catch {
  }

  try {
    $queryOutput = & schtasks.exe /Query /TN $TaskName /FO LIST 2>$null
    foreach ($line in $queryOutput) {
      if ($line -match "^\\s*Status:\\s*(.+?)\\s*$") {
        return $Matches[1]
      }
    }
  } catch {
  }

  return "Unknown"
}

# OPENCLAW_RESTART_KILL_POLICY_BEGIN
function Split-OpenClawWindowsCommandLine {
  param([string]$CommandLine)
  if (-not $CommandLine) { return @() }
  $arguments = [Collections.Generic.List[string]]::new()
  $index = 0
  # Shell32 treats argv[0] as a path, without backslash/quote escapes.
  if ($CommandLine[0] -eq '"') {
    $end = $CommandLine.IndexOf('"', 1)
    if ($end -lt 0) { $end = $CommandLine.Length }
    $arguments.Add($CommandLine.Substring(1, $end - 1))
    $index = [Math]::Min($end + 1, $CommandLine.Length)
  } else {
    while ($index -lt $CommandLine.Length -and $CommandLine[$index] -ne ' ' -and [int]$CommandLine[$index] -ne 9) { $index++ }
    $arguments.Add($CommandLine.Substring(0, $index))
  }
  while ($index -lt $CommandLine.Length) {
    while ($index -lt $CommandLine.Length -and ($CommandLine[$index] -eq ' ' -or [int]$CommandLine[$index] -eq 9)) { $index++ }
    if ($index -eq $CommandLine.Length) { break }
    $argument = [Text.StringBuilder]::new()
    $quoted = 0
    while ($index -lt $CommandLine.Length) {
      $character = $CommandLine[$index]
      if ($quoted -eq 0 -and ($character -eq ' ' -or [int]$character -eq 9)) { break }
      $slashes = 0
      while ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '\\') { $slashes++; $index++ }
      if ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '"') {
        [void]$argument.Append(('\\' * [int][Math]::Floor($slashes / 2)))
        if ($slashes % 2 -eq 1) {
          [void]$argument.Append('"')
          $index++
        }
        # Consecutive unescaped quotes produce one literal quote per three;
        # only a remainder of one leaves the argument quoted.
        $quotes = $quoted
        while ($index -lt $CommandLine.Length -and $CommandLine[$index] -eq '"') { $quotes++; $index++ }
        [void]$argument.Append(('"' * [int][Math]::Floor($quotes / 3)))
        $quoted = [int]($quotes % 3 -eq 1)
      } else {
        [void]$argument.Append(('\\' * $slashes))
        if ($index -eq $CommandLine.Length) { break }
        $character = $CommandLine[$index]
        if ($quoted -eq 0 -and ($character -eq ' ' -or [int]$character -eq 9)) { break }
        [void]$argument.Append($character)
        $index++
      }
    }
    $arguments.Add($argument.ToString())
  }
  return $arguments.ToArray()
}

function Get-OpenClawListenerSnapshot {
  param([int]$Port)

  try {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
      $listenerPids = @(
        Get-NetTCPConnection -State Listen -ErrorAction Stop |
          Where-Object { [int]$_.LocalPort -eq $Port } |
          ForEach-Object { [int]$_.OwningProcess } |
          Sort-Object -Unique
      )
      return [pscustomobject]@{ Known = $true; Pids = $listenerPids }
    }
  } catch {
    Write-RestartLog "openclaw restart Get-NetTCPConnection query failed source=update error=$($_.Exception.Message)"
  }

  try {
    $netstatOutput = @(& netstat.exe -ano -p tcp 2>$null)
    if ($LASTEXITCODE -ne 0) {
      return [pscustomobject]@{ Known = $false; Pids = @() }
    }

    $listenerPids = @()
    $localPortPattern = ":" + [regex]::Escape([string]$Port) + '$'
    foreach ($line in $netstatOutput) {
      $tokens = @($line.Trim() -split '\\s+' | Where-Object { $_ })
      if ($tokens.Count -lt 5 -or $tokens[0] -ine "TCP") {
        continue
      }
      # Listening rows use a wildcard foreign endpoint with port zero. Avoid the
      # localized state column entirely; protocol/endpoints/PID stay numeric.
      if ($tokens[1] -notmatch $localPortPattern -or $tokens[2] -notmatch ':0$') {
        continue
      }
      $listenerPid = 0
      if ([int]::TryParse($tokens[-1], [ref]$listenerPid) -and $listenerPid -gt 0) {
        $listenerPids += $listenerPid
      }
    }
    return [pscustomobject]@{
      Known = $true
      Pids = @($listenerPids | Sort-Object -Unique)
    }
  } catch {
    Write-RestartLog "openclaw restart netstat query failed source=update error=$($_.Exception.Message)"
    return [pscustomobject]@{ Known = $false; Pids = @() }
  }
}

function Get-OpenClawProcessFacts {
  param([int]$ProcessId)

  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if (-not $process -or -not $process.CommandLine -or -not $process.CreationDate) {
      return $null
    }
    $creationDate = if ($process.CreationDate -is [datetime]) {
      [datetime]$process.CreationDate
    } else {
      [System.Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate)
    }
    $creationTimeFileTime = [long]$creationDate.ToUniversalTime().ToFileTimeUtc()
    $creationTimeFileTime -= $creationTimeFileTime % 10
    return [pscustomobject]@{
      ProcessId = [int]$process.ProcessId
      CreationTimeFileTime = [string]$creationTimeFileTime
      Argv = @(Split-OpenClawWindowsCommandLine -CommandLine ([string]$process.CommandLine))
    }
  } catch {
    Write-RestartLog "openclaw restart process query failed source=update pid=$ProcessId error=$($_.Exception.Message)"
    return $null
  }
}

function Test-OpenClawArgvEqual {
  param([string[]]$Actual, [string[]]$Expected)
  if ($Actual.Count -ne $Expected.Count) {
    return $false
  }
  for ($index = 0; $index -lt $Actual.Count; $index++) {
    $actualArg = $Actual[$index]
    $expectedArg = $Expected[$index]
    # Windows may expand a bare launcher executable in the process command line.
    # Qualified paths and every non-executable argument remain exact.
    if ($index -eq 0 -and $expectedArg -notmatch '[\\\\/]') {
      $actualArg = [IO.Path]::GetFileName($actualArg)
      if (-not $actualArg.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
        $actualArg += '.exe'
      }
      if (-not $expectedArg.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
        $expectedArg += '.exe'
      }
    }
    if (-not [string]::Equals($actualArg, $expectedArg, [StringComparison]::OrdinalIgnoreCase)) {
      return $false
    }
  }
  return $true
}

function Test-OpenClawSameProcess {
  param($Expected, $Actual)
  return (
    $null -ne $Actual -and
    $Actual.ProcessId -eq $Expected.ProcessId -and
    $Actual.CreationTimeFileTime -eq $Expected.CreationTimeFileTime -and
    (Test-OpenClawArgvEqual -Actual $Actual.Argv -Expected $Expected.Argv)
  )
}

function Get-OpenClawListenerKillDecision {
  param(
    [int]$CandidatePid,
    [string[]]$ExpectedArgv,
    $ObservedProcess,
    [string]$HeldProcessCreationTimeFileTime,
    $RecheckedListeners,
    $RecheckedProcess
  )
  if ($ExpectedArgv.Count -eq 0) {
    return "expected-command-unavailable"
  }
  if ($null -eq $ObservedProcess -or $ObservedProcess.ProcessId -ne $CandidatePid) {
    return "process-unavailable"
  }
  if (-not (Test-OpenClawArgvEqual -Actual $ObservedProcess.Argv -Expected $ExpectedArgv)) {
    return "command-mismatch"
  }
  if ($HeldProcessCreationTimeFileTime -ne $ObservedProcess.CreationTimeFileTime) {
    return "process-replaced"
  }
  if (-not $RecheckedListeners.Known) {
    return "listener-query-unavailable"
  }
  if ($RecheckedListeners.Pids -notcontains $CandidatePid) {
    return "no-longer-listening"
  }
  if (-not (Test-OpenClawSameProcess -Expected $ObservedProcess -Actual $RecheckedProcess)) {
    return "process-replaced"
  }
  return "kill"
}

function Invoke-OpenClawVerifiedListenerKill {
  param(
    [int]$ProcessId,
    [int]$Port,
    [string[]]$ExpectedArgv,
    [scriptblock]$ProcessQuery = { param([int]$QueryPid) Get-OpenClawProcessFacts -ProcessId $QueryPid },
    [scriptblock]$ListenerQuery = { param([int]$QueryPort) Get-OpenClawListenerSnapshot -Port $QueryPort },
    [scriptblock]$ProcessOpen = { param([int]$QueryPid) [Diagnostics.Process]::GetProcessById($QueryPid) }
  )

  $observedProcess = & $ProcessQuery $ProcessId
  if ($null -eq $observedProcess) {
    Write-RestartLog "openclaw restart skipped listener source=update pid=$ProcessId decision=process-unavailable"
    return
  }
  if ($ExpectedArgv.Count -eq 0) {
    Write-RestartLog "openclaw restart skipped listener source=update pid=$ProcessId decision=expected-command-unavailable"
    return
  }
  if (-not (Test-OpenClawArgvEqual -Actual $observedProcess.Argv -Expected $ExpectedArgv)) {
    Write-RestartLog "openclaw restart skipped listener source=update pid=$ProcessId decision=command-mismatch"
    return
  }

  $lease = $null
  try {
    $lease = & $ProcessOpen $ProcessId
    if ($null -eq $lease) {
      Write-RestartLog "openclaw restart skipped listener source=update pid=$ProcessId decision=process-handle-unavailable"
      return
    }

    # Force the Process object to retain its handle before reading identity.
    # StartTime and Kill then use that handle, including if the PID is recycled.
    [void]$lease.Handle
    $heldCreationTime = [long]$lease.StartTime.ToUniversalTime().ToFileTimeUtc()
    $heldCreationTime -= $heldCreationTime % 10
    $recheckedListeners = & $ListenerQuery $Port
    $recheckedProcess = & $ProcessQuery $ProcessId
    $decisionParams = @{
      CandidatePid = $ProcessId
      ExpectedArgv = $ExpectedArgv
      ObservedProcess = $observedProcess
      HeldProcessCreationTimeFileTime = [string]$heldCreationTime
      RecheckedListeners = $recheckedListeners
      RecheckedProcess = $recheckedProcess
    }
    $decision = Get-OpenClawListenerKillDecision @decisionParams
    if ($decision -ne "kill") {
      Write-RestartLog "openclaw restart skipped listener source=update pid=$ProcessId decision=$decision"
      return
    }

    $lease.Kill()
    Write-RestartLog "openclaw restart killed stale listener source=update pid=$ProcessId"
  } catch {
    Write-RestartLog "openclaw restart ownership verification failed source=update pid=$ProcessId error=$($_.Exception.Message)"
  } finally {
    if ($null -ne $lease) {
      $lease.Dispose()
    }
  }
}
# OPENCLAW_RESTART_KILL_POLICY_END

function Invoke-OpenClawStartupLauncher {
  param([string]$LauncherPath)
  $launcherPath = $LauncherPath
  if (-not (Test-Path -LiteralPath $launcherPath)) {
    Write-RestartLog "openclaw restart startup launcher missing source=update path=$launcherPath"
    return 1
  }

  try {
    Start-Process -FilePath $launcherPath -WindowStyle Hidden | Out-Null
    Write-RestartLog "openclaw restart launched startup fallback source=update path=$launcherPath"
    return 0
  } catch {
    Write-RestartLog "openclaw restart startup fallback failed source=update error=$($_.Exception.Message)"
    return 1
  }
}

$taskName = ${quotedTaskName}
$port = ${port}
$gatewayScriptPath = ${quotedGatewayScriptPath}
$expectedGatewayArgv = @(${expectedGatewayArgv})
Write-RestartLog "openclaw restart attempt source=update target=$taskName"

$taskState = Get-OpenClawScheduledTaskState -TaskName $taskName
if ($taskState -eq "Running") {
  $endStatus = Invoke-OpenClawSchtasksWithTimeout -Arguments @("/End", "/TN", $taskName) -TimeoutSeconds 10
  if ($endStatus -ne 0) {
    Write-RestartLog "openclaw restart schtasks end did not complete cleanly source=update status=$endStatus"
  }
} else {
  Write-RestartLog "openclaw restart skipped schtasks end source=update state=$taskState"
}

for ($attempt = 1; $attempt -le 10; $attempt++) {
  $listenerSnapshot = Get-OpenClawListenerSnapshot -Port $port
  if (-not $listenerSnapshot.Known) {
    if ($attempt -eq 10) {
      Write-RestartLog "openclaw restart listener ownership unavailable source=update; refusing force-kill"
      break
    }
    Start-Sleep -Seconds 1
    continue
  }

  $listeners = @($listenerSnapshot.Pids)
  if ($listeners.Count -eq 0) {
    break
  }

  if ($attempt -eq 10) {
    foreach ($listenerPid in $listeners) {
      Invoke-OpenClawVerifiedListenerKill -ProcessId $listenerPid -Port $port -ExpectedArgv $expectedGatewayArgv
    }
    break
  }

  Start-Sleep -Seconds 1
}

$status = Invoke-OpenClawSchtasksWithTimeout -Arguments @("/Run", "/TN", $taskName) -TimeoutSeconds 30
if ($status -ne 0) {
  $status = Invoke-OpenClawStartupLauncher -LauncherPath $gatewayScriptPath
}
if ($status -eq 0) {
  Write-RestartLog "openclaw restart done source=update"
} else {
  Write-RestartLog "openclaw restart failed source=update status=$status"
}

[Console]::Out.WriteLine("OPENCLAW_RESTART_COMPLETE")
exit $status
`;
    } else {
      return null;
    }

    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-"));
    const scriptPath = path.join(scriptDir, filename);
    try {
      if (windowsWrapper) {
        // Stdin executes one statement at a time. One literal block requires the
        // entire helper to parse successfully before any restart action runs.
        await fs.writeFile(scriptPath.replace(/\.cmd$/u, ".ps1"), `& {\n${scriptContent}\n}\n\n`, {
          mode: 0o700,
          flag: "wx",
        });
        await fs.writeFile(
          `${scriptPath}.vbs`,
          encodeWindowsLauncherScript({
            format: "vbs",
            content: buildHiddenLauncherScript({ scriptPath }),
          }),
          { mode: 0o700, flag: "wx" },
        );
      }
      await fs.writeFile(scriptPath, windowsWrapper ?? scriptContent, { mode: 0o755, flag: "wx" });
    } catch (error) {
      await fs.rm(scriptDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return scriptPath;
  } catch {
    // If we can't write the script, we'll fall back to the standard restart method
    return null;
  }
}

/** Observe native acceptance separately from the caller's subsequent health check. */
export async function runRestartScript(scriptPath: string, timeoutMs: number): Promise<boolean> {
  const isWindows = process.platform === "win32";
  // WScript supplies the hidden console that PowerShell stdin needs while the
  // outer helper remains detached from the updater's lifetime.
  const file = isWindows ? getWindowsSystem32ExePath("wscript.exe") : "/bin/sh";
  const args = isWindows ? ["//B", "//Nologo", `${scriptPath}.vbs`] : [scriptPath];

  try {
    await spawnCommand([file, ...args], {
      // Keep the detached, stream-independent handoff on every platform, but
      // observe its result before classifying failed health as an activation refusal.
      detached: true,
      stdio: "ignore",
      timeout: timeoutMs,
      forceKillAfterDelay: COMMAND_PROCESS_TREE_KILL_GRACE_MS,
    });
    return true;
  } catch {
    return false;
  }
}
