import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "memory-wiki",
  name: "Memory Wiki",
  description: "Persistent wiki compiler and Obsidian-friendly knowledge vault for OpenClaw.",
  register(api) {
    api.registerCli(
      async ({ program, config: appConfig }) => {
        const [{ registerWikiCli }, { resolveMemoryWikiConfig }] = await Promise.all([
          import("./src/cli.js"),
          import("./src/config.js"),
        ]);
        const pluginConfig = appConfig.plugins?.entries?.["memory-wiki"]?.config;
        registerWikiCli(program, resolveMemoryWikiConfig(pluginConfig), appConfig);
      },
      {
        descriptors: [
          {
            name: "wiki",
            description: "Inspect and initialize the memory wiki vault",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
