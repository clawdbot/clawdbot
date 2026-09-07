// Discord API module exposes the plugin public contract.
import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { detectDiscordLegacyStateMigrations } from "./src/monitor/model-picker-preferences-migrations.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./config-doctor-api.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "discord-legacy-state",
    label: "Discord legacy state",
    resolvePlans: detectDiscordLegacyStateMigrations,
  }),
];
