import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createCodexAppServerAgentHarness } from "./harness.js";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildCodexProvider } from "./provider.js";
import type { CodexPluginsConfigBlock } from "./src/command-plugins-management.js";
import { createCodexCommand } from "./src/commands.js";
import {
  handleCodexConversationBindingResolved,
  handleCodexConversationInboundClaim,
} from "./src/conversation-binding.js";
import { buildCodexMigrationProvider } from "./src/migration/provider.js";
import {
  createCodexCliSessionNodeHostCommands,
  createCodexCliSessionNodeInvokePolicies,
  listCodexCliSessionsOnNode,
  resumeCodexCliSessionOnNode,
  resolveCodexCliSessionForBindingOnNode,
} from "./src/node-cli-sessions.js";

export default definePluginEntry({
  id: "codex",
  name: "Codex",
  description: "Codex app-server harness and Codex-managed GPT model catalog.",
  register(api) {
    const resolveCurrentPluginConfig = () =>
      resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "codex",
        api.pluginConfig as Record<string, unknown>,
      ) ?? api.pluginConfig;
    api.registerAgentHarness(
      createCodexAppServerAgentHarness({ resolvePluginConfig: resolveCurrentPluginConfig }),
    );
    api.registerProvider(buildCodexProvider({ pluginConfig: api.pluginConfig }));
    api.registerMediaUnderstandingProvider(
      buildCodexMediaUnderstandingProvider({ pluginConfig: api.pluginConfig }),
    );
    api.registerMigrationProvider(buildCodexMigrationProvider({ runtime: api.runtime }));
    for (const command of createCodexCliSessionNodeHostCommands()) {
      api.registerNodeHostCommand(command);
    }
    for (const policy of createCodexCliSessionNodeInvokePolicies()) {
      api.registerNodeInvokePolicy(policy);
    }
    api.registerCommand(
      createCodexCommand({
        pluginConfig: api.pluginConfig,
        deps: {
          listCodexCliSessionsOnNode: (params) =>
            listCodexCliSessionsOnNode({ runtime: api.runtime, ...params }),
          resolveCodexCliSessionForBindingOnNode: (params) =>
            resolveCodexCliSessionForBindingOnNode({ runtime: api.runtime, ...params }),
          codexPluginsManagementIo: {
            readConfig: () => {
              const current = (api.runtime.config?.current?.() ?? {}) as OpenClawConfig;
              const plugins = (current as Record<string, unknown>).plugins;
              if (!plugins || typeof plugins !== "object") {
                return Promise.resolve({});
              }
              const entries = (plugins as Record<string, unknown>).entries;
              if (!entries || typeof entries !== "object") {
                return Promise.resolve({});
              }
              const codexEntry = (entries as Record<string, unknown>).codex;
              if (!codexEntry || typeof codexEntry !== "object") {
                return Promise.resolve({});
              }
              const config = (codexEntry as Record<string, unknown>).config;
              if (!config || typeof config !== "object") {
                return Promise.resolve({});
              }
              const codexPlugins = (config as Record<string, unknown>).codexPlugins;
              if (!codexPlugins || typeof codexPlugins !== "object") {
                return Promise.resolve({});
              }
              const declared = (codexPlugins as Record<string, unknown>).plugins;
              if (!declared || typeof declared !== "object") {
                return Promise.resolve({
                  enabled: (codexPlugins as Record<string, unknown>).enabled === true,
                });
              }
              return Promise.resolve({
                enabled: (codexPlugins as Record<string, unknown>).enabled === true,
                plugins: declared as Record<string, never>,
              });
            },
            mutate: async (update) => {
              await mutateConfigFile({
                mutate: (draft) => {
                  const root = draft as Record<string, unknown>;
                  root.plugins = (root.plugins ?? {}) as Record<string, unknown>;
                  const pluginsBlock = root.plugins as Record<string, unknown>;
                  pluginsBlock.entries = (pluginsBlock.entries ?? {}) as Record<string, unknown>;
                  const entries = pluginsBlock.entries as Record<string, unknown>;
                  entries.codex = (entries.codex ?? {}) as Record<string, unknown>;
                  const codexEntry = entries.codex as Record<string, unknown>;
                  codexEntry.config = (codexEntry.config ?? {}) as Record<string, unknown>;
                  const config = codexEntry.config as Record<string, unknown>;
                  config.codexPlugins = (config.codexPlugins ?? {}) as Record<string, unknown>;
                  const codexPlugins = config.codexPlugins as Record<string, unknown>;
                  codexPlugins.plugins = (codexPlugins.plugins ?? {}) as Record<string, unknown>;
                  update(codexPlugins as CodexPluginsConfigBlock);
                },
              });
            },
          },
        },
      }),
    );
    api.on("inbound_claim", (event, ctx) =>
      handleCodexConversationInboundClaim(event, ctx, {
        pluginConfig: resolveCurrentPluginConfig(),
        resumeCodexCliSessionOnNode: (params) =>
          resumeCodexCliSessionOnNode({ runtime: api.runtime, ...params }),
      }),
    );
    api.onConversationBindingResolved?.(handleCodexConversationBindingResolved);
  },
});
