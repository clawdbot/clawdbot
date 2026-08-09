import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";
import { migrateDoctorAgentRoster } from "./agent-roster-migration.js";

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
    apply: (raw, changes, context) => {
      const agents = getRecord(raw.agents);
      if (!context?.includeOwnedAgentRoster && agents && Object.hasOwn(agents, "list")) {
        migrateDoctorAgentRoster(raw, changes);
      }
    },
  }),
];
