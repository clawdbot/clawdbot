// Memory Wiki plugin module implements cli metadata behavior.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "memory-wiki",
  name: "Memory Wiki",
  description: "Persistent wiki compiler and Obsidian-friendly knowledge vault for OpenClaw.",
  register(api) {
    api.registerCli(
      async ({ program, config: appConfig }) => {
        const [{ registerWikiCli }, { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig }] =
          await Promise.all([import("./src/cli.js"), import("./src/config.js")]);
        const pluginConfig = appConfig.plugins?.entries?.["memory-wiki"]?.config;
        const config = resolveMemoryWikiConfig(pluginConfig);
        registerWikiCli(program, {
          config,
          getAppConfig: () => appConfig,
          resolveConfig: (agentId, currentAppConfig) =>
            resolveMemoryWikiAgentConfig({
              config,
              appConfig: currentAppConfig ?? appConfig,
              ...(agentId ? { agentId } : {}),
            }),
        });
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
