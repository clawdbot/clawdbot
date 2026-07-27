/** Builds platform-specific log and start hints for daemon status output. */
import { toPosixPath } from "./output.js";
import { resolveGatewayRestartLogPath, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";

// macOS display paths should not keep Windows drive prefixes from mocked envs.
function toDarwinDisplayPath(value: string): string {
  return toPosixPath(value).replace(/^[A-Za-z]:/, "");
}

export function buildPlatformRuntimeLogHints(params: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  systemdServiceName: string;
  windowsTaskName: string;
}): string[] {
  const platform = params.platform ?? process.platform;
  const env = { ...process.env, ...params.env };
  if (platform === "darwin") {
    const logs = resolveGatewaySupervisorLogPaths(env, { platform });
    // Display launchd paths as POSIX-style paths even in cross-platform tests
    // where mocked env values may carry Windows drive prefixes.
    return [
      `Launchd stdout (if installed): ${toDarwinDisplayPath(logs.stdoutPath)}`,
      "Launchd stderr (if installed): suppressed",
      `Restart attempts: ${toDarwinDisplayPath(resolveGatewayRestartLogPath(env))}`,
    ];
  }
  if (platform === "linux") {
    return [
      `Logs: journalctl --user -u ${params.systemdServiceName}.service -n 200 --no-pager`,
      `Restart attempts: ${resolveGatewayRestartLogPath(env)}`,
    ];
  }
  if (platform === "win32") {
    return [
      `Logs: schtasks /Query /TN "${params.windowsTaskName}" /V /FO LIST`,
      `Restart attempts: ${resolveGatewayRestartLogPath(env)}`,
    ];
  }
  return [];
}

export function buildPlatformServiceStartHints(params: {
  platform?: NodeJS.Platform;
  installCommand: string;
  startCommand: string;
  launchAgentPlistPath: string;
  systemdServiceName: string;
  windowsTaskName: string;
}): string[] {
  const platform = params.platform ?? process.platform;
  const base = [params.installCommand, params.startCommand];
  // Native service-manager commands are supplemental hints; the OpenClaw
  // commands stay first because they know the generated profile/env paths.
  switch (platform) {
    case "darwin":
      return [...base, `launchctl bootstrap gui/$UID ${params.launchAgentPlistPath}`];
    case "linux":
      return [...base, `systemctl --user start ${params.systemdServiceName}.service`];
    case "win32":
      return [...base, `schtasks /Run /TN "${params.windowsTaskName}"`];
    default:
      return base;
  }
}
