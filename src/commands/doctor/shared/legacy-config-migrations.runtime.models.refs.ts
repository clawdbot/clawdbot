import { getRecord } from "../../../config/legacy.shared.js";
import {
  computeModelPolicyAllowlist,
  hasModelPolicyAllowlistMigrationMarker,
  materializeModelPolicyAllowlist,
} from "../../../config/model-policy-allowlist-migration.js";

export function collectLegacyDefaultModelAllowRefs(raw: Record<string, unknown>): string[] | null {
  // Marker seeding at the config write boundary ships atomically with metadata-only
  // model maps. Therefore an unmarked map is legacy even if a general write version advanced.
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  return computeModelPolicyAllowlist({
    root: raw,
    defaults,
  });
}

export function migrateExplicitDefaultModelAllowPolicy(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  if (hasModelPolicyAllowlistMigrationMarker(raw)) {
    return;
  }
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  const defaultModelPolicy = getRecord(defaults?.modelPolicy);
  const defaultNeedsEvaluation =
    Boolean(getRecord(defaults?.models)) &&
    !(defaultModelPolicy && Object.hasOwn(defaultModelPolicy, "allow"));
  if (!defaultNeedsEvaluation) {
    return;
  }
  const migrated = materializeModelPolicyAllowlist(raw);
  if (migrated.kind === "deferred") {
    return;
  }
  Object.assign(raw, migrated.config);
  changes.push(
    migrated.config.agents?.defaults?.modelPolicy?.allow
      ? "Copied the legacy default model map to agents.defaults.modelPolicy.allow."
      : "Recorded the legacy default model map as unrestricted without creating modelPolicy.allow.",
  );
}
