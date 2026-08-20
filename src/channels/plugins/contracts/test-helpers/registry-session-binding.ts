/**
 * Session binding contract registry fixtures.
 *
 * Builds bundled channel binding contract entries and hermetic plugin-state stores.
 */
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../../../config/config.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../../../infra/outbound/session-binding-service.js";
import type { SessionBindingCapabilities } from "../../../../infra/outbound/session-binding.types.js";
import { resolvePreferredOpenClawTmpDir } from "../../../../infra/tmp-openclaw-dir.js";
import type { OpenKeyedStoreOptions } from "../../../../plugin-sdk/plugin-state-runtime.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../../../../plugin-sdk/plugin-state-test-runtime.js";
import { setActivePluginRegistry } from "../../../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../../test-utils/channel-plugins.js";
import { getChannelPlugin } from "../../registry.js";
import type { ChannelPlugin } from "../../types.public.js";
import {
  sessionBindingContractChannelIds,
  type SessionBindingContractChannelId,
} from "./manifest.js";
import { importBundledChannelContractArtifact } from "./runtime-artifacts.js";

type SessionBindingContractEntry = {
  id: string;
  expectedCapabilities: SessionBindingCapabilities;
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
  preload?: () => Promise<void> | void;
  beforeEach?: () => Promise<void> | void;
};
const contractApiPromises = new Map<string, Promise<Record<string, unknown>>>();

async function createContractChannelConversationBindingManager(params: {
  channelId: Parameters<typeof getChannelPlugin>[0];
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<{ stop: () => void | Promise<void> } | null> {
  const createManager = getChannelPlugin(params.channelId)?.conversationBindings?.createManager;
  return createManager
    ? await createManager({ cfg: params.cfg, accountId: params.accountId })
    : null;
}

const matrixSessionBindingStateDir = fs.mkdtempSync(
  path.join(resolvePreferredOpenClawTmpDir(), "openclaw-matrix-session-binding-contract-"),
);
const matrixSessionBindingAuth = {
  accountId: "ops",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "token",
} as const;

async function getContractApi<T extends Record<string, unknown>>(
  pluginId: string,
  artifact = "session-binding-contract-api",
): Promise<T> {
  const cacheKey = `${pluginId}:${artifact}`;
  const existing = contractApiPromises.get(cacheKey);
  if (existing) {
    return (await existing) as T;
  }
  const next = importBundledChannelContractArtifact<T>(pluginId, artifact);
  contractApiPromises.set(cacheKey, next);
  return await next;
}

function expectResolvedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    }),
  )?.toMatchObject({
    targetSessionKey: params.targetSessionKey,
  });
}

async function unbindAndExpectClearedSessionBinding(binding: SessionBindingRecord) {
  const service = getSessionBindingService();
  const removed = await service.unbind({
    bindingId: binding.bindingId,
    reason: "contract-test",
  });
  expect(removed.map((entry) => entry.bindingId)).toContain(binding.bindingId);
  expect(service.resolveByConversation(binding.conversation)).toBeNull();
}

function expectClearedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
    }),
  ).toBeNull();
}

function resetMatrixSessionBindingStateDir() {
  resetPluginStateStoreForTests();
  fs.rmSync(matrixSessionBindingStateDir, { recursive: true, force: true });
  fs.mkdirSync(matrixSessionBindingStateDir, { recursive: true });
}

async function createContractMatrixThreadBindingManager() {
  if (matrixSessionBindingManager) {
    return matrixSessionBindingManager;
  }
  const { setMatrixRuntime, createMatrixThreadBindingManager } =
    await getContractApi<MatrixContractApi>("matrix");
  setMatrixRuntime({
    state: {
      openKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests("matrix", options),
      resolveStateDir: () => matrixSessionBindingStateDir,
    },
  } as never);
  const manager = await createMatrixThreadBindingManager({
    accountId: matrixSessionBindingAuth.accountId,
    auth: matrixSessionBindingAuth,
    client: {} as never,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    maxAgeMs: 0,
    enableSweeper: false,
  });
  matrixSessionBindingManager = manager;
  return manager;
}

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

type ChannelConversationBindingManagerFactory = NonNullable<
  NonNullable<ChannelPlugin["conversationBindings"]>["createManager"]
>;
type ChannelConversationBindingManager = Awaited<
  ReturnType<ChannelConversationBindingManagerFactory>
>;
let discordSessionBindingManager: ChannelConversationBindingManager | null = null;
let feishuSessionBindingManager: ChannelConversationBindingManager | null = null;
let matrixSessionBindingManager: ChannelConversationBindingManager | null = null;
let telegramSessionBindingManager: ChannelConversationBindingManager | null = null;

