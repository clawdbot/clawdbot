import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";

export { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "imessage-legacy-state",
    label: "iMessage legacy state",
    // Config repair enumerates this artifact too; load the detector only when
    // detection or migration resolves plans.
    resolvePlans: async (params) => {
      const { detectIMessageLegacyStateMigrations } = await import("./src/state-migrations.js");
      return detectIMessageLegacyStateMigrations(params);
    },
  }),
];
