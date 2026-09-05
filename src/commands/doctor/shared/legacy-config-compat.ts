// Top-level legacy config migration runner used before full config validation.
import { inheritLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import type { LegacyConfigMigrationContext } from "../../../config/legacy.shared.js";
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

/** Apply all legacy doctor migrations to raw config, returning null when nothing changed. */
export function applyLegacyDoctorMigrations(
  raw: unknown,
  context?: LegacyConfigMigrationContext,
  options?: {
    // Plugin doctor contracts resolve the installed-plugin registry, which reads the shared
    // state database. Preview callers that must stay state-free pass false; the config they
    // produce is scaffolding only — the committed result always comes from a full run.
    pluginContracts?: boolean;
  },
): {
  next: Record<string, unknown> | null;
  changes: string[];
} {
  if (!raw || typeof raw !== "object") {
    return { next: null, changes: [] };
  }
  const original = raw as Record<string, unknown>;
  const next = structuredClone(original);
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes, context);
  }
  const compat = applyChannelDoctorCompatibilityMigrations(next, {
    pluginContracts: options?.pluginContracts !== false,
  });
  changes.push(...compat.changes);
  if (changes.length === 0) {
    return { next: null, changes: [] };
  }
  // The config reader keeps the retired default-agent marker outside the object.
  // Cloning must retain that owner so validation does not roll back a repairable roster.
  return { next: inheritLegacyDefaultAgentId(original, compat.next), changes };
}
