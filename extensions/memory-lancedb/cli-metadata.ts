// Memory Lancedb plugin module implements cli metadata behavior.
import { definePluginEntry } from "openclaw/plugin-sdk/core";

export default definePluginEntry({
  id: "memory-lancedb",
  name: "Memory LanceDB",
  description: "LanceDB-backed memory provider",
  register(api) {
    api.registerCli(() => {}, {
      descriptors: [
        {
          name: "ltm",
          description: "Inspect and query LanceDB-backed memory",
          hasSubcommands: true,
        },
      ],
    });
  },
});
