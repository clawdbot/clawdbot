import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "memory-lancedb",
  name: "Memory LanceDB",
  description: "LanceDB-backed memory provider",
  register(api) {
    api.registerCli(() => {}, { commands: ["ltm"] });
  },
});
