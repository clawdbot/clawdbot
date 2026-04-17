import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { createChannelConversationBindingManager } from "../../../src/channels/plugins/conversation-bindings.js";
import type { ChannelPlugin } from "../../../src/channels/plugins/types.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import {
  getSessionBindingService,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../src/infra/outbound/session-binding-service.js";
import { setActivePluginRegistry } from "../../../src/plugins/runtime.js";
import { createTestRegistry } from "../../../src/test-utils/channel-plugins.js";
import {
  sessionBindingContractChannelIds,
  type SessionBindingContractChannelId,
} from "./manifest.js";
import { importBundledChannelContractArtifact } from "./runtime-artifacts.js";
import "../../../src/channels/plugins/registry.js";

type SessionBindingContractEntry = {
  id: string;
  expectedCapabilities: SessionBindingCapabilities;
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
  beforeEach?: () => Promise<void> | void;
};
const contractApiPromises = new Map<string, Promise<Record<string, unknown>>>();

const matrixSessionBindingStateDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "openclaw-matrix-session-binding-contract-"),
);
const matrixSessionBindingAuth = {
  accountId: "ops",
  homeserver: "https://matrix.example.org",
  userId: "@bot:example.org",
  accessToken: "token",
} as const;

async function getContractApi<T extends Record<string, unknown>>(pluginId: string): Promise<T> {
  const existing = contractApiPromises.get(pluginId);
  if (existing) {
    return (await existing) as T;
  }
  const next = importBundledChannelContractArtifact<T>(pluginId, "contract-api");
  contractApiPromises.set(pluginId, next);
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
  fs.rmSync(matrixSessionBindingStateDir, { recursive: true, force: true });
  fs.mkdirSync(matrixSessionBindingStateDir, { recursive: true });
}

async function createContractMatrixThreadBindingManager() {
  resetMatrixSessionBindingStateDir();
  const { setMatrixRuntime, createMatrixThreadBindingManager } =
    await getContractApi<MatrixContractApi>("matrix");
  setMatrixRuntime({
    state: {
      resolveStateDir: () => matrixSessionBindingStateDir,
    },
  } as never);
  return await createMatrixThreadBindingManager({
    accountId: matrixSessionBindingAuth.accountId,
    auth: matrixSessionBindingAuth,
    client: {} as never,
    idleTimeoutMs: 24 * 60 * 60 * 1000,
    maxAgeMs: 0,
    enableSweeper: false,
  });
}

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

type ChannelConversationBindingManagerFactory = NonNullable<
  NonNullable<ChannelPlugin["conversationBindings"]>["createManager"]
>;

type BlueBubblesContractApi = {
  blueBubblesConversationBindingTesting: {
    resetBlueBubblesConversationBindingsForTests: () => void;
  };
  createBlueBubblesConversationBindingManager: ChannelConversationBindingManagerFactory;
};

type DiscordContractApi = {
  createThreadBindingManager: (params: {
    accountId: string;
    cfg?: OpenClawConfig;
    persist: boolean;
    enableSweeper: boolean;
  }) => unknown;
  discordThreadBindingTesting: {
    resetThreadBindingsForTests: () => void;
  };
};

type FeishuContractApi = {
  createFeishuThreadBindingManager: (params: {
    accountId?: string;
    cfg: OpenClawConfig;
  }) => unknown;
  feishuThreadBindingTesting: {
    resetFeishuThreadBindingsForTests: () => void;
  };
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
  }) => Promise<unknown>;
  resetMatrixThreadBindingsForTests: () => void;
  setMatrixRuntime: (runtime: unknown) => void;
};

