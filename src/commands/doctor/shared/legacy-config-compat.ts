// Top-level legacy config migration runner used before full config validation.
import { applyChannelDoctorCompatibilityMigrations } from "./channel-legacy-config-migrate.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

/** Apply all legacy doctor migrations to raw config, returning null when nothing changed. */
export function applyLegacyDoctorMigrations(raw: unknown): {
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
    migration.apply(next, changes);
  }
  const compat = applyChannelDoctorCompatibilityMigrations(next);
  changes.push(...compat.changes);
  if (changes.length === 0) {
    return { next: null, changes: [] };
  }
  return { next: compat.next, changes };
}
