/** Builds platform-specific log and start hints for daemon status output. */
import { resolveGatewaySystemdServiceName, resolveGatewayWindowsTaskName } from "./constants.js";
import { resolveGatewayRestartLogPath, resolveGatewaySupervisorLogPaths } from "./restart-logs.js";

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
    // Preserve the writer's path bytes; backslashes can be literal POSIX filename characters.
    return [
      `Launchd stdout (if installed): ${logs.stdoutPath}`,
      "Launchd stderr (if installed): suppressed",
      `Restart attempts: ${resolveGatewayRestartLogPath(env)}`,
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

/** Build recovery details after the caller selects its applicable runtime state. */
export function buildGatewayRuntimeRecoveryHints(params: {
  kind: "gui-session" | "stopped";
  restartCommand: string;
  logFile?: string | null;
  platform?: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): string[] {
  const hints =
    params.kind === "gui-session"
      ? [
          "LaunchAgent requires a logged-in macOS GUI session; SSH/headless/sudo shells cannot bootstrap gui/$UID.",
          `Sign in to the macOS desktop as this user, then run: ${params.restartCommand}`,
          "For headless VM setups, enable auto-login for the target user or use a custom LaunchDaemon (not shipped).",
        ]
      : [];
  if (params.logFile) {
    hints.push(`File logs: ${params.logFile}`);
  }
  if (params.kind === "stopped") {
    hints.push(
      ...buildPlatformRuntimeLogHints({
        platform: params.platform,
        env: params.env,
        systemdServiceName: resolveGatewaySystemdServiceName(params.env.OPENCLAW_PROFILE),
        windowsTaskName: resolveGatewayWindowsTaskName(params.env.OPENCLAW_PROFILE),
      }),
    );
  }
  return hints;
}

export function buildPlatformServiceStartHints(params: {
  platform?: NodeJS.Platform;
  installHint: string;
  startCommand: string;
  launchAgentPlistPath: string;
  systemdServiceName: string;
  windowsTaskName: string;
}): string[] {
  const platform = params.platform ?? process.platform;
  const base = [params.installHint, params.startCommand];
  // Install guidance and the OpenClaw start command stay first; native manager
  // commands are supplemental because they do not resolve profile/env paths.
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
