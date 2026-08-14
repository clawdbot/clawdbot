// Telegram API module exposes the plugin public contract.
import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { detectTelegramLegacyStateMigrations } from "./src/state-migrations.js";

export { normalizeCompatibilityConfig, legacyConfigRules } from "./src/doctor-contract.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "telegram-legacy-state",
    label: "Telegram legacy state",
    resolvePlans: detectTelegramLegacyStateMigrations,
  }),
];
