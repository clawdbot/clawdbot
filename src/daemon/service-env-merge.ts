import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";

export function mergeGatewayServiceEnv(
  baseEnv: GatewayServiceEnv,
  command: GatewayServiceCommandConfig | null,
): GatewayServiceEnv {
  if (!command?.environment) {
    return baseEnv;
  }
  const merged = {
    ...baseEnv,
    ...command.environment,
  };
  for (const key of [
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_SYSTEMD_UNIT",
    "OPENCLAW_WINDOWS_TASK_NAME",
  ]) {
    // Explicit caller env selects the target service identity; installed command
    // env may come from a different profile or stale service file.
    const value = baseEnv[key]?.trim();
    if (value) {
      merged[key] = value;
    }
  }
  return merged;
}
