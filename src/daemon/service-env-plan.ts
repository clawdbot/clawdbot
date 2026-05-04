import { normalizeEnvVarKey } from "../infra/host-env-security.js";
import type { GatewayServiceEnvironmentValueSource } from "./service-types.js";

export type ServiceEnvSource =
  | "state-dotenv"
  | "config-env"
  | "config-secretref-env"
  | "exec-passenv"
  | "auth-profile-env"
  | "existing-preserved"
  | "service-generated";

export type ServiceEnvPlanEntry = {
  rawKey: string;
  normalizedKey: string;
  value: string;
  source: ServiceEnvSource;
};

export type MutableServiceEnvPlan = {
  environment: Record<string, string | undefined>;
  environmentValueSources: Record<string, GatewayServiceEnvironmentValueSource | undefined>;
  entriesByNormalizedKey: Map<string, ServiceEnvPlanEntry>;
};

export function createMutableServiceEnvPlan(): MutableServiceEnvPlan {
  return {
    environment: {},
    environmentValueSources: {},
    entriesByNormalizedKey: new Map(),
  };
}

export function normalizeServiceEnvPlanKey(rawKey: string): string | undefined {
  return normalizeEnvVarKey(rawKey, { portable: true })?.toUpperCase();
}

export function addServiceEnvPlanEntries(
  plan: MutableServiceEnvPlan,
  entries: Record<string, string | undefined>,
  options: {
    source: ServiceEnvSource;
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
    plan.entriesByNormalizedKey.set(normalizedKey, {
      rawKey,
      normalizedKey,
      value,
      source: options.source,
    });
  }
}

export function compactServiceEnvPlanValueSources(plan: MutableServiceEnvPlan): void {
  for (const key of Object.keys(plan.environmentValueSources)) {
    if (!Object.hasOwn(plan.environment, key)) {
      delete plan.environmentValueSources[key];
    }
  }
}
