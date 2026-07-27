// Builds detached, platform-specific restart scripts for update handoff.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_GATEWAY_PORT } from "../../config/paths.js";
import { quoteCmdScriptArg } from "../../daemon/cmd-argv.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../daemon/constants.js";
import { resolveGatewayTaskScriptPath } from "../../daemon/paths.js";
import {
  renderPosixRestartLogSetup,
  resolveGatewayRestartLogPath,
  shellEscapeRestartLogValue,
} from "../../daemon/restart-logs.js";
import { getWindowsCmdExePath } from "../../infra/windows-install-roots.js";

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
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveSystemdUnit(env: NodeJS.ProcessEnv): string {
  const override = normalizeOptionalString(env.OPENCLAW_SYSTEMD_UNIT);
  if (override) {
    return override.endsWith(".service") ? override : `${override}.service`;
  }
  return `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
}

function resolveLaunchdLabel(env: NodeJS.ProcessEnv): string {
  const override = normalizeOptionalString(env.OPENCLAW_LAUNCHD_LABEL);
  if (override) {
    return override;
  }
  return resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
}

function resolveWindowsTaskName(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
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

  try {
    if (platform === "linux") {
      const unitName = resolveSystemdUnit(env);
      const escaped = shellEscape(unitName);
      const logSetup = renderPosixRestartLogSetup({ ...process.env, ...env });
      filename = `openclaw-restart-${timestamp}.sh`;
      scriptContent = `#!/bin/sh
# Standalone restart script — survives parent process termination.
# Wait briefly to ensure file locks are released after update.
sleep 1
exec 3>&2
${logSetup}
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
      const label = resolveLaunchdLabel(env);
      const escaped = shellEscape(label);
      // Fallback to 501 if getuid is not available (though it should be on macOS)
      const uid = process.getuid ? process.getuid() : 501;
      // Resolve HOME at generation time via env/process.env to match launchd.ts,
      // and shell-escape the label in the plist filename to prevent injection.
      const home = normalizeOptionalString(env.HOME) || process.env.HOME || os.homedir();
      const plistPath = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
      const escapedPlistPath = shellEscape(plistPath);
      const logSetup = renderPosixRestartLogSetup({ ...process.env, ...env });
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
# Try kickstart first (works when the service is still registered).
# If it fails (e.g. after bootout), clear any persisted disabled state,
# then re-register via bootstrap. Bootstrap loads RunAtLoad agents, so the
# fallback must not immediately kickstart -k the freshly spawned gateway.
# The final status is captured
# before self-cleanup so a genuine failure remains observable.
status=0
if ! launchctl kickstart -k 'gui/${uid}/${escaped}'; then
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
      scriptContent = `@echo off
REM Standalone restart script - survives parent process termination.
REM Keep this as a cmd wrapper so Group Policy script execution policies
REM cannot block the update restart handoff before schtasks.exe runs.
setlocal
set "OPENCLAW_RESTART_SCRIPT=%~f0"
set "OPENCLAW_RESTART_SCRIPT_DIR=%~dp0."
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:OPENCLAW_RESTART_SCRIPT; $s=Get-Content -Raw -LiteralPath $p; $m='# POWERSHELL'; $i=$s.IndexOf($m); if ($i -lt 0) { exit 1 }; Invoke-Expression $s.Substring($i)"
set "status=%ERRORLEVEL%"
del "%~f0" >nul 2>&1
rmdir "%OPENCLAW_RESTART_SCRIPT_DIR%" >nul 2>&1
exit /b %status%
# POWERSHELL
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

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace OpenClaw.Restart {
  public sealed class ProcessLease : IDisposable {
    private IntPtr handle;
    public long CreationTimeFileTime { get; private set; }

    internal ProcessLease(IntPtr handle, long creationTimeFileTime) {
      this.handle = handle;
      CreationTimeFileTime = creationTimeFileTime;
    }

    public bool Terminate() {
      return handle != IntPtr.Zero && NativeMethods.TerminateProcess(handle, 1);
    }

    public void Dispose() {
      if (handle != IntPtr.Zero) {
        NativeMethods.CloseHandle(handle);
        handle = IntPtr.Zero;
      }
    }
  }

  public static class NativeMethods {
    private const uint PROCESS_TERMINATE = 0x0001;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME {
      public uint Low;
      public uint High;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
      IntPtr process,
      out FILETIME creation,
      out FILETIME exit,
      out FILETIME kernel,
      out FILETIME user
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CloseHandle(IntPtr handle);

    [DllImport("shell32.dll", SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(
      [MarshalAs(UnmanagedType.LPWStr)] string commandLine,
      out int argumentCount
    );

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static ProcessLease TryOpenProcess(int processId) {
      IntPtr handle = OpenProcess(
        PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
        false,
        processId
      );
      if (handle == IntPtr.Zero) {
        return null;
      }

      FILETIME creation;
      FILETIME exit;
      FILETIME kernel;
      FILETIME user;
      if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user)) {
        CloseHandle(handle);
        return null;
      }

      long creationTime = ((long)creation.High << 32) | creation.Low;
      // Win32_Process.CreationDate exposes microseconds. Truncate FILETIME's
      // finer 100-nanosecond digit so both identity sources compare exactly.
      long normalizedCreationTime = creationTime - (creationTime % 10);
      return new ProcessLease(handle, normalizedCreationTime);
    }

    public static string[] ParseCommandLine(string commandLine) {
      int argumentCount;
      IntPtr arguments = CommandLineToArgvW(commandLine, out argumentCount);
      if (arguments == IntPtr.Zero) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      }
      try {
        var result = new List<string>(argumentCount);
        for (int index = 0; index < argumentCount; index++) {
          IntPtr argument = Marshal.ReadIntPtr(arguments, index * IntPtr.Size);
          result.Add(Marshal.PtrToStringUni(argument));
        }
        return result.ToArray();
      } finally {
        LocalFree(arguments);
      }
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
} catch {
  Write-RestartLog "openclaw restart native ownership helper unavailable source=update error=$($_.Exception.Message)"
}

# OPENCLAW_RESTART_KILL_POLICY_BEGIN
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
      Argv = @([OpenClaw.Restart.NativeMethods]::ParseCommandLine([string]$process.CommandLine))
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
    [scriptblock]$ProcessOpen = { param([int]$QueryPid) [OpenClaw.Restart.NativeMethods]::TryOpenProcess($QueryPid) }
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

    $recheckedListeners = & $ListenerQuery $Port
    $recheckedProcess = & $ProcessQuery $ProcessId
    $decisionParams = @{
      CandidatePid = $ProcessId
      ExpectedArgv = $ExpectedArgv
      ObservedProcess = $observedProcess
      HeldProcessCreationTimeFileTime = [string]$lease.CreationTimeFileTime
      RecheckedListeners = $recheckedListeners
      RecheckedProcess = $recheckedProcess
    }
    $decision = Get-OpenClawListenerKillDecision @decisionParams
    if ($decision -ne "kill") {
      Write-RestartLog "openclaw restart skipped listener source=update pid=$ProcessId decision=$decision"
      return
    }

    if ($lease.Terminate()) {
      Write-RestartLog "openclaw restart killed stale listener source=update pid=$ProcessId"
    } else {
      Write-RestartLog "openclaw restart failed to kill stale listener source=update pid=$ProcessId"
    }
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

exit $status
`;
    } else {
      return null;
    }

    const scriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-restart-"));
    const scriptPath = path.join(scriptDir, filename);
    try {
      await fs.writeFile(scriptPath, scriptContent, { mode: 0o755, flag: "wx" });
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

/**
 * Executes the prepared restart script as a **detached** process.
 *
 * The script must outlive the CLI process because the CLI itself is part
 * of the service being restarted — `systemctl restart` / `launchctl
 * kickstart -k` will terminate the current process tree.  Using
 * `spawn({ detached: true })` + `unref()` ensures the script survives
 * the parent's exit.
 *
 * Resolves immediately after spawning; the script runs independently.
 */
export async function runRestartScript(scriptPath: string): Promise<void> {
  const isWindows = process.platform === "win32";
  const file = isWindows ? getWindowsCmdExePath() : "/bin/sh";
  const args = isWindows ? ["/d", "/s", "/c", quoteCmdScriptArg(scriptPath)] : [scriptPath];

  try {
    const child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Restart handoff is best-effort; update completion must not crash here.
  }
}
