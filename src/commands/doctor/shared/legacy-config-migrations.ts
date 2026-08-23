// Top-level legacy config migration registry and rule inventory used by doctor.
import { LEGACY_CONFIG_MIGRATIONS_AUDIO } from "./legacy-config-migrations.audio.js";
import { LEGACY_CONFIG_MIGRATIONS_CHANNELS } from "./legacy-config-migrations.channels.js";
import { LEGACY_CONFIG_MIGRATIONS_QQBOT } from "./legacy-config-migrations.qqbot.js";
import { LEGACY_CONFIG_MIGRATIONS_QUEUE } from "./legacy-config-migrations.queue.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME } from "./legacy-config-migrations.runtime.js";
import { LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH } from "./legacy-config-migrations.web-search.js";

const LEGACY_CONFIG_MIGRATION_SPECS = [
  ...LEGACY_CONFIG_MIGRATIONS_CHANNELS,
  ...LEGACY_CONFIG_MIGRATIONS_QQBOT,
  ...LEGACY_CONFIG_MIGRATIONS_AUDIO,
  ...LEGACY_CONFIG_MIGRATIONS_QUEUE,
  ...LEGACY_CONFIG_MIGRATIONS_RUNTIME,
  ...LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH,
];

/** Ordered legacy migrations without their preview-only rule metadata. */
export const LEGACY_CONFIG_MIGRATIONS = LEGACY_CONFIG_MIGRATION_SPECS.map(
  ({ legacyRules: _legacyRules, ...migration }) => migration,
);

/** Aggregated legacy config rules used for doctor preview issue detection. */
export const LEGACY_CONFIG_MIGRATION_RULES = LEGACY_CONFIG_MIGRATION_SPECS.flatMap(
  (migration) => migration.legacyRules ?? [],
);
