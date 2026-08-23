import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";
import {
  findLegacyTaskSuggestionToolPaths,
  LEGACY_TASK_SUGGESTION_TOOL_NAME,
  migrateLegacyTaskSuggestionToolPolicies,
  TASK_SUGGESTION_TOOL_NAME,
} from "./legacy-tool-name-migration.js";

// Core-owned config roots only. plugins.entries.*.config is opaque plugin-owned
// data; rewriting tool names there belongs to the owning plugin's doctor
// contract (legacyConfigRules), never to this core migration.
const TOOL_POLICY_ROOTS = ["tools", "agents", "channels", "gateway"] as const;

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "tools.suggest-task-name",
    describe: "Rename the task-suggestion tool in persisted tool policies",
    legacyRules: TOOL_POLICY_ROOTS.map((root) => ({
      path: [root],
      message: `Tool policies still reference ${LEGACY_TASK_SUGGESTION_TOOL_NAME}; run "openclaw doctor --fix" to rename it to ${TASK_SUGGESTION_TOOL_NAME}.`,
      match: (value) => findLegacyTaskSuggestionToolPaths(value, [root]).length > 0,
    })),
    apply: (raw, changes) => {
      if (!isRecord(raw)) {
        return;
      }
      const paths = TOOL_POLICY_ROOTS.flatMap((root) =>
        migrateLegacyTaskSuggestionToolPolicies(raw[root], [root]),
      );
      if (paths.length === 0) {
        return;
      }
      changes.push(
        `Renamed ${LEGACY_TASK_SUGGESTION_TOOL_NAME} to ${TASK_SUGGESTION_TOOL_NAME} in ${paths.join(", ")}.`,
      );
    },
  }),
];
