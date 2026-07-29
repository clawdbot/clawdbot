/** Builds normalized environment plans for managed daemon service rendering. */
import { normalizeEnvVarKey } from "../infra/host-env-security.js";
import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";

export type MutableServiceEnvPlan = {
  environment: Record<string, string | undefined>;
  environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
};

export function createMutableServiceEnvPlan(): MutableServiceEnvPlan {
  return {
    environment: {},
    environmentValueSources: {},
  };
}

export function normalizeServiceEnvPlanKey(rawKey: string): string | undefined {
  return normalizeEnvVarKey(rawKey, { portable: true })?.toUpperCase();
}

export function addServiceEnvPlanEntries(
  plan: MutableServiceEnvPlan,
  entries: Record<string, string | undefined>,
  options: {
    includeRawKeys?: boolean;
    valueSource?:
      | GatewayServiceEnvironmentValueSource
      | ((params: {
          rawKey: string;
          normalizedKey: string;
        }) => GatewayServiceEnvironmentValueSource | undefined);
  },
): void {
  for (const [rawKey, rawValue] of Object.entries(entries)) {
    if (typeof rawValue !== "string" || !rawValue.trim()) {
      if (options.includeRawKeys) {
        // Preserve explicit blank raw keys only when callers need round-trip
        // visibility in generated service env.
        plan.environment[rawKey] = rawValue;
        plan.environmentValueSources[rawKey] = "inline";
      }
      continue;
    }
    const value = rawValue;
    const normalizedKey = normalizeServiceEnvPlanKey(rawKey);
    if (!normalizedKey) {
      continue;
    }
    plan.environment[rawKey] = value;
    const valueSource =
      typeof options.valueSource === "function"
        ? options.valueSource({ rawKey, normalizedKey })
        : options.valueSource;
    plan.environmentValueSources[rawKey] = valueSource ?? "inline";
  }
}

export function compactServiceEnvPlanValueSources(plan: MutableServiceEnvPlan): void {
  for (const key of Object.keys(plan.environmentValueSources)) {
    if (!Object.hasOwn(plan.environment, key)) {
      delete plan.environmentValueSources[key];
    }
  }
}
