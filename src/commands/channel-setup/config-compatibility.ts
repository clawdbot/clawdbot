// Applies host-owned compatibility migrations to external channel setup output.
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOfficialExternalChannelCompatibilityMigration } from "../../plugins/official-external-plugin-catalog.js";
import { LEGACY_CONFIG_MIGRATIONS } from "../doctor/shared/legacy-config-migrations.js";

export function normalizeExternalChannelSetupConfig(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
}): OpenClawConfig {
  const migrationId = resolveOfficialExternalChannelCompatibilityMigration(params.channel);
  if (!migrationId) {
    return params.cfg;
  }
  const migration = LEGACY_CONFIG_MIGRATIONS.find((candidate) => candidate.id === migrationId);
  if (!migration) {
    throw new Error(
      `Official external channel ${params.channel} references unknown compatibility migration ${migrationId}`,
    );
  }

  // Setup plugins may return config that shares nested objects with the previous
  // snapshot. Clone before the migration mutates its narrowly owned channel data.
  const next = structuredClone(params.cfg) as OpenClawConfig;
  migration.apply(next as Record<string, unknown>, []);
  return next;
}
