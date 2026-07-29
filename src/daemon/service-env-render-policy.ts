/** Applies platform render policy for managed daemon service environment values. */
import { normalizeServiceEnvPlanKey, type MutableServiceEnvPlan } from "./service-env-plan.js";
import {
  readManagedServiceEnvKeysFromEnvironment,
  writeManagedServiceEnvKeysToEnvironment,
} from "./service-managed-env.js";
import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";

function isLaunchAgentServiceEnvironment(params: {
  platform: NodeJS.Platform;
  serviceEnvironment: Record<string, string | undefined>;
}): boolean {
  return (
    params.platform === "darwin" &&
    Boolean(params.serviceEnvironment.OPENCLAW_LAUNCHD_LABEL?.trim())
  );
}

function addManagedServiceEnvEntries(params: {
  plan: MutableServiceEnvPlan;
  entries: Record<string, string | undefined>;
  managedKeys: ReadonlySet<string>;
  valueSource: GatewayServiceEnvironmentValueSource;
}): void {
  for (const [rawKey, value] of Object.entries(params.entries)) {
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    const key = normalizeServiceEnvPlanKey(rawKey);
    if (!key || !params.managedKeys.has(key)) {
      continue;
    }
    params.plan.environment[rawKey] = value;
    params.plan.environmentValueSources[rawKey] = params.valueSource;
  }
}

export function applyManagedServiceEnvRenderPolicy(params: {
  plan: MutableServiceEnvPlan;
  managedServiceEnvKeys: string | undefined;
  serviceEnvironment: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  existingEnvironmentFileEnvironment: Record<string, string | undefined>;
  stateDirDotEnvEnvironment: Record<string, string | undefined>;
  configSecretRefEnvironment: Record<string, string | undefined>;
}): void {
  const launchAgent = isLaunchAgentServiceEnvironment(params);
  writeManagedServiceEnvKeysToEnvironment(params.plan.environment, params.managedServiceEnvKeys);
  if (params.plan.environment.OPENCLAW_SERVICE_MANAGED_ENV_KEYS) {
    params.plan.environmentValueSources.OPENCLAW_SERVICE_MANAGED_ENV_KEYS = "inline";
  }
  const managedKeys = readManagedServiceEnvKeysFromEnvironment({
    OPENCLAW_SERVICE_MANAGED_ENV_KEYS: params.managedServiceEnvKeys,
  });
  if (managedKeys.size === 0) {
    return;
  }
  if (launchAgent) {
    addManagedServiceEnvEntries({
      plan: params.plan,
      entries: params.existingEnvironmentFileEnvironment,
      managedKeys,
      valueSource: "file",
    });
    addManagedServiceEnvEntries({
      plan: params.plan,
      entries: params.stateDirDotEnvEnvironment,
      managedKeys,
      valueSource: "inline",
    });
  }
  addManagedServiceEnvEntries({
    plan: params.plan,
    entries: params.configSecretRefEnvironment,
    managedKeys,
    valueSource: params.platform === "linux" ? "file" : "inline",
  });
}
