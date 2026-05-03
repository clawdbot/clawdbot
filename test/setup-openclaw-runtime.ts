import { afterAll, afterEach, beforeAll, vi } from "vitest";
import type {
  ChannelId,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../src/config/config.js";
import type { OutboundSendDeps } from "../src/infra/outbound/deliver.js";
import type { PluginRegistry } from "../src/plugins/registry.js";
import { installSharedTestSetup } from "./setup.shared.js";

installSharedTestSetup();

const WORKER_RUNTIME_STATE = Symbol.for("openclaw.testSetupRuntimeState");
const WORKER_PLUGIN_RUNTIME_HELPERS = Symbol.for("openclaw.testSetupPluginRuntimeHelpers");
const WORKER_CLEANUP_HELPERS = Symbol.for("openclaw.testSetupCleanupHelpers");
type WorkerRuntimeState = {
  defaultPluginRegistry: PluginRegistry | null;
  materializedDefaultPluginRegistry: PluginRegistry | null;
};
type WorkerPluginRuntimeHelpers = {
  resetPluginRuntimeStateForTest: typeof import("../src/plugins/runtime.js").resetPluginRuntimeStateForTest;
  setActivePluginRegistry: typeof import("../src/plugins/runtime.js").setActivePluginRegistry;
};
type WorkerCleanupHelpers = {
  clearSessionStoreCaches: typeof import("../src/config/sessions/store-cache.js").clearSessionStoreCaches;
  drainFileLockStateForTest: typeof import("../src/infra/file-lock.js").drainFileLockStateForTest;
  drainSessionStoreWriterQueuesForTest: typeof import("../src/config/sessions/store-writer-state.js").drainSessionStoreWriterQueuesForTest;
  drainSessionWriteLockStateForTest: typeof import("../src/agents/session-write-lock.js").drainSessionWriteLockStateForTest;
  resetContextWindowCacheForTest: typeof import("../src/agents/context-runtime-state.js").resetContextWindowCacheForTest;
  resetFileLockStateForTest: typeof import("../src/infra/file-lock.js").resetFileLockStateForTest;
  resetModelsJsonReadyCacheForTest: typeof import("../src/agents/models-config-state.js").resetModelsJsonReadyCacheForTest;
  resetSessionWriteLockStateForTest: typeof import("../src/agents/session-write-lock.js").resetSessionWriteLockStateForTest;
};

type ReplyToModeResolver = NonNullable<
  NonNullable<ChannelPlugin["threading"]>["resolveReplyToMode"]
>;

const workerRuntimeState = (() => {
  const globalState = globalThis as typeof globalThis & {
    [WORKER_RUNTIME_STATE]?: WorkerRuntimeState;
  };
  if (!globalState[WORKER_RUNTIME_STATE]) {
    globalState[WORKER_RUNTIME_STATE] = {
      defaultPluginRegistry: null,
      materializedDefaultPluginRegistry: null,
    };
  }
  return globalState[WORKER_RUNTIME_STATE];
})();

function loadWorkerPluginRuntimeHelpers(): Promise<WorkerPluginRuntimeHelpers> {
  const globalState = globalThis as typeof globalThis & {
    [WORKER_PLUGIN_RUNTIME_HELPERS]?: Promise<WorkerPluginRuntimeHelpers>;
  };
  globalState[WORKER_PLUGIN_RUNTIME_HELPERS] ??= import("../src/plugins/runtime.js").then(
    (pluginRuntime) => ({
      resetPluginRuntimeStateForTest: pluginRuntime.resetPluginRuntimeStateForTest,
      setActivePluginRegistry: pluginRuntime.setActivePluginRegistry,
    }),
  );
  return globalState[WORKER_PLUGIN_RUNTIME_HELPERS];
}

function loadWorkerCleanupHelpers(): Promise<WorkerCleanupHelpers> {
  const globalState = globalThis as typeof globalThis & {
    [WORKER_CLEANUP_HELPERS]?: Promise<WorkerCleanupHelpers>;
  };
  globalState[WORKER_CLEANUP_HELPERS] ??= Promise.all([
    vi.importActual<typeof import("../src/agents/context-runtime-state.js")>(
      "../src/agents/context-runtime-state.js",
    ),
    vi.importActual<typeof import("../src/agents/models-config-state.js")>(
      "../src/agents/models-config-state.js",
    ),
    vi.importActual<typeof import("../src/agents/session-write-lock.js")>(
      "../src/agents/session-write-lock.js",
    ),
    vi.importActual<typeof import("../src/config/sessions/store-cache.js")>(
      "../src/config/sessions/store-cache.js",
    ),
    vi.importActual<typeof import("../src/config/sessions/store-writer-state.js")>(
      "../src/config/sessions/store-writer-state.js",
    ),
    vi.importActual<typeof import("../src/infra/file-lock.js")>("../src/infra/file-lock.js"),
  ]).then(
    ([
      contextRuntimeState,
      modelsConfigState,
      sessionWriteLock,
      sessionStoreCache,
      sessionStoreWriterState,
      fileLock,
    ]) => ({
      clearSessionStoreCaches: sessionStoreCache.clearSessionStoreCaches,
      drainFileLockStateForTest: fileLock.drainFileLockStateForTest,
      drainSessionStoreWriterQueuesForTest:
        sessionStoreWriterState.drainSessionStoreWriterQueuesForTest,
      drainSessionWriteLockStateForTest: sessionWriteLock.drainSessionWriteLockStateForTest,
      resetContextWindowCacheForTest: contextRuntimeState.resetContextWindowCacheForTest,
      resetFileLockStateForTest: fileLock.resetFileLockStateForTest,
      resetModelsJsonReadyCacheForTest: modelsConfigState.resetModelsJsonReadyCacheForTest,
      resetSessionWriteLockStateForTest: sessionWriteLock.resetSessionWriteLockStateForTest,
    }),
  );
  return globalState[WORKER_CLEANUP_HELPERS];
}

const pickSendFn = (id: ChannelId, deps?: OutboundSendDeps) => {
  return deps?.[id] as ((...args: unknown[]) => Promise<unknown>) | undefined;
};

function createTopLevelChannelReplyToModeResolverForTest(channelId: string): ReplyToModeResolver {
  return ({ cfg }) => {
    const channelConfig = (
      cfg.channels as Record<string, { replyToMode?: "off" | "first" | "all" }> | undefined
    )?.[channelId];
    return channelConfig?.replyToMode ?? "off";
  };
}

function createTestRegistryForSetup(
  channels: Array<{ pluginId: string; plugin: ChannelPlugin; source: string }> = [],
): PluginRegistry {
  return {
    plugins: [],
    tools: [],
    hooks: [],
    typedHooks: [],
    channels: channels as unknown as PluginRegistry["channels"],
    channelSetups: channels.map((entry) => ({
      pluginId: entry.pluginId,
      plugin: entry.plugin,
      source: entry.source,
      enabled: true,
    })),
    providers: [],
    speechProviders: [],
    realtimeTranscriptionProviders: [],
    realtimeVoiceProviders: [],
    mediaUnderstandingProviders: [],
    imageGenerationProviders: [],
    videoGenerationProviders: [],
    webFetchProviders: [],
    webSearchProviders: [],
    migrationProviders: [],
    memoryEmbeddingProviders: [],
    gatewayHandlers: {},
    gatewayMethodScopes: {},
    httpRoutes: [],
    cliRegistrars: [],
    reloads: [],
    nodeHostCommands: [],
    securityAuditCollectors: [],
    services: [],
    gatewayDiscoveryServices: [],
    commands: [],
    conversationBindingResolvedHandlers: [],
    diagnostics: [],
  };
}

function resolveSlackStubReplyToMode(params: {
  cfg: OpenClawConfig;
  chatType?: string | null;
}): "off" | "first" | "all" {
  const entry = (
    params.cfg.channels as
      | Record<
          string,
          {
            replyToMode?: "off" | "first" | "all";
            replyToModeByChatType?: Partial<
              Record<"direct" | "group" | "channel", "off" | "first" | "all">
            >;
            dm?: { replyToMode?: "off" | "first" | "all" };
          }
        >
      | undefined
  )?.slack;
  const normalizedChatType = params.chatType?.trim().toLowerCase();
  if (
    normalizedChatType === "direct" ||
    normalizedChatType === "group" ||
    normalizedChatType === "channel"
  ) {
    const byChatType = entry?.replyToModeByChatType?.[normalizedChatType];
    if (byChatType) {
      return byChatType;
    }
    if (normalizedChatType === "direct" && entry?.dm?.replyToMode) {
      return entry.dm.replyToMode;
    }
  }
  return entry?.replyToMode ?? "off";
}

const createStubOutbound = (
  id: ChannelId,
  deliveryMode: ChannelOutboundAdapter["deliveryMode"] = "direct",
): ChannelOutboundAdapter => ({
  deliveryMode,
  sendText: async ({ deps, to, text }) => {
    const send = pickSendFn(id, deps);
    if (send) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = (await send(to, text, { verbose: false } as any)) as {
        messageId: string;
      };
      return { channel: id, ...result };
    }
    return { channel: id, messageId: "test" };
  },
  sendMedia: async ({ deps, to, text, mediaUrl }) => {
    const send = pickSendFn(id, deps);
    if (send) {
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = (await send(to, text, { verbose: false, mediaUrl } as any)) as {
        messageId: string;
      };
      return { channel: id, ...result };
    }
    return { channel: id, messageId: "test" };
  },
});

