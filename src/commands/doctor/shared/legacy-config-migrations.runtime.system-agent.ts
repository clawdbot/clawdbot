// System-agent config migration from the retired user-facing name.
import {
  defineLegacyConfigMigration,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const LEGACY_SYSTEM_AGENT_CONFIG_RULE: LegacyConfigRule = {
  path: ["crestodian"],
  message: 'crestodian config moved to systemAgent. Run "openclaw doctor --fix" to migrate it.',
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "crestodian->systemAgent",
    describe: "Move retired system-agent config to systemAgent",
    legacyRules: [LEGACY_SYSTEM_AGENT_CONFIG_RULE],
    apply: (raw, changes) => {
      if (!Object.hasOwn(raw, "crestodian")) {
        return;
      }
      const retired = getRecord(raw.crestodian);
      const canonical = getRecord(raw.systemAgent);
      if (retired) {
        if (canonical) {
          mergeMissing(canonical, retired);
          raw.systemAgent = canonical;
          changes.push(
            "Merged legacy crestodian config into systemAgent; kept explicit systemAgent values.",
          );
        } else {
          raw.systemAgent = retired;
          changes.push("Moved legacy crestodian config to systemAgent.");
        }
      } else {
        changes.push("Removed invalid legacy crestodian config.");
      }
      delete raw.crestodian;
    },
  }),
];
