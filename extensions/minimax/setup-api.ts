import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { migrateLegacyMinimaxPortalModels } from "./config-migration.js";

export default definePluginEntry({
  id: "minimax",
  name: "MiniMax Setup",
  description: "Lightweight MiniMax setup hooks",
  register(api) {
    api.registerConfigMigration((config) => migrateLegacyMinimaxPortalModels(config));
  },
});
