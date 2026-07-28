// Legacy diagnostics migrations are currently folded into the tuning-knob purge.
import type { LegacyConfigMigrationSpec } from "../../../config/legacy.shared.js";

/** Legacy config migration specs for diagnostics runtime config. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_DIAGNOSTICS: LegacyConfigMigrationSpec[] = [];
