// Doctor-only migration for the retired CLI backend adapter config DSL.
import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
} from "../../../config/legacy.shared.js";

const CLI_BACKENDS_PLUGIN_GUIDE = "https://docs.openclaw.ai/plugins/cli-backend-plugins";

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "agents.defaults.cliBackends-plugin-registration",
    describe: "Remove CLI backend adapter config now owned by plugins",
    legacyRules: [
      {
        path: ["agents", "defaults", "cliBackends"],
        message: `CLI backend adapters now register through plugins; see ${CLI_BACKENDS_PLUGIN_GUIDE}`,
      },
    ],
    apply: (raw, changes) => {
      const defaults = getRecord(getRecord(raw.agents)?.defaults);
      if (!defaults || !Object.hasOwn(defaults, "cliBackends")) {
        return;
      }
      // Adapter data is intentionally retired, not interpreted at runtime.
      // Arbitrary launch policy cannot be safely synthesized into executable plugin code.
      delete defaults.cliBackends;
      changes.push(
        `Removed agents.defaults.cliBackends; CLI backend adapters now register through plugins (${CLI_BACKENDS_PLUGIN_GUIDE}).`,
      );
    },
  }),
];
