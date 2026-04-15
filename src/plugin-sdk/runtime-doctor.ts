import type { OpenClawConfig } from "../config/config.js";
import { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";

export { collectProviderDangerousNameMatchingScopes };

export function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

type LegacyAliasParams = {
  entry: Record<string, unknown>;
  pathLabel?: string;
  changes?: string[];
};

export function normalizeLegacyDmAliases(params: LegacyAliasParams): {
  entry: Record<string, unknown>;
  changed: boolean;
} {
  return {
    entry: params.entry,
    changed: false,
  };
}

export function normalizeLegacyStreamingAliases(params: LegacyAliasParams): {
  entry: Record<string, unknown>;
  changed: boolean;
} {
  return {
    entry: params.entry,
    changed: false,
  };
}

export function collectRuntimeDoctorDangerousNameScopes(params: {
  cfg: OpenClawConfig;
  provider: string;
}) {
  return collectProviderDangerousNameMatchingScopes(params.cfg, params.provider);
}
