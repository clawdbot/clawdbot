import { definePluginEntry } from "./api.js";
import { registerWikiCli } from "./src/cli.js";
import { memoryWikiConfigSchema, resolveMemoryWikiConfig } from "./src/config.js";
import { createWikiCorpusSupplement } from "./src/corpus-supplement.js";
import { registerMemoryWikiGatewayMethods } from "./src/gateway.js";
import { createWikiPromptSectionBuilder } from "./src/prompt-section.js";
import {
  createWikiApplyTool,
  createWikiGetTool,
  createWikiLintTool,
  createWikiSearchTool,
  createWikiStatusTool,
} from "./src/tool.js";

export default definePluginEntry({
  id: "memory-wiki",
  name: "Memory Wiki",
  description: "Persistent wiki compiler and Obsidian-friendly knowledge vault for OpenClaw.",
  configSchema: memoryWikiConfigSchema,
  register(api) {
    const config = resolveMemoryWikiConfig(api.pluginConfig);

    api.registerMemoryPromptSupplement(createWikiPromptSectionBuilder(config));
    api.registerMemoryCorpusSupplement(
      createWikiCorpusSupplement({ config, appConfig: api.config }),
    );
    registerMemoryWikiGatewayMethods({ api, config, appConfig: api.config });
    api.registerTool(createWikiStatusTool(config, api.config), { name: "wiki_status" });
    api.registerTool(createWikiLintTool(config, api.config), { name: "wiki_lint" });
    api.registerTool(createWikiApplyTool(config, api.config), { name: "wiki_apply" });
    api.registerTool(
      (ctx) =>
        createWikiSearchTool(config, api.config, {
          agentId: ctx.agentId,
          agentSessionKey: ctx.sessionKey,
        }),
      { name: "wiki_search" },
    );
    api.registerTool(
      (ctx) =>
        createWikiGetTool(config, api.config, {
          agentId: ctx.agentId,
          agentSessionKey: ctx.sessionKey,
        }),
      { name: "wiki_get" },
    );
    api.registerCli(
      ({ program }) => {
        registerWikiCli(program, config, api.config);
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
