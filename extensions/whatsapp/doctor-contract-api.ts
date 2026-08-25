// Whatsapp API module exposes the plugin public contract.
import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { detectWhatsAppLegacyStateMigrations } from "./src/state-migrations.js";

export { legacyConfigRules, normalizeCompatibilityConfig } from "./src/doctor-contract.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "whatsapp-legacy-state",
    label: "WhatsApp legacy state",
    resolvePlans: detectWhatsAppLegacyStateMigrations,
  }),
];
