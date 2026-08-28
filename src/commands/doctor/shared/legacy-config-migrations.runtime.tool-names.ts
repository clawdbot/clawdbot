import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";
import {
  findLegacyToolNamePaths,
  IMAGE_INSPECTION_TOOL_NAME_MIGRATION,
  migrateLegacyToolNamePolicies,
  TASK_SUGGESTION_TOOL_NAME_MIGRATION,
} from "./legacy-tool-name-migration.js";

// Core-owned config roots only. plugins.entries.*.config is opaque plugin-owned
// data; rewriting tool names there belongs to the owning plugin's doctor
// contract (legacyConfigRules), never to this core migration.
const TOOL_POLICY_ROOTS = ["tools", "agents", "channels", "gateway"] as const;

const TOOL_NAME_MIGRATIONS = [
  {
    id: "tools.suggest-task-name",
    describe: "Migrate the task-suggestion tool in persisted tool policies",
    migration: TASK_SUGGESTION_TOOL_NAME_MIGRATION,
  },
  {
    id: "tools.view-image-name",
    describe: "Migrate the image inspection tool in persisted tool policies",
    migration: IMAGE_INSPECTION_TOOL_NAME_MIGRATION,
  },
] as const;

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES: LegacyConfigMigrationSpec[] =
  TOOL_NAME_MIGRATIONS.map((migration) =>
    defineLegacyConfigMigration({
      id: migration.id,
      describe: migration.describe,
      legacyRules: TOOL_POLICY_ROOTS.map((root) => ({
        path: [root],
        message: `Tool policies still rely on legacy ${migration.migration.legacyName} coverage; run "openclaw doctor --fix" to preserve equivalent ${migration.migration.canonicalName} access.`,
        match: (value) => findLegacyToolNamePaths(value, migration.migration, [root]).length > 0,
      })),
      apply: (raw, changes) => {
        if (!isRecord(raw)) {
          return;
        }
        const paths = TOOL_POLICY_ROOTS.flatMap((root) =>
          migrateLegacyToolNamePolicies(raw[root], migration.migration, [root]),
        );
        if (paths.length === 0) {
          return;
        }
        changes.push(
          `Migrated legacy ${migration.migration.legacyName} policy coverage to ${migration.migration.canonicalName} in ${paths.join(", ")}.`,
        );
      },
    }),
  );
