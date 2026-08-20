/**
 * Bundled Codex plugin entry: app-server harness, media understanding,
 * migration provider, CLI-session commands, and binding hooks.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { mutateConfigFile } from "openclaw/plugin-sdk/config-mutation";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveLivePluginConfigObject,
} from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { registerCodexCliMetadata } from "./cli-metadata.js";
import {
  createCodexAppServerAgentHarness,
  createCodexAppServerNativeCompaction,
} from "./harness.js";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { readCodexPluginConfig } from "./src/app-server/config.js";
import { createCodexAppServerConnectionHealthService } from "./src/app-server/connection-health.js";
import { setManagedCodexPluginRoot } from "./src/app-server/managed-binary.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
  createLazyCodexAppServerBindingStore,
  type StoredCodexAppServerBinding,
} from "./src/app-server/session-binding-store.js";
import type { CodexPluginsConfigBlock } from "./src/command-plugins-management.js";
import { createCodexCommand } from "./src/commands.js";
import { codexConversationBindingRuntime } from "./src/conversation-binding.js";
import { buildCodexMigrationProvider } from "./src/migration/provider.js";
import { createCodexPluginsTool } from "./src/native-plugin-tool.js";
import { createCodexThreadsTool } from "./src/native-thread-tool.js";
import {
  createCodexCliSessionNodeHostCommands,
  createCodexCliSessionNodeInvokePolicies,
  listCodexCliSessionsOnNode,
  resumeCodexCliSessionOnNode,
  resolveCodexCliSessionForBindingOnNode,
} from "./src/node-cli-sessions.js";
import {
  createCodexSessionCatalogControl,
  createCodexSessionCatalogNodeHostCommands,
  createCodexSessionCatalogNodeInvokePolicies,
  codexSessionCatalogRuntime,
} from "./src/session-catalog.js";
import {
  CODEX_SUPERVISION_COMPAT_TOOL_NAMES,
  createCodexSupervisionTools,
} from "./src/supervision-tools.js";
import { createCodexWebSearchProvider } from "./src/web-search-provider.js";

const ENDED_SESSION_REASONS: ReadonlySet<string> = new Set([
  "new",
  "reset",
  "idle",
  "daily",
  "deleted",
]);

export default definePluginEntry({
  id: "codex",
  name: "Codex",
  description: "Codex app-server harness and native session supervision.",
  register(api) {
    // Bundled modules may execute from a shared dist chunk, so import.meta.url
    // cannot identify the owning plugin package or its pinned dependencies.
    setManagedCodexPluginRoot(api.rootDir);
    const resolveCurrentConfig = () =>
      api.runtime.config?.current ? (api.runtime.config.current() as OpenClawConfig) : undefined;
    const resolvePluginConfig = (resolveConfig: () => OpenClawConfig | undefined) => {
      const liveConfig = resolveConfig();
      if (!liveConfig) {
        return api.pluginConfig;
      }
      const livePluginConfig = resolveLivePluginConfigObject(
        () => liveConfig,
        "codex",
        api.pluginConfig as Record<string, unknown>,
      );
      const enabled = resolveEffectiveEnableState({
        id: "codex",
        origin: "bundled",
        config: normalizePluginsConfig(liveConfig.plugins),
        rootConfig: liveConfig,
        enabledByDefault: livePluginConfig !== undefined,
      }).enabled;
      if (!enabled) {
        return undefined;
      }
      return livePluginConfig;
    };
    const resolveCurrentPluginConfig = () => resolvePluginConfig(resolveCurrentConfig);
    const bindingStore = createLazyCodexAppServerBindingStore(api.runtime, {
      getConfig: resolveCurrentPluginConfig,
    });
    api.runtime.hooks?.register?.(
      "codex",
      {
        read: async () => {
          const plugins = await resolveCurrentPluginConfig();
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
    );
    api.on("inbound_claim", (event, ctx) =>
      codexConversationBindingRuntime.handleInboundClaim(event, ctx, {
        bindingStore,
        pluginConfig: resolveCurrentPluginConfig(),
        config: resolveCurrentConfig(),
        resumeCodexCliSessionOnNode: (params) =>
          resumeCodexCliSessionOnNode({ runtime: api.runtime, ...params }),
      }),
    );
    api.onConversationBindingResolved?.((event) =>
      codexConversationBindingRuntime.handleBindingResolved(event, { bindingStore }),
    );
    api.on("after_compaction", async (event, ctx) => {
      const previousSessionId = event.previousSessionId?.trim();
      const sessionId = ctx.sessionId?.trim();
      if (!previousSessionId || !sessionId || previousSessionId === sessionId) {
        return;
      }
      const config = resolveCurrentConfig();
      const sessionKey = ctx.sessionKey?.trim();
      const { sessionBindingIdentity } = await import("./src/app-server/session-binding.js");
      const identity = sessionBindingIdentity({
        sessionId,
        ...(sessionKey ? { sessionKey } : {}),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        ...(config ? { config } : {}),
      });
      const adopted = await bindingStore.adoptSessionGeneration(identity, previousSessionId);
      if (adopted === "conflict") {
        api.logger.warn?.(
          `codex: could not adopt compacted session generation ${sessionId} (${adopted}); secondary native compaction will skip`,
        );
      }
    });
    api.on("session_end", async (event, ctx) => {
      if (!event.reason || !ENDED_SESSION_REASONS.has(event.reason)) {
        return;
      }
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      const endedSessionKey = sessionKey?.trim();
      const nextSessionKey = event.nextSessionKey?.trim();
      if (endedSessionKey && nextSessionKey && nextSessionKey !== endedSessionKey) {
        return;
      }
      if (event.nextSessionId?.trim() === event.sessionId.trim()) {
        return;
      }
      const config = resolveCurrentConfig();
      const [{ sessionBindingIdentity }, { retireCodexAppServerSessionGeneration }] =
        await Promise.all([
          import("./src/app-server/session-binding.js"),
          import("./src/app-server/session-binding.js"),
        ]);
      const identity = sessionBindingIdentity({
        sessionId: event.sessionId.trim(),
        ...(endedSessionKey ? { sessionKey: endedSessionKey } : {}),
        ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
        ...(config ? { config } : {}),
      });
      await retireCodexAppServerSessionGeneration(identity);
    });
    api.registerCommand?.(createCodexCommand(api.runtime));
    api.registerTool?.(createCodexPluginsTool(api.runtime));
    api.registerTool?.(createCodexThreadsTool(api.runtime));
    api.registerTool?.(createCodexSupervisionTools(api.runtime));
    api.registerSupervisionCompatibleToolNames?.(CODEX_SUPERVISION_COMPAT_TOOL_NAMES);
    registerCodexCliMetadata(api);
    const supervisionEnabled = resolveCurrentConfig()?.features?.supervision === true;
    if (supervisionEnabled) {
      api.registerHarness?.(
        "codex-agent",
        createCodexAppServerAgentHarness(api.runtime),
      );
      api.registerHarness?.(
        "codex-native-compaction",
        createCodexAppServerNativeCompaction(api.runtime),
      );
    }
    api.registerMigrationProvider?.("codex", buildCodexMigrationProvider(api.runtime));
    api.registerMediaUnderstandingProvider?.("codex", buildCodexMediaUnderstandingProvider(api.runtime));
    api.registerWebSearchProvider?.("codex", createCodexWebSearchProvider(api.runtime));
    api.runtime.hooks?.register?.(
      "codex-session-catalog",
      {
        control: createCodexSessionCatalogControl(api.runtime),
        runtime: codexSessionCatalogRuntime,
        nodeHostCommands: createCodexSessionCatalogNodeHostCommands(api.runtime),
        nodeInvokePolicies: createCodexSessionCatalogNodeInvokePolicies(api.runtime),
      },
    );
    api.runtime.hooks?.register?.(
      "codex-cli-sessions",
      {
        control: {
          list: listCodexCliSessionsOnNode,
          resume: resumeCodexCliSessionOnNode,
          resolveForBinding: resolveCodexCliSessionForBindingOnNode,
        },
        nodeHostCommands: createCodexCliSessionNodeHostCommands(api.runtime),
        nodeInvokePolicies: createCodexCliSessionNodeInvokePolicies(api.runtime),
      },
    );
    api.runtime.hooks?.register?.(
      "codex-conversation-binding",
      {
        runtime: codexConversationBindingRuntime,
      },
    );
    const openBindingStateStore = () =>
      api.runtime.state.openSyncKeyedStore<StoredCodexAppServerBinding>({
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
  },
});