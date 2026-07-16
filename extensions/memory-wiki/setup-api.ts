import { definePluginEntry } from "./api.js";
import { migrateMemoryWikiLegacyConfig } from "./src/config-compat.js";

export default definePluginEntry({
  id: "memory-wiki",
  name: "Memory Wiki Setup",
  description: "Lightweight Memory Wiki setup hooks",
  register(api) {
    api.registerConfigMigration((config) => migrateMemoryWikiLegacyConfig(config));
  },
});
