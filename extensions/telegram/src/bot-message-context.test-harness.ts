import { createHash } from "node:crypto";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import type { BuildTelegramMessageContextParams, TelegramMediaRef } from "./bot-message-context.js";
import { setTelegramTopicNameStoreFactoryForTest } from "./topic-name-cache.js";

export const baseTelegramMessageContextConfig = {
  agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
  channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
  messages: { groupChat: { mentionPatterns: [] } },
} as never;

type TelegramTestSessionRuntime = NonNullable<BuildTelegramMessageContextParams["sessionRuntime"]>;
type TopicNameEntryForTest = {
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

type BuildTelegramMessageContextForTestParams = {
  message: Record<string, unknown>;
  me?: Record<string, unknown>;
  allMedia?: TelegramMediaRef[];
  options?: BuildTelegramMessageContextParams["options"];
  cfg?: Record<string, unknown>;
  accountId?: string;
  dmPolicy?: BuildTelegramMessageContextParams["dmPolicy"];
  historyLimit?: number;
  groupHistories?: Map<string, import("openclaw/plugin-sdk/reply-history").HistoryEntry[]>;
  ackReactionScope?: BuildTelegramMessageContextParams["ackReactionScope"];
  botApi?: Record<string, unknown>;
  sendChatActionHandler?: BuildTelegramMessageContextParams["sendChatActionHandler"];
  runtime?: BuildTelegramMessageContextParams["runtime"];
  sessionRuntime?: BuildTelegramMessageContextParams["sessionRuntime"] | null;
  resolveGroupActivation?: BuildTelegramMessageContextParams["resolveGroupActivation"];
  resolveGroupRequireMention?: BuildTelegramMessageContextParams["resolveGroupRequireMention"];
  resolveTelegramGroupConfig?: BuildTelegramMessageContextParams["resolveTelegramGroupConfig"];
};

const telegramTopicNameStoresForTest = new Map<string, Map<string, TopicNameEntryForTest>>();

function resolveSessionStorePathForTest(testName: string | undefined): string {
  const hash = createHash("sha256")
    .update(`${process.pid}:${testName ?? "unknown"}`)
    .digest("hex")
    .slice(0, 16);
  return `/tmp/openclaw/session-store-${hash}.json`;
}

function createTelegramMessageContextSessionRuntimeForTest(
  storePath: string,
): TelegramTestSessionRuntime {
  return {
    buildChannelInboundEventContext,
    readSessionUpdatedAt: () => undefined,
    recordInboundSession: async () => undefined,
    resolveInboundLastRouteSessionKey: ({ route, sessionKey }) =>
      route.lastRoutePolicy === "main" ? route.mainSessionKey : sessionKey,
    resolvePinnedMainDmOwnerFromAllowlist: () => null,
    resolveStorePath: () => storePath,
  };
}

function installTelegramTopicNameStoreForTest() {
  setTelegramTopicNameStoreFactoryForTest((namespace) => {
    const entries = telegramTopicNameStoresForTest.get(namespace) ?? new Map();
    telegramTopicNameStoresForTest.set(namespace, entries);
    return {
      async register(key, value) {
        entries.set(key, value);
      },
      async entries() {
        return Array.from(entries, ([key, value]) => ({ key, value }));
      },
      async delete(key) {
        return entries.delete(key);
      },
      async clear() {
        entries.clear();
      },
    };
  });
}

export async function buildTelegramMessageContextForTest(
  params: BuildTelegramMessageContextForTestParams,
): Promise<
  Awaited<ReturnType<typeof import("./bot-message-context.js").buildTelegramMessageContext>>
> {
  const { expect, vi } = await loadVitestModule();
  const buildTelegramMessageContext = await loadBuildTelegramMessageContext();
  const sessionRuntime =
    params.sessionRuntime === null
      ? undefined
      : {
          ...createTelegramMessageContextSessionRuntimeForTest(
            resolveSessionStorePathForTest(expect.getState().currentTestName),
          ),
          ...params.sessionRuntime,
        };
  return await buildTelegramMessageContext({
    primaryCtx: {
      message: {
        message_id: 1,
        date: 1_700_000_000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
        ...params.message,
      },
      me: { id: 7, username: "bot", ...params.me },
    } as never,
    allMedia: params.allMedia ?? [],
    storeAllowFrom: [],
    options: params.options ?? {},
    bot: {
      api: {
        sendChatAction: vi.fn(),
        setMessageReaction: vi.fn(),
        ...params.botApi,
      },
    } as never,
    cfg: (params.cfg ?? baseTelegramMessageContextConfig) as never,
    loadFreshConfig: () => (params.cfg ?? baseTelegramMessageContextConfig) as never,
    runtime: {
      recordChannelActivity: () => undefined,
      ...params.runtime,
    },
    sessionRuntime,
    account: { accountId: params.accountId ?? "default" } as never,
    historyLimit: params.historyLimit ?? 0,
    groupHistories: params.groupHistories ?? new Map(),
    dmPolicy: params.dmPolicy ?? "open",
    allowFrom: ["*"],
    groupAllowFrom: [],
    ackReactionScope: params.ackReactionScope ?? "off",
    logger: { info: vi.fn() },
    resolveGroupActivation: params.resolveGroupActivation ?? (() => undefined),
    resolveGroupRequireMention: params.resolveGroupRequireMention ?? (() => false),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      (() => ({
        groupConfig: { requireMention: false },
        topicConfig: undefined,
      })),
    sendChatActionHandler: params.sendChatActionHandler ?? ({ sendChatAction: vi.fn() } as never),
  });
}

let buildTelegramMessageContextLoader:
  | typeof import("./bot-message-context.js").buildTelegramMessageContext
  | undefined;
let vitestModuleLoader: Promise<typeof import("vitest")> | undefined;
let messageContextMocksInstalled = false;

async function loadBuildTelegramMessageContext() {
  await installMessageContextTestMocks();
  if (!buildTelegramMessageContextLoader) {
    ({ buildTelegramMessageContext: buildTelegramMessageContextLoader } =
      await import("./bot-message-context.js"));
  }
  return buildTelegramMessageContextLoader;
}

async function loadVitestModule() {
  vitestModuleLoader ??= import("vitest");
  return await vitestModuleLoader;
}

async function installMessageContextTestMocks() {
  installTelegramTopicNameStoreForTest();
  if (messageContextMocksInstalled) {
    return;
  }
  messageContextMocksInstalled = true;
}
