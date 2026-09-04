import { resolveLegacyFirstAgentWorkspacePin } from "../../../config/legacy.default-agent-roles.js";
import { projectLegacyAgentRosterEntries } from "../../../config/legacy.roster.js";
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";

function migrateAgentEntries(raw: Record<string, unknown>, changes: string[]): void {
  const agents = getRecord(raw.agents);
  if (!agents || !Array.isArray(agents.list)) {
    return;
  }
  if (getRecord(agents.entries)) {
    delete agents.list;
    changes.push("Removed agents.list because canonical agents.entries is already set.");
    return;
  }
  const projected = projectLegacyAgentRosterEntries(agents.list);
  changes.push(...projected.diagnostics);
  const orderedEntries = projected.entries.map(({ config }) => config);
  const workspace = resolveLegacyFirstAgentWorkspacePin(agents, orderedEntries);
  if (workspace !== undefined) {
    orderedEntries[0]!.workspace = workspace;
  }
  agents.entries = Object.fromEntries(projected.entries.map(({ id, config }) => [id, config]));
  delete agents.list;
  changes.push("Moved agents.list → keyed agents.entries.");
}

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_ENTRIES: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "runtime.agents-entries",
    describe: "Move agent arrays to keyed entries",
    legacyRules: [
      {
        path: ["agents", "list"],
        message: 'agents.list moved to keyed agents.entries. Run "openclaw doctor --fix".',
      },
    ],
    apply: migrateAgentEntries,
  }),
];
