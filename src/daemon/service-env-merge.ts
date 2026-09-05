import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";

export function resolveServiceInspectionEnv(): GatewayServiceEnv {
  // Runtime path overrides select the CLI store, not the installed service definition.
  const serviceEnv = { ...process.env };
  delete serviceEnv.OPENCLAW_STATE_DIR;
  delete serviceEnv.OPENCLAW_CONFIG_PATH;
  delete serviceEnv.OPENCLAW_HOME;
  return serviceEnv;
}

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
