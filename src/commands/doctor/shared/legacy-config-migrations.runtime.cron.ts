import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const CRON_RUN_LOG_RULE: LegacyConfigRule = {
  path: ["cron", "runLog"],
  message:
    'cron.runLog is retired; run history now has fixed per-job retention. Run "openclaw doctor --fix".',
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_CRON: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "cron.runLog-remove",
    describe: "Remove retired cron run-log retention config",
    legacyRules: [CRON_RUN_LOG_RULE],
    apply: (raw, changes) => {
      const cron = getRecord(raw.cron);
      if (!cron || !Object.hasOwn(cron, "runLog")) {
        return;
      }
      delete cron.runLog;
      if (Object.keys(cron).length > 0) {
        raw.cron = cron;
      } else {
        delete raw.cron;
      }
      changes.push("Removed retired cron.runLog config; cron history now keeps 2000 runs per job.");
    },
  }),
];
