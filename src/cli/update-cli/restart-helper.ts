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
  renderCmdRestartLogSetup,
  renderPosixRestartLogSetup,
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

/** Validates a string is safe for embedding in a batch (cmd.exe) script. */
function isBatchSafe(value: string): boolean {
  // Reject characters that have special meaning in batch: & | < > ^ % " ` $
  return /^[A-Za-z0-9 _\-().]+$/.test(value);
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
      if (!isBatchSafe(taskName)) {
        return null;
      }
      const port =
        Number.isFinite(gatewayPort) && gatewayPort > 0 ? gatewayPort : DEFAULT_GATEWAY_PORT;
      const restartLog = renderCmdRestartLogSetup({ ...process.env, ...env });
      filename = `openclaw-restart-${timestamp}.bat`;
      scriptContent = `@echo off
REM Standalone restart script — survives parent process termination.
REM Wait briefly to ensure file locks are released after update.
timeout /t 2 /nobreak >nul
${restartLog.lines.join("\r\n")}
>> ${restartLog.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart attempt source=update target=${taskName}
schtasks /End /TN "${taskName}" >> ${restartLog.quotedLogPath} 2>&1
REM Poll for gateway port release before rerun; force-kill listener if stuck.
set /a attempts=0
:wait_for_port_release
set /a attempts+=1
netstat -ano | findstr /R /C:":${port} .*LISTENING" >nul
if errorlevel 1 goto port_released
if %attempts% GEQ 10 goto force_kill_listener
timeout /t 1 /nobreak >nul
goto wait_for_port_release
:force_kill_listener
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":${port} .*LISTENING"') do (
  taskkill /F /PID %%P >> ${restartLog.quotedLogPath} 2>&1
  goto port_released
)
:port_released
schtasks /Run /TN "${taskName}" >> ${restartLog.quotedLogPath} 2>&1
set "status=%ERRORLEVEL%"
if not "%status%"=="0" (
  >> ${restartLog.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart failed source=update status=%status%
) else (
  >> ${restartLog.quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart done source=update
)
REM Self-cleanup
del "%~f0"
exit /b %status%
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
