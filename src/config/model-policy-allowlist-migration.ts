// Shared legacy model allowlist detection for runtime, doctor, and config writes.
import { isRecord } from "../utils.js";
import { createModelPolicyRefValidator } from "./model-policy-ref.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function hasModelPolicyAllowlistMigrationMarker(value: unknown): boolean {
  if (
    isRecord(value) &&
    isRecord(value.meta) &&
    isRecord(value.meta.migrations) &&
    value.meta.migrations.modelPolicyAllowlist === true
  ) {
    return true;
  }
  return false;
}

/** A per-agent policy replaces inherited defaults only when it owns `allow`. */
export function hasExplicitModelPolicyAllow(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "allow");
}

export function computeModelPolicyAllowlist(params: {
  root: unknown;
  defaults: unknown;
}): string[] | null {
  // Unmarked persisted configs are indistinguishable from shipped legacy configs.
  // Preserve their restrictions until doctor or a config write stamps the marker.
  if (hasModelPolicyAllowlistMigrationMarker(params.root)) {
    return null;
  }
  return collectLegacyDefaultModelAllowRefs(params.defaults);
}

function collectLegacyDefaultModelAllowRefs(defaults: unknown): string[] | null {
  if (!isRecord(defaults)) {
    return null;
  }
  // An explicit modelPolicy object (even `{}`, which means allow-any) opts into the
  // new semantics, so a sibling models map stays metadata-only and is never read as
  // a legacy allowlist.
  if (isRecord(defaults.modelPolicy)) {
    return null;
  }
  if (!isRecord(defaults.models)) {
    return null;
  }
  const refs = Object.keys(defaults.models).filter((key) => key.trim().length > 0);
  return refs.length > 0 ? refs : null;
}

/** Materialize a whole legacy restriction, or retain its shipped dynamic-map semantics. */
export function materializeModelPolicyAllowlist(
  cfg: OpenClawConfig,
  previousConfig: unknown = cfg,
): { kind: "complete" | "deferred"; config: OpenClawConfig } {
  const previousAgents = isRecord(previousConfig) ? previousConfig.agents : undefined;
  const allow = isRecord(cfg.agents?.defaults?.modelPolicy)
    ? null
    : computeModelPolicyAllowlist({
        root: previousConfig,
        defaults: isRecord(previousAgents) ? previousAgents.defaults : undefined,
      });
  if (allow && !allow.every(createModelPolicyRefValidator(cfg.agents?.defaults?.models))) {
    // Bare refs depend on the effective agent/provider catalog. Without that context,
    // keep the entire legacy map active; a partial/empty explicit policy can widen access.
    const migrations = { ...cfg.meta?.migrations };
    delete migrations.modelPolicyAllowlist;
    return {
      kind: "deferred",
      config: hasModelPolicyAllowlistMigrationMarker(cfg)
        ? { ...cfg, meta: { ...cfg.meta, migrations } }
        : cfg,
    };
  }
  return {
    kind: "complete",
    config: {
      ...cfg,
      ...(allow
        ? {
            agents: {
              ...cfg.agents,
              defaults: { ...cfg.agents?.defaults, modelPolicy: { allow } },
            },
          }
        : {}),
      meta: { ...cfg.meta, migrations: { ...cfg.meta?.migrations, modelPolicyAllowlist: true } },
    },
  };
}
