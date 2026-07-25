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
import { createCodexAppServerAgentHarness } from "./harness.js";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { readCodexPluginConfig } from "./src/app-server/config.js";
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
    const resolveCurrentConfig = () =>
      api.runtime.config?.current ? (api.runtime.config.current() as OpenClawConfig) : undefined;
    const resolvePluginConfig = (resolveConfig: () => OpenClawConfig | undefined) => {
      const liveConfig = resolveConfig();
      // Codex plugin config can change at runtime. A missing live entry is an
      // explicit removal, while an unavailable runtime snapshot uses startup config.
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
        enabledByDefault: readCodexPluginConfig(livePluginConfig).supervision?.enabled === true,
      }).enabled;
      if (!enabled) {
        return undefined;
      }
      return livePluginConfig;
    };
    const resolveCurrentPluginConfig = () => resolvePluginConfig(resolveCurrentConfig);
    let bindingStateStore: PluginStateSyncKeyedStore<StoredCodexAppServerBinding> | undefined;
    const openBindingStateStore = () =>
      (bindingStateStore ??= api.runtime.state.openSyncKeyedStore<StoredCodexAppServerBinding>({
        namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
        maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      }));
    // The base registration runtime deliberately rejects state access. Open the
    // store only when a proxied runtime performs the first binding operation.
    const lazyBindingStateStore: Pick<
      PluginStateSyncKeyedStore<StoredCodexAppServerBinding>,
      "entries" | "lookup" | "update"
    > = {
      entries: () => openBindingStateStore().entries(),
      lookup: (key) => openBindingStateStore().lookup(key),
      get update() {
        const store = openBindingStateStore();
        return store.update?.bind(store);
      },
    };
    const bindingStore = createLazyCodexAppServerBindingStore(lazyBindingStateStore);
    registerCodexCliMetadata(api);
    const sessionCatalogControl = createCodexSessionCatalogControl({
      getPluginConfig: resolveCurrentPluginConfig,
      getRuntimeConfig: resolveCurrentConfig,
    });
    const sessionCatalogEnabled =
      readCodexPluginConfig(resolveCurrentPluginConfig()).sessionCatalog?.enabled !== false;
    if (sessionCatalogEnabled) {
      codexSessionCatalogRuntime.register({
        api,
        bindingStore,
        control: sessionCatalogControl,
        getRuntimeConfig: resolveCurrentConfig,
      });
      for (const command of createCodexSessionCatalogNodeHostCommands(sessionCatalogControl)) {
        api.registerNodeHostCommand(command);
      }
    }
    for (const policy of createCodexSessionCatalogNodeInvokePolicies()) {
      api.registerNodeInvokePolicy(policy);
    }
    if (readCodexPluginConfig(resolveCurrentPluginConfig()).supervision?.enabled === true) {
      api.registerTool(
        (context) => {
          if (context.senderIsOwner !== true) {
            return [];
          }
          const resolveToolRuntimeConfig = () =>
            context.getRuntimeConfig?.() ??
            context.runtimeConfig ??
            context.config ??
            resolveCurrentConfig();
          return createCodexSupervisionTools({
            getPluginConfig: () => resolvePluginConfig(resolveToolRuntimeConfig),
            getRuntimeConfig: resolveToolRuntimeConfig,
            senderIsOwner: context.senderIsOwner,
          });
        },
        { names: [...CODEX_SUPERVISION_COMPAT_TOOL_NAMES] },
      );
    }
    api.registerAgentHarness(
      createCodexAppServerAgentHarness({
        bindingStore,
        sessionCatalogControl,
        resolveConfig: resolveCurrentConfig,
        resolvePluginConfig: resolveCurrentPluginConfig,
        runtime: api.runtime,
      }),
    );
    api.registerMediaUnderstandingProvider(
      buildCodexMediaUnderstandingProvider({ pluginConfig: api.pluginConfig }),
    );
    api.registerWebSearchProvider(
      createCodexWebSearchProvider({ resolvePluginConfig: resolveCurrentPluginConfig }),
    );
    api.registerMigrationProvider(buildCodexMigrationProvider({ runtime: api.runtime }));
    api.registerTool(
      (context) =>
        createCodexThreadsTool({
          bindingStore,
          context,
          runtime: api.runtime,
          getPluginConfig: resolveCurrentPluginConfig,
        }),
      { name: "codex_threads" },
    );
    api.registerToolMetadata({
      toolName: "codex_threads",
      displayName: "Codex Threads",
      description: "Manage native Codex threads in the shared user Codex home.",
      risk: "high",
      tags: ["codex", "sessions"],
    });
    for (const command of createCodexCliSessionNodeHostCommands()) {
      api.registerNodeHostCommand(command);
    }
    for (const policy of createCodexCliSessionNodeInvokePolicies()) {
      api.registerNodeInvokePolicy(policy);
    }
    api.registerCommand(
      createCodexCommand({
        pluginConfig: api.pluginConfig,
        resolvePluginConfig: resolveCurrentPluginConfig,
        deps: {
          bindingStore,
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
                  // Create the nested plugin config path on demand so codex
                  // plugin commands can enable/update Codex-managed plugins.
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
      // A cross-key handoff (dashboard "New Chat", a fork) fires session_end on
      // the parent only to start an INDEPENDENT child session under a different
      // key; that child owns its own Codex thread binding (a Codex fork is a new
      // thread, not a transfer of the parent's). Retiring the parent's still-live
      // binding here would strand it, so skip when the successor provably lives
      // under a different session key. The only cross-key emitter (gateway child
      // creation) keeps the parent row live; same-key rollovers omit or repeat
      // the key and still retire, as do unknown-current-key ends (no provable
      // handoff) and later idle/daily/deleted ends. See #106778.
      const endedSessionKey = sessionKey?.trim();
      const nextSessionKey = event.nextSessionKey?.trim();
      if (endedSessionKey && nextSessionKey && nextSessionKey !== endedSessionKey) {
        return;
      }
      const config = resolveCurrentConfig();
      const { sessionBindingIdentity } = await import("./src/app-server/session-binding.js");
      await bindingStore.retireSessionGeneration(
        sessionBindingIdentity({
          sessionId: event.sessionId,
          ...(sessionKey ? { sessionKey } : {}),
          ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
          ...(config ? { config } : {}),
        }),
      );
    });
  },
});
