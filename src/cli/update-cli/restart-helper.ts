import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_GATEWAY_PORT } from "../../config/paths.js";
import { quoteCmdScriptArg } from "../../daemon/cmd-argv.js";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../daemon/constants.js";
import {
  renderPosixRestartLogSetup,
  resolveGatewayRestartLogPath,
  shellEscapeRestartLogValue,
} from "../../daemon/restart-logs.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

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
): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const timestamp = Date.now();
  const platform = process.platform;

  let scriptContent = "";
  let filename = "";

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
${logSetup}
printf '[%s] openclaw restart attempt source=update target=%s\\n' "$(date -u +%FT%TZ)" '${escaped}' >&2
if systemctl --user restart '${escaped}'; then
  status=0
  printf '[%s] openclaw restart done source=update\\n' "$(date -u +%FT%TZ)" >&2
else
  status=$?
  printf '[%s] openclaw restart failed source=update status=%s\\n' "$(date -u +%FT%TZ)" "$status" >&2
fi
# Self-cleanup
rm -f "$0"
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
# then re-register via bootstrap and kickstart. The final status is captured
# before self-cleanup so a genuine failure remains observable.
status=0
if ! launchctl kickstart -k 'gui/${uid}/${escaped}'; then
  launchctl enable 'gui/${uid}/${escaped}'
  launchctl bootstrap 'gui/${uid}' '${escapedPlistPath}'
  launchctl kickstart -k 'gui/${uid}/${escaped}'
  status=$?
fi
if [ "$status" -eq 0 ]; then
  printf '[%s] openclaw restart done source=update\\n' "$(date -u +%FT%TZ)" >&2
else
  printf '[%s] openclaw restart failed source=update status=%s\\n' "$(date -u +%FT%TZ)" "$status" >&2
fi
# Self-cleanup (log is retained under the OpenClaw state logs directory).
rm -f "$0"
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
      filename = `openclaw-restart-${timestamp}.cmd`;
      scriptContent = `@echo off
REM Standalone restart script - survives parent process termination.
REM Keep this as a cmd wrapper so Group Policy script execution policies
REM cannot block the update restart handoff before schtasks.exe runs.
setlocal
set "OPENCLAW_RESTART_SCRIPT=%~f0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:OPENCLAW_RESTART_SCRIPT; $s=Get-Content -Raw -LiteralPath $p; $m='# POWERSHELL'; $i=$s.IndexOf($m); if ($i -lt 0) { exit 1 }; Invoke-Expression $s.Substring($i)"
set "status=%ERRORLEVEL%"
del "%~f0" >nul 2>&1
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

function Get-OpenClawListenerPids {
  param([int]$Port)
  $listenerPids = @()

  try {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
      $listenerPids += Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { [int]$_.OwningProcess }
    }
  } catch {
  }

  if ($listenerPids.Count -eq 0) {
    try {
      $portPattern = [regex]::Escape(":$Port")
      $linePattern = "^\\s*TCP\\s+\\S+$portPattern\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$"
      & netstat.exe -ano -p tcp 2>$null | ForEach-Object {
        if ($_ -match $linePattern) {
          $listenerPids += [int]$Matches[1]
        }
      }
    } catch {
    }
  }

  $listenerPids | Sort-Object -Unique
}

$taskName = ${quotedTaskName}
$port = ${port}
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
  $listeners = @(Get-OpenClawListenerPids -Port $port)
  if ($listeners.Count -eq 0) {
    break
  }

  if ($attempt -eq 10) {
    foreach ($listenerPid in $listeners) {
      try {
        Stop-Process -Id $listenerPid -Force -ErrorAction Stop
        Write-RestartLog "openclaw restart killed stale listener source=update pid=$listenerPid"
      } catch {
        Write-RestartLog "openclaw restart failed to kill stale listener source=update pid=$listenerPid error=$($_.Exception.Message)"
      }
    }
    break
  }

  Start-Sleep -Seconds 1
}

$status = Invoke-OpenClawSchtasksWithTimeout -Arguments @("/Run", "/TN", $taskName) -TimeoutSeconds 30
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

    const scriptPath = path.join(tmpDir, filename);
    await fs.writeFile(scriptPath, scriptContent, { mode: 0o755 });
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
  const file = isWindows ? "cmd.exe" : "/bin/sh";
  const args = isWindows ? ["/d", "/s", "/c", quoteCmdScriptArg(scriptPath)] : [scriptPath];

  const child = spawn(file, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}
