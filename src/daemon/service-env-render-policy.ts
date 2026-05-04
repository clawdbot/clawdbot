import type { MutableServiceEnvPlan } from "./service-env-plan.js";
import {
  readManagedServiceEnvKeysFromEnvironment,
  writeManagedServiceEnvKeysToEnvironment,
} from "./service-managed-env.js";

function isLaunchAgentServiceEnvironment(params: {
  platform: NodeJS.Platform;
  serviceEnvironment: Record<string, string | undefined>;
}): boolean {
  return (
    params.platform === "darwin" &&
    Boolean(params.serviceEnvironment.OPENCLAW_LAUNCHD_LABEL?.trim())
  );
}

export function applyManagedServiceEnvRenderPolicy(params: {
  plan: MutableServiceEnvPlan;
  managedServiceEnvKeys: string | undefined;
  serviceEnvironment: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}): void {
  writeManagedServiceEnvKeysToEnvironment(params.plan.environment, params.managedServiceEnvKeys);
  if (params.plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS) {
    params.plan.environmentValueSources.OPENCLAW_SERVICE_MANAGED_ENV_KEYS = "inline";
  }
  if (!isLaunchAgentServiceEnvironment(params)) {
    return;
  }
  const managedKeys = readManagedServiceEnvKeysFromEnvironment({
    OPENCLAW_SERVICE_MANAGED_ENV_KEYS: params.managedServiceEnvKeys,
  });
  if (managedKeys.size === 0) {
    return;
  }
  for (const entry of params.plan.entriesByNormalizedKey.values()) {
    if (entry.source !== "state-dotenv" || !managedKeys.has(entry.normalizedKey)) {
      continue;
    }
    params.plan.environment[entry.rawKey] = entry.value;
    params.plan.environmentValueSources[entry.rawKey] = "inline";
  }
}
