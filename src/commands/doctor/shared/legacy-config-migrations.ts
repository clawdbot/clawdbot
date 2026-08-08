import {
  formatLegacyMemorySlotMigrationChange,
  migrateLegacyMemorySlotsInPlace,
  scanLegacyMemorySlotConfig,
} from "../../../config/legacy-memory-slot.js";
// Top-level legacy config migration registry and rule inventory used by doctor.
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { LEGACY_CONFIG_MIGRATIONS_AUDIO } from "./legacy-config-migrations.audio.js";
import { LEGACY_CONFIG_MIGRATIONS_CHANNELS } from "./legacy-config-migrations.channels.js";
import { LEGACY_CONFIG_MIGRATIONS_QUEUE } from "./legacy-config-migrations.queue.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME } from "./legacy-config-migrations.runtime.js";
import { LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH } from "./legacy-config-migrations.web-search.js";

const LEGACY_PLUGIN_MEMORY_SLOT_RULES: LegacyConfigRule[] = [
  {
    path: ["plugins", "slots", "memory"],
    message:
      'plugins.slots.memory is legacy and is ignored by runtime routing; run "openclaw doctor --fix" to migrate it to plugins.slots["memory.recall"] and remove plugins.slots.memory.',
    requireSourceLiteral: true,
  },
  {
    path: ["agents", "entries"],
    message:
      'agents.entries.*.plugins.slots.memory is legacy and is ignored by runtime routing; run "openclaw doctor --fix" to migrate it to plugins.slots["memory.recall"] and remove plugins.slots.memory.',
    match: (_value, root) =>
      scanLegacyMemorySlotConfig(root).some(
        (hit) => hit.location.scope === "agent" && hit.location.roster === "entries",
      ),
    requireSourceLiteral: true,
  },
  {
    path: ["agents", "list"],
    message:
      'agents.list[].plugins.slots.memory is legacy and is ignored by runtime routing; run "openclaw doctor --fix" to migrate it to plugins.slots["memory.recall"] and remove plugins.slots.memory.',
    match: (_value, root) =>
      scanLegacyMemorySlotConfig(root).some(
        (hit) => hit.location.scope === "agent" && hit.location.roster === "list",
      ),
    requireSourceLiteral: true,
  },
];

const LEGACY_PLUGIN_MEMORY_SLOT_MIGRATIONS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "legacy-memory-slots->memory.recall",
    describe: "Move legacy memory slot selectors to canonical memory.recall",
    legacyRules: LEGACY_PLUGIN_MEMORY_SLOT_RULES,
    apply: (raw, changes) => {
      changes.push(
        ...migrateLegacyMemorySlotsInPlace(raw).map((mutation) =>
          formatLegacyMemorySlotMigrationChange(mutation, "migration"),
        ),
      );
    },
  }),
];

const LEGACY_CONFIG_MIGRATION_SPECS = [
  ...LEGACY_PLUGIN_MEMORY_SLOT_MIGRATIONS,
  ...LEGACY_CONFIG_MIGRATIONS_CHANNELS,
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