const createStubPlugin = (params: {
  id: ChannelId;
  label?: string;
  aliases?: string[];
  deliveryMode?: ChannelOutboundAdapter["deliveryMode"];
  preferSessionLookupForAnnounceTarget?: boolean;
  resolveReplyToMode?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    chatType?: string | null;
  }) => "off" | "first" | "all";
}): ChannelPlugin => ({
  id: params.id,
  meta: {
    id: params.id,
    label: params.label ?? String(params.id),
    selectionLabel: params.label ?? String(params.id),
    docsPath: `/channels/${params.id}`,
    blurb: "test stub.",
    aliases: params.aliases,
    preferSessionLookupForAnnounceTarget: params.preferSessionLookupForAnnounceTarget,
  },
  capabilities: { chatTypes: ["direct", "group"] },
  threading: params.resolveReplyToMode
    ? {
        resolveReplyToMode: params.resolveReplyToMode,
      }
    : undefined,
  config: {
    listAccountIds: (cfg: OpenClawConfig) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      const entry = channels?.[params.id];
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const accounts = (entry as { accounts?: Record<string, unknown> }).accounts;
      const ids = accounts ? Object.keys(accounts).filter(Boolean) : [];
      return ids.length > 0 ? ids : ["default"];
    },
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      const entry = channels?.[params.id];
      if (!entry || typeof entry !== "object") {
        return {};
      }
      const accounts = (entry as { accounts?: Record<string, unknown> }).accounts;
      const match = accountId ? accounts?.[accountId] : undefined;
      return (match && typeof match === "object") || typeof match === "string" ? match : entry;
    },
    isConfigured: async (_account, cfg: OpenClawConfig) => {
      const channels = cfg.channels as Record<string, unknown> | undefined;
      return Boolean(channels?.[params.id]);
    },
  },
  outbound: createStubOutbound(params.id, params.deliveryMode),
});

