// Memory Wiki plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry, type OpenClawConfig } from "./api.js";
import { registerWikiCli } from "./src/cli.js";
import {
  memoryWikiConfigSchema,
  resolveMemoryWikiAgentConfig,
  resolveMemoryWikiConfig,
  resolveMemoryWikiConfiguredAgentIds,
  type MemoryWikiConfigResolver,
} from "./src/config.js";
import { createWikiCorpusSupplement } from "./src/corpus-supplement.js";
import { registerMemoryWikiGatewayMethods } from "./src/gateway.js";
import {
  configureMemoryWikiImportRunStateStore,
  createMemoryWikiImportRunStateStore,
} from "./src/import-runs-state.js";
import { createWikiPromptSectionBuilder } from "./src/prompt-section.js";
import {
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
} from "./src/source-sync-state.js";
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
    const getAppConfig = () =>
      (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig | undefined;
    const resolveConfig: MemoryWikiConfigResolver = (agentId, appConfig = getAppConfig()) =>
      resolveMemoryWikiAgentConfig({ config, appConfig, agentId });
    const resolveToolContext = (agentId?: string) => {
      const appConfig = getAppConfig();
      if (
        config.vault.scope === "agent" &&
        !agentId &&
        resolveMemoryWikiConfiguredAgentIds(appConfig).length > 1
      ) {
        // Context-free tool discovery cannot safely choose one agent's vault.
        return null;
      }
      return { appConfig, config: resolveConfig(agentId, appConfig) };
    };
    configureMemoryWikiSourceSyncStateStore(
      createMemoryWikiSourceSyncStateStore(api.runtime.state.openKeyedStore),
    );
    configureMemoryWikiImportRunStateStore(
      createMemoryWikiImportRunStateStore(api.runtime.state.openKeyedStore),
    );

    api.registerMemoryPromptSupplement(createWikiPromptSectionBuilder({ config, resolveConfig }));
    api.registerMemoryCorpusSupplement(createWikiCorpusSupplement({ resolveConfig, getAppConfig }));
    registerMemoryWikiGatewayMethods({
      api,
      config,
      appConfig: api.config,
      getAppConfig,
      resolveConfig,
    });
    api.registerTool(
      (ctx) => {
        const resolved = resolveToolContext(ctx.agentId);
        return resolved
          ? createWikiStatusTool(resolved.config, resolved.appConfig, {
              agentId: resolved.config.agentId ?? ctx.agentId,
            })
          : null;
      },
      { name: "wiki_status" },
    );
    api.registerTool(
      (ctx) => {
        const resolved = resolveToolContext(ctx.agentId);
        return resolved ? createWikiLintTool(resolved.config, resolved.appConfig) : null;
      },
      { name: "wiki_lint" },
    );
    api.registerTool(
      (ctx) => {
        const resolved = resolveToolContext(ctx.agentId);
        return resolved ? createWikiApplyTool(resolved.config, resolved.appConfig) : null;
      },
      { name: "wiki_apply" },
    );
    api.registerTool(
      (ctx) => {
        const resolved = resolveToolContext(ctx.agentId);
        if (!resolved) {
          return null;
        }
        return createWikiSearchTool(resolved.config, resolved.appConfig, {
          agentId: resolved.config.agentId ?? ctx.agentId,
          agentSessionKey: ctx.sessionKey,
          sandboxed: ctx.sandboxed,
        });
      },
      { name: "wiki_search" },
    );
    api.registerTool(
      (ctx) => {
        const resolved = resolveToolContext(ctx.agentId);
        if (!resolved) {
          return null;
        }
        return createWikiGetTool(resolved.config, resolved.appConfig, {
          agentId: resolved.config.agentId ?? ctx.agentId,
          agentSessionKey: ctx.sessionKey,
          sandboxed: ctx.sandboxed,
        });
      },
      { name: "wiki_get" },
    );
    api.registerCli(
      ({ program }) => {
        registerWikiCli(program, { config, resolveConfig, getAppConfig });
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
