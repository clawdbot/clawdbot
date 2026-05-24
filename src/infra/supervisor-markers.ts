import { GATEWAY_LAUNCH_AGENT_LABEL, resolveGatewayLaunchAgentLabel } from "../daemon/constants.js";

const SUPERVISOR_HINTS = {
  launchd: ["OPENCLAW_LAUNCHD_LABEL"],
  systemd: ["OPENCLAW_SYSTEMD_UNIT", "INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM"],
  schtasks: ["OPENCLAW_WINDOWS_TASK_NAME"],
} as const;

export const SUPERVISOR_HINT_ENV_VARS = [
  "LAUNCH_JOB_LABEL",
  "LAUNCH_JOB_NAME",
  "XPC_SERVICE_NAME",
  ...SUPERVISOR_HINTS.launchd,
  ...SUPERVISOR_HINTS.systemd,
  ...SUPERVISOR_HINTS.schtasks,
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
] as const;

export type RespawnSupervisor = "launchd" | "systemd" | "schtasks";

function hasAnyHint(env: NodeJS.ProcessEnv, keys: readonly string[]): boolean {
  return keys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function isCurrentGatewayLaunchdJob(env: NodeJS.ProcessEnv): boolean {
  const expectedLabel = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
  if (
    [env.LAUNCH_JOB_LABEL, env.LAUNCH_JOB_NAME].some((value) => value?.trim() === expectedLabel)
  ) {
    return true;
  }
  return env.XPC_SERVICE_NAME?.trim() === GATEWAY_LAUNCH_AGENT_LABEL;
}

export function detectRespawnSupervisor(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): RespawnSupervisor | null {
  if (platform === "darwin") {
    return hasAnyHint(env, SUPERVISOR_HINTS.launchd) || isCurrentGatewayLaunchdJob(env)
      ? "launchd"
      : null;
  }
  if (platform === "linux") {
    return hasAnyHint(env, SUPERVISOR_HINTS.systemd) ? "systemd" : null;
  }
  if (platform === "win32") {
    if (hasAnyHint(env, SUPERVISOR_HINTS.schtasks)) {
      return "schtasks";
    }
    const marker = env.OPENCLAW_SERVICE_MARKER?.trim();
    const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
    return marker && serviceKind === "gateway" ? "schtasks" : null;
  }
  return null;
}