const createDefaultRegistry = () =>
  createTestRegistryForSetup([
    {
      pluginId: "discord",
      plugin: createStubPlugin({
        id: "discord",
        label: "Discord",
        resolveReplyToMode: createTopLevelChannelReplyToModeResolverForTest("discord"),
      }),
      source: "test",
    },
    {
      pluginId: "slack",
      plugin: createStubPlugin({
        id: "slack",
        label: "Slack",
        resolveReplyToMode: ({ cfg, chatType }) => resolveSlackStubReplyToMode({ cfg, chatType }),
      }),
      source: "test",
    },
    {
      pluginId: "telegram",
      plugin: {
        ...createStubPlugin({
          id: "telegram",
          label: "Telegram",
          resolveReplyToMode: createTopLevelChannelReplyToModeResolverForTest("telegram"),
        }),
        status: {
          buildChannelSummary: async () => ({
            configured: false,
            tokenSource: process.env.TELEGRAM_BOT_TOKEN ? "env" : "none",
          }),
        },
      },
      source: "test",
    },
    {
      pluginId: "whatsapp",
      plugin: createStubPlugin({
        id: "whatsapp",
        label: "WhatsApp",
        deliveryMode: "gateway",
        preferSessionLookupForAnnounceTarget: true,
      }),
      source: "test",
    },
    {
      pluginId: "signal",
      plugin: createStubPlugin({ id: "signal", label: "Signal" }),
      source: "test",
    },
    {
      pluginId: "imessage",
      plugin: createStubPlugin({ id: "imessage", label: "iMessage", aliases: ["imsg"] }),
      source: "test",
    },
  ]);

