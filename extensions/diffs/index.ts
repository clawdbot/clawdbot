import { definePluginEntry } from "./api.js";
import { diffsPluginConfigSchema } from "./src/config.js";
import { registerDiffsPlugin } from "./src/plugin.js";

export default definePluginEntry({
  id: "diffs",
  name: "Diffs",
  description: "Read-only diff viewer and PNG/PDF renderer for agents.",
  configSchema: diffsPluginConfigSchema,
  register: registerDiffsPlugin,
});
