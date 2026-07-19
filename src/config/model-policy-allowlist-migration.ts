// Shared legacy model allowlist detection for runtime, doctor, and config writes.
import { isRecord } from "../utils.js";

export const MODEL_POLICY_ALLOWLIST_MIGRATION_MARKER = "modelPolicyAllowlist";

export function hasModelPolicyAllowlistMigrationMarker(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.meta.migrations)) {
    return false;
  }
  return value.meta.migrations[MODEL_POLICY_ALLOWLIST_MIGRATION_MARKER] === true;
}

/** Any policy object opts into the explicit model-policy semantics. */
export function isExplicitModelPolicy(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

/** A per-agent policy replaces inherited defaults only when it owns `allow`. */
export function hasExplicitModelPolicyAllow(value: unknown): boolean {
  return isExplicitModelPolicy(value) && Object.hasOwn(value, "allow");
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
  if (isExplicitModelPolicy(defaults.modelPolicy)) {
    return null;
  }
  if (!isRecord(defaults.models)) {
    return null;
  }
  const refs = Object.keys(defaults.models).filter((key) => key.trim().length > 0);
  return refs.length > 0 ? refs : null;
}
