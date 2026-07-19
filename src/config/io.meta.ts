import { isRecord } from "../utils.js";
// Maintains config metadata fields written alongside user config.
import { VERSION } from "../version.js";
import {
  computeModelPolicyAllowlist,
  hasModelPolicyAllowlistMigrationMarker,
  isExplicitModelPolicy,
} from "./model-policy-allowlist-migration.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Metadata keys automatically stamped on config writes. */
const AUTO_MANAGED_CONFIG_META_FIELDS = {
  lastTouchedVersion: "lastTouchedVersion",
  lastTouchedAt: "lastTouchedAt",
} as const;

export const AUTO_MANAGED_CONFIG_META_PATHS = [
  ["meta", AUTO_MANAGED_CONFIG_META_FIELDS.lastTouchedVersion],
  ["meta", AUTO_MANAGED_CONFIG_META_FIELDS.lastTouchedAt],
] as const;

function defaultModelScope(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !isRecord(value.agents) || !isRecord(value.agents.defaults)) {
    return null;
  }
  return value.agents.defaults;
}

function collectLegacyDefaultModelAllow(value: unknown): string[] | null {
  const defaults = defaultModelScope(value);
  if (!defaults) {
    return null;
  }
  return computeModelPolicyAllowlist({
    root: value,
    defaults,
  });
}

function withDefaultModelAllow(cfg: OpenClawConfig, allow: string[]): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        modelPolicy: {
          ...cfg.agents?.defaults?.modelPolicy,
          allow,
        },
      },
    },
  };
}

function withModelPolicyAllowlistMigrationMarker(
  cfg: OpenClawConfig,
  params: {
    defaultAllow?: string[];
  } = {},
): OpenClawConfig {
  const withDefault = params.defaultAllow ? withDefaultModelAllow(cfg, params.defaultAllow) : cfg;
  return {
    ...withDefault,
    meta: {
      ...withDefault.meta,
      migrations: {
        ...withDefault.meta?.migrations,
        modelPolicyAllowlist: true,
      },
    },
  };
}

function stampModelPolicyAllowlistMigrationForWrite(
  cfg: OpenClawConfig,
  previousConfig: unknown,
): OpenClawConfig {
  const previousDefaultAllow = collectLegacyDefaultModelAllow(previousConfig);
  const defaultAllow = isExplicitModelPolicy(cfg.agents?.defaults?.modelPolicy)
    ? undefined
    : (previousDefaultAllow ?? undefined);
  if (defaultAllow) {
    return withModelPolicyAllowlistMigrationMarker(cfg, { defaultAllow });
  }
  if (hasModelPolicyAllowlistMigrationMarker(cfg)) {
    return cfg;
  }
  // The pre-write snapshot distinguishes a legacy restriction from a model map
  // created under the new metadata-only semantics before the general version stamp changes.
  return withModelPolicyAllowlistMigrationMarker(cfg);
}

export function stampConfigWriteMetadata(
  cfg: OpenClawConfig,
  now: string = new Date().toISOString(),
  version: string = VERSION,
  previousConfig?: unknown,
): OpenClawConfig {
  const migrationStamped =
    previousConfig === undefined
      ? cfg
      : stampModelPolicyAllowlistMigrationForWrite(cfg, previousConfig);
  return {
    ...migrationStamped,
    meta: {
      ...migrationStamped.meta,
      [AUTO_MANAGED_CONFIG_META_FIELDS.lastTouchedVersion]: version,
      [AUTO_MANAGED_CONFIG_META_FIELDS.lastTouchedAt]: now,
    },
  };
}