function getDefaultPluginRegistry(): PluginRegistry {
  workerRuntimeState.materializedDefaultPluginRegistry ??= createDefaultRegistry();
  return workerRuntimeState.materializedDefaultPluginRegistry;
}

function resolveDefaultPluginRegistryProxy(): PluginRegistry {
  workerRuntimeState.defaultPluginRegistry ??= new Proxy({} as PluginRegistry, {
    defineProperty(_target, property, attributes) {
      return Reflect.defineProperty(getDefaultPluginRegistry() as object, property, attributes);
    },
    deleteProperty(_target, property) {
      return Reflect.deleteProperty(getDefaultPluginRegistry() as object, property);
    },
    get(_target, property, receiver) {
      return Reflect.get(getDefaultPluginRegistry() as object, property, receiver);
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(getDefaultPluginRegistry() as object, property);
    },
    has(_target, property) {
      return Reflect.has(getDefaultPluginRegistry() as object, property);
    },
    ownKeys() {
      return Reflect.ownKeys(getDefaultPluginRegistry() as object);
    },
    set(_target, property, value, receiver) {
      return Reflect.set(getDefaultPluginRegistry() as object, property, value, receiver);
    },
  });
  return workerRuntimeState.defaultPluginRegistry;
}

async function installDefaultPluginRegistry(): Promise<void> {
  const { resetPluginRuntimeStateForTest, setActivePluginRegistry } =
    await loadWorkerPluginRuntimeHelpers();
  workerRuntimeState.materializedDefaultPluginRegistry = null;
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(resolveDefaultPluginRegistryProxy());
}

// Some suites import channel/plugin consumers at module top level, before
// Vitest runs hooks. Seed the lazy registry during setup module evaluation so
// import-time lookups still see the default test registry.
await installDefaultPluginRegistry();

beforeAll(async () => {
  await installDefaultPluginRegistry();
});

afterEach(async () => {
  const {
    clearSessionStoreCaches,
    drainFileLockStateForTest,
    drainSessionStoreWriterQueuesForTest,
    drainSessionWriteLockStateForTest,
    resetContextWindowCacheForTest,
    resetFileLockStateForTest,
    resetModelsJsonReadyCacheForTest,
    resetSessionWriteLockStateForTest,
  } = await loadWorkerCleanupHelpers();
  await drainSessionStoreWriterQueuesForTest();
  clearSessionStoreCaches();
  await drainFileLockStateForTest();
  await drainSessionWriteLockStateForTest();
  resetFileLockStateForTest();
  resetContextWindowCacheForTest();
  resetModelsJsonReadyCacheForTest();
  resetSessionWriteLockStateForTest();
  await installDefaultPluginRegistry();
});

afterAll(async () => {
  const { clearSessionStoreCaches, drainFileLockStateForTest, drainSessionWriteLockStateForTest } =
    await loadWorkerCleanupHelpers();
  clearSessionStoreCaches();
  await drainFileLockStateForTest();
  await drainSessionWriteLockStateForTest();
});
