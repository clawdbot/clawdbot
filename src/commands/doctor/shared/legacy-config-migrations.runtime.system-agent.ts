// Removes the retired system-agent alias before canonical validation.
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

const LEGACY_SYSTEM_AGENT_CONFIG_RULE: LegacyConfigRule = {
  path: ["crestodian"],
  message:
    'crestodian config was retired; system-agent rescue now uses built-in policy. Run "openclaw doctor --fix" to remove it.',
};

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "crestodian-retired",
    describe: "Remove retired system-agent config",
    legacyRules: [LEGACY_SYSTEM_AGENT_CONFIG_RULE],
    apply: (raw, changes) => {
      if (!Object.hasOwn(raw, "crestodian")) {
        return;
      }
      delete raw.crestodian;
      changes.push("Removed retired crestodian config; system-agent rescue uses built-in policy.");
    },
  }),
];