type DiscordContractApi = {
  discordPlugin: ChannelPlugin;
};

type FeishuContractApi = {
  createFeishuThreadBindingManager: (params: {
    accountId?: string;
    cfg: OpenClawConfig;
  }) => ChannelConversationBindingManager;
};

type IMessageContractApi = {
  createIMessageConversationBindingManager: ChannelConversationBindingManagerFactory;
  imessageConversationBindingTesting: {
    resetIMessageConversationBindingsForTests: () => void;
  };
};

type MatrixContractApi = {
  createMatrixThreadBindingManager: (params: {
    accountId: string;
    auth: typeof matrixSessionBindingAuth;
    client: unknown;
    idleTimeoutMs: number;
    maxAgeMs: number;
    enableSweeper: boolean;
  }) => Promise<ChannelConversationBindingManager>;
  setMatrixRuntime: (runtime: unknown) => void;
};

type TelegramContractApi = {
  telegramPlugin: ChannelPlugin;
};

function setRegistryBackedConversationBindingPlugin(params: {
  id: SessionBindingContractChannelId;
  createManager: ChannelConversationBindingManagerFactory;
}) {
  const plugin = {
    id: params.id,
    meta: {
      id: params.id,
      label: params.id,
      selectionLabel: params.id,
      blurb: "session binding contract fixture",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
    },
    conversationBindings: {
      supportsCurrentConversationBinding: true,
      createManager: params.createManager,
    },
  } as unknown as ChannelPlugin;
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: params.id,
        plugin,
        source: "test",
      },
    ]),
  );
}

async function getDiscordContractApi() {
  return await getContractApi<DiscordContractApi>("discord", "channel-plugin-api");
}

async function getTelegramContractApi() {
  return await loadBundledPluginFacade<TelegramContractApi>({
    pluginId: "telegram",
    artifactBasename: "channel-plugin-api.js",
  });
}

async function stopDiscordSessionBindingManager() {
  await discordSessionBindingManager?.stop();
  discordSessionBindingManager = null;
}

async function stopFeishuSessionBindingManager() {
  await feishuSessionBindingManager?.stop();
  feishuSessionBindingManager = null;
}

async function stopMatrixSessionBindingManager() {
  await matrixSessionBindingManager?.stop();
  matrixSessionBindingManager = null;
}

async function stopTelegramSessionBindingManager() {
  await telegramSessionBindingManager?.stop();
  telegramSessionBindingManager = null;
}

async function prepareDiscordSessionBindingContract() {
  await stopDiscordSessionBindingManager();
  const { discordPlugin } = await getDiscordContractApi();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        plugin: discordPlugin,
        source: "test",
      },
    ]),
  );
}

async function prepareFeishuSessionBindingContract() {
  await stopFeishuSessionBindingManager();
}

async function prepareIMessageSessionBindingContract() {
  const api = await getContractApi<IMessageContractApi>("imessage");
  api.imessageConversationBindingTesting.resetIMessageConversationBindingsForTests();
  setRegistryBackedConversationBindingPlugin({
    id: "imessage",
    createManager: api.createIMessageConversationBindingManager,
  });
}

async function prepareMatrixSessionBindingContract() {
  await stopMatrixSessionBindingManager();
  resetMatrixSessionBindingStateDir();
}

async function prepareTelegramSessionBindingContract() {
  await stopTelegramSessionBindingManager();
  const { telegramPlugin } = await getTelegramContractApi();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: telegramPlugin,
        source: "test",
      },
    ]),
  );
}

type SessionBindingContractFixture = {
  id: SessionBindingContractChannelId;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
  targetKind: SessionBindingRecord["targetKind"];
  label: string;
  placements: SessionBindingCapabilities["placements"];
  preload: () => Promise<unknown>;
  beforeEach: () => Promise<void>;
  ensureManager: () => Promise<void>;
  stopManager?: () => Promise<void>;
};