type TelegramContractApi = {
  createTelegramThreadBindingManager: (params: {
    accountId: string;
    persist: boolean;
    enableSweeper: boolean;
  }) => unknown;
  resetTelegramThreadBindingsForTests: () => Promise<void>;
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

async function prepareBlueBubblesSessionBindingContract() {
  const api = await getContractApi<BlueBubblesContractApi>("bluebubbles");
  api.blueBubblesConversationBindingTesting.resetBlueBubblesConversationBindingsForTests();
  setRegistryBackedConversationBindingPlugin({
    id: "bluebubbles",
    createManager: api.createBlueBubblesConversationBindingManager,
  });
}

async function prepareDiscordSessionBindingContract() {
  const api = await getContractApi<DiscordContractApi>("discord");
  api.discordThreadBindingTesting.resetThreadBindingsForTests();
}

async function prepareFeishuSessionBindingContract() {
  const api = await getContractApi<FeishuContractApi>("feishu");
  api.feishuThreadBindingTesting.resetFeishuThreadBindingsForTests();
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
  const api = await getContractApi<MatrixContractApi>("matrix");
  api.resetMatrixThreadBindingsForTests();
}

async function prepareTelegramSessionBindingContract() {
  const api = await getContractApi<TelegramContractApi>("telegram");
  await api.resetTelegramThreadBindingsForTests();
}

const sessionBindingContractEntries: Record<
  SessionBindingContractChannelId,
  Omit<SessionBindingContractEntry, "id">
> = {
  bluebubbles: {
    beforeEach: prepareBlueBubblesSessionBindingContract,
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      void createChannelConversationBindingManager({
        channelId: "bluebubbles",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      return getSessionBindingService().getCapabilities({
        channel: "bluebubbles",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      await createChannelConversationBindingManager({
        channelId: "bluebubbles",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:codex:acp:binding:bluebubbles:default:abc123",
        targetKind: "session",
        conversation: {
          channel: "bluebubbles",
          accountId: "default",
          conversationId: "+15555550123",
        },
        placement: "current",
        metadata: {
          agentId: "codex",
          label: "codex-main",
        },
      });
      expectResolvedSessionBinding({
        channel: "bluebubbles",
        accountId: "default",
        conversationId: "+15555550123",
        targetSessionKey: "agent:codex:acp:binding:bluebubbles:default:abc123",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = await createChannelConversationBindingManager({
        channelId: "bluebubbles",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
      expectClearedSessionBinding({
        channel: "bluebubbles",
        accountId: "default",
        conversationId: "+15555550123",
      });
    },
  },
  discord: {
    beforeEach: prepareDiscordSessionBindingContract,
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: async () => {
      const { createThreadBindingManager } = await getContractApi<DiscordContractApi>("discord");
      createThreadBindingManager({
        accountId: "default",
        cfg: baseSessionBindingCfg,
        persist: false,
        enableSweeper: false,
      });
      return getSessionBindingService().getCapabilities({
        channel: "discord",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      const { createThreadBindingManager } = await getContractApi<DiscordContractApi>("discord");
      createThreadBindingManager({
        accountId: "default",
        cfg: baseSessionBindingCfg,
        persist: false,
        enableSweeper: false,
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:discord:child:thread-1",
        targetKind: "subagent",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:123456789012345678",
        },
        placement: "current",
        metadata: {
          agentId: "discord",
          label: "discord-child",
        },
      });
      expectResolvedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
        targetSessionKey: "agent:discord:child:thread-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      expectClearedSessionBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123456789012345678",
      });
    },
  },
  feishu: {
    beforeEach: prepareFeishuSessionBindingContract,
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: async () => {
      const { createFeishuThreadBindingManager } =
        await getContractApi<FeishuContractApi>("feishu");
      createFeishuThreadBindingManager({
        accountId: "default",
        cfg: baseSessionBindingCfg,
      });
      return getSessionBindingService().getCapabilities({
        channel: "feishu",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      const { createFeishuThreadBindingManager } =
        await getContractApi<FeishuContractApi>("feishu");
      createFeishuThreadBindingManager({
        accountId: "default",
        cfg: baseSessionBindingCfg,
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:feishu:child:thread-1",
        targetKind: "subagent",
        conversation: {
          channel: "feishu",
          accountId: "default",
          conversationId: "oc_group_chat:topic:om_topic_root",
          parentConversationId: "oc_group_chat",
        },
        placement: "current",
        metadata: {
          agentId: "feishu",
          label: "feishu-child",
        },
      });
      expectResolvedSessionBinding({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
        parentConversationId: "oc_group_chat",
        targetSessionKey: "agent:feishu:child:thread-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      expectClearedSessionBinding({
        channel: "feishu",
        accountId: "default",
        conversationId: "oc_group_chat:topic:om_topic_root",
      });
    },
  },
  imessage: {
    beforeEach: prepareIMessageSessionBindingContract,
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    },
    getCapabilities: () => {
      void createChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      return getSessionBindingService().getCapabilities({
        channel: "imessage",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      await createChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:imessage:current",
        targetKind: "session",
        conversation: {
          channel: "imessage",
          accountId: "default",
          conversationId: "+15555550124",
        },
        placement: "current",
        metadata: {
          agentId: "imessage",
          label: "imessage-main",
        },
      });
      expectResolvedSessionBinding({
        channel: "imessage",
        accountId: "default",
        conversationId: "+15555550124",
        targetSessionKey: "agent:imessage:current",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      const manager = await createChannelConversationBindingManager({
        channelId: "imessage",
        cfg: baseSessionBindingCfg,
        accountId: "default",
      });
      await manager?.stop();
      expectClearedSessionBinding({
        channel: "imessage",
        accountId: "default",
        conversationId: "+15555550124",
      });
    },
  },
  matrix: {
    beforeEach: prepareMatrixSessionBindingContract,
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: async () => {
      await createContractMatrixThreadBindingManager();
      return getSessionBindingService().getCapabilities({
        channel: "matrix",
        accountId: matrixSessionBindingAuth.accountId,
      });
    },
    bindAndResolve: async () => {
      await createContractMatrixThreadBindingManager();
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:matrix:thread",
        targetKind: "subagent",
        conversation: {
          channel: "matrix",
          accountId: matrixSessionBindingAuth.accountId,
          conversationId: "$thread",
          parentConversationId: "!room:example.org",
        },
        placement: "current",
        metadata: {
          agentId: "matrix",
          label: "matrix-thread",
        },
      });
      expectResolvedSessionBinding({
        channel: "matrix",
        accountId: matrixSessionBindingAuth.accountId,
        conversationId: "$thread",
        parentConversationId: "!room:example.org",
        targetSessionKey: "agent:matrix:thread",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      expectClearedSessionBinding({
        channel: "matrix",
        accountId: matrixSessionBindingAuth.accountId,
        conversationId: "$thread",
      });
    },
  },
  telegram: {
    beforeEach: prepareTelegramSessionBindingContract,
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    },
    getCapabilities: async () => {
      const { createTelegramThreadBindingManager } =
        await getContractApi<TelegramContractApi>("telegram");
      createTelegramThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      return getSessionBindingService().getCapabilities({
        channel: "telegram",
        accountId: "default",
      });
    },
    bindAndResolve: async () => {
      const { createTelegramThreadBindingManager } =
        await getContractApi<TelegramContractApi>("telegram");
      createTelegramThreadBindingManager({
        accountId: "default",
        persist: false,
        enableSweeper: false,
      });
      const service = getSessionBindingService();
      const binding = await service.bind({
        targetSessionKey: "agent:telegram:child:thread-1",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100200300:topic:77",
        },
        placement: "current",
        metadata: {
          agentId: "telegram",
          label: "telegram-topic",
        },
      });
      expectResolvedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
        targetSessionKey: "agent:telegram:child:thread-1",
      });
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      expectClearedSessionBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "-100200300:topic:77",
      });
    },
  },
};

let sessionBindingContractRegistryCache: SessionBindingContractEntry[] | undefined;

export function getSessionBindingContractRegistry(): SessionBindingContractEntry[] {
  sessionBindingContractRegistryCache ??= sessionBindingContractChannelIds.map((id) => ({
    id,
    ...sessionBindingContractEntries[id],
  }));
  return sessionBindingContractRegistryCache;
}