function createSessionBindingContractEntry(
  fixture: SessionBindingContractFixture,
): Omit<SessionBindingContractEntry, "id"> {
  const conversation = {
    channel: fixture.id,
    accountId: fixture.accountId,
    conversationId: fixture.conversationId,
    ...(fixture.parentConversationId ? { parentConversationId: fixture.parentConversationId } : {}),
  };

  return {
    preload: async () => {
      await fixture.preload();
    },
    beforeEach: fixture.beforeEach,
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: fixture.placements,
    },
    getCapabilities: async () => {
      await fixture.ensureManager();
      return getSessionBindingService().getCapabilities({
        channel: fixture.id,
        accountId: fixture.accountId,
      });
    },
    bindAndResolve: async () => {
      await fixture.ensureManager();
      const binding = await getSessionBindingService().bind({
        targetSessionKey: fixture.targetSessionKey,
        targetKind: fixture.targetKind,
        conversation,
        placement: "current",
        metadata: { agentId: fixture.id, label: fixture.label },
      });
      expectResolvedSessionBinding({
        ...conversation,
        targetSessionKey: fixture.targetSessionKey,
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      await fixture.stopManager?.();
      expectClearedSessionBinding(conversation);
    },
  };
}

const sessionBindingContractEntries = {
  discord: createSessionBindingContractEntry({
    id: "discord",
    accountId: "default",
    conversationId: "channel:123456789012345678",
    targetSessionKey: "agent:discord:child:thread-1",
    targetKind: "subagent",
    label: "discord-child",
    placements: ["current", "child"],
    preload: getDiscordContractApi,
    beforeEach: prepareDiscordSessionBindingContract,
    ensureManager: async () => {
      discordSessionBindingManager ??= await createContractChannelConversationBindingManager({
        channelId: "discord",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      if (!discordSessionBindingManager) {
        throw new Error("Discord session binding manager is unavailable");
      }
    },
    stopManager: stopDiscordSessionBindingManager,
  }),
  feishu: createSessionBindingContractEntry({
    id: "feishu",
    accountId: "default",
    conversationId: "oc_group_chat:topic:om_topic_root",
    parentConversationId: "oc_group_chat",
    targetSessionKey: "agent:feishu:child:thread-1",
    targetKind: "subagent",
    label: "feishu-child",
    placements: ["current"],
    preload: () => getContractApi<FeishuContractApi>("feishu"),
    beforeEach: prepareFeishuSessionBindingContract,
    ensureManager: async () => {
      const { createFeishuThreadBindingManager } =
        await getContractApi<FeishuContractApi>("feishu");
      feishuSessionBindingManager ??= createFeishuThreadBindingManager({
        accountId: "default",
        cfg: baseSessionBindingCfg,
      });
    },
    stopManager: stopFeishuSessionBindingManager,
  }),
  imessage: createSessionBindingContractEntry({
    id: "imessage",
    accountId: "default",
    conversationId: "+15555550124",
    targetSessionKey: "agent:imessage:current",
    targetKind: "session",
    label: "imessage-main",
    placements: ["current"],
    preload: () => getContractApi<IMessageContractApi>("imessage"),
    beforeEach: prepareIMessageSessionBindingContract,
    ensureManager: async () => {
      await createContractChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
    },
    stopManager: async () => {
      const manager = await createContractChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
    },
  }),
  matrix: createSessionBindingContractEntry({
    id: "matrix",
    accountId: matrixSessionBindingAuth.accountId,
    conversationId: "$thread",
    parentConversationId: "!room:example.org",
    targetSessionKey: "agent:matrix:thread",
    targetKind: "subagent",
    label: "matrix-thread",
    placements: ["current", "child"],
    preload: () => getContractApi<MatrixContractApi>("matrix"),
    beforeEach: prepareMatrixSessionBindingContract,
    ensureManager: async () => {
      await createContractMatrixThreadBindingManager();
    },
    stopManager: stopMatrixSessionBindingManager,
  }),
  telegram: createSessionBindingContractEntry({
    id: "telegram",
    accountId: "default",
    conversationId: "-100200300:topic:77",
    targetSessionKey: "agent:telegram:child:thread-1",
    targetKind: "subagent",
    label: "telegram-topic",
    placements: ["current", "child"],
    preload: getTelegramContractApi,
    beforeEach: prepareTelegramSessionBindingContract,
    ensureManager: async () => {
      telegramSessionBindingManager ??= await createContractChannelConversationBindingManager({
        channelId: "telegram",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      if (!telegramSessionBindingManager) {
        throw new Error("Telegram session binding manager is unavailable");
      }
    },
    stopManager: stopTelegramSessionBindingManager,
  }),
} satisfies Record<SessionBindingContractChannelId, Omit<SessionBindingContractEntry, "id">>;

let sessionBindingContractRegistryCache: SessionBindingContractEntry[] | undefined;

export function getSessionBindingContractRegistry(): SessionBindingContractEntry[] {
  sessionBindingContractRegistryCache ??= sessionBindingContractChannelIds.map((id) =>
    Object.assign({ id }, sessionBindingContractEntries[id]),
  );
  return sessionBindingContractRegistryCache;
}
