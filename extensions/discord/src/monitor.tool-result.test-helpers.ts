import type { Client } from "@buape/carbon";
import { ChannelType, MessageType } from "@buape/carbon";
import type { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { vi } from "vitest";
import {
  dispatchMock,
  installDiscordToolResultHarnessSpies,
  loadConfigMock,
  readAllowFromStoreMock,
  sendMock,
  TOOL_RESULT_SESSION_STORE_PATH,
  updateLastRouteMock,
  upsertPairingRequestMock,
} from "./monitor.tool-result.test-harness.js";
import { createDiscordMessageHandler } from "./monitor/message-handler.js";
import { __resetDiscordChannelInfoCacheForTest } from "./monitor/message-utils.js";
import { createNoopThreadBindingManager } from "./monitor/thread-bindings.js";

export type Config = ReturnType<typeof loadConfig>;

export const BASE_CFG: Config = {
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-5" },
      workspace: "/tmp/openclaw",
    },
  },
  messages: {
    inbound: { debounceMs: 0 },
  },
  session: { store: TOOL_RESULT_SESSION_STORE_PATH },
};

export const CATEGORY_GUILD_CFG = {
  ...BASE_CFG,
  channels: {
    discord: {
      dm: { enabled: true, policy: "open" },
      guilds: {
        "*": {
          requireMention: false,
          channels: { c1: { enabled: true } },
        },
      },
    },
  },
} satisfies Config;

export function resetDiscordToolResultHarness() {
  installDiscordToolResultHarnessSpies();
  __resetDiscordChannelInfoCacheForTest();
  sendMock.mockClear().mockResolvedValue(undefined);
  updateLastRouteMock.mockClear();
  dispatchMock.mockClear().mockImplementation(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text: "hi" });
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  });
  readAllowFromStoreMock.mockClear().mockResolvedValue([]);
  upsertPairingRequestMock.mockClear().mockResolvedValue({ code: "PAIRCODE", created: true });
  loadConfigMock.mockClear().mockReturnValue(BASE_CFG);
}

export function createHandlerBaseConfig(
  cfg: Config,
  runtimeError?: (err: unknown) => void,
): Parameters<typeof createDiscordMessageHandler>[0] {
  return {
    cfg,
    discordConfig: cfg.channels?.discord,
    accountId: "default",
    token: "token",
    runtime: {
      log: vi.fn(),
      error: runtimeError ?? vi.fn(),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    },
    botUserId: "bot-id",
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 10_000,
    textLimit: 2000,
    replyToMode: "off",
    dmEnabled: true,
    groupDmEnabled: false,
    threadBindings: createNoopThreadBindingManager("default"),
  };
}

export async function createDmHandler(params: {
  cfg: Config;
  runtimeError?: (err: unknown) => void;
}) {
  loadConfigMock.mockReturnValue(params.cfg);
  return createDiscordMessageHandler(createHandlerBaseConfig(params.cfg, params.runtimeError));
}

export async function createGuildHandler(params: {
  cfg: Config;
  guildEntries?: Parameters<typeof createDiscordMessageHandler>[0]["guildEntries"];
  runtimeError?: (err: unknown) => void;
}) {
  loadConfigMock.mockReturnValue(params.cfg);
  return createDiscordMessageHandler({
    ...createHandlerBaseConfig(params.cfg, params.runtimeError),
    guildEntries:
      params.guildEntries ??
      (params.cfg.channels?.discord?.guilds as Parameters<
        typeof createDiscordMessageHandler
      >[0]["guildEntries"]),
  });
}

export function createDmClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      type: ChannelType.DM,
      name: "dm",
    }),
  } as unknown as Client;
}

export async function createCategoryGuildHandler(runtimeError?: (err: unknown) => void) {
  return createGuildHandler({
    cfg: CATEGORY_GUILD_CFG,
    guildEntries: {
      "*": { requireMention: false, channels: { c1: { enabled: true } } },
    },
    runtimeError,
  });
}

export function createCategoryGuildClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      type: ChannelType.GuildText,
      name: "general",
      parentId: "category-1",
    }),
    rest: { get: vi.fn() },
  } as unknown as Client;
}

export function createCategoryGuildEvent(params: {
  messageId: string;
  timestamp?: string;
  author: Record<string, unknown>;
}) {
  return {
    message: {
      id: params.messageId,
      content: "hello",
      channelId: "c1",
      timestamp: params.timestamp ?? new Date().toISOString(),
      type: MessageType.Default,
      attachments: [],
      embeds: [],
      mentionedEveryone: false,
      mentionedUsers: [],
      mentionedRoles: [],
      author: params.author,
    },
    author: params.author,
    member: { displayName: "Ada" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
  };
}

export function createGuildTextClient() {
  return {
    fetchChannel: vi.fn().mockResolvedValue({
      id: "c1",
      type: ChannelType.GuildText,
      name: "general",
    }),
    rest: { get: vi.fn() },
  } as unknown as Client;
}

export function createGuildMessageEvent(params: {
  messageId: string;
  content: string;
  messagePatch?: Record<string, unknown>;
  eventPatch?: Record<string, unknown>;
}) {
  const messageBase = {
    timestamp: new Date().toISOString(),
    type: MessageType.Default,
    attachments: [],
    embeds: [],
    mentionedEveryone: false,
    mentionedUsers: [],
    mentionedRoles: [],
  };
  return {
    message: {
      id: params.messageId,
      content: params.content,
      channelId: "c1",
      ...messageBase,
      author: { id: "u1", bot: false, username: "Ada" },
      ...params.messagePatch,
    },
    author: { id: "u1", bot: false, username: "Ada" },
    member: { nickname: "Ada" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
    ...params.eventPatch,
  };
}

export function createThreadChannel(params: { includeStarter?: boolean; type?: ChannelType } = {}) {
  return {
    id: "t1",
    type: params.type ?? ChannelType.PublicThread,
    name: "thread-name",
    parentId: params.type === ChannelType.PublicThread ? "forum-1" : "p1",
    parent: {
      id: params.type === ChannelType.PublicThread ? "forum-1" : "p1",
      name: params.type === ChannelType.PublicThread ? "support" : "general",
    },
    isThread: () => true,
    ...(params.includeStarter
      ? {
          fetchStarterMessage: async () => ({
            content: "starter message",
            author: { tag: "Alice#1", username: "Alice" },
            createdTimestamp: Date.now(),
          }),
        }
      : {}),
  };
}

export function createThreadClient(
  params: {
    fetchChannel?: ReturnType<typeof vi.fn>;
    restGet?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    fetchChannel:
      params.fetchChannel ??
      vi
        .fn()
        .mockResolvedValueOnce({
          id: "t1",
          type: ChannelType.PublicThread,
          name: "thread-name",
          parentId: "p1",
          ownerId: "owner-1",
        })
        .mockResolvedValueOnce({
          id: "p1",
          type: ChannelType.GuildText,
          name: "general",
        }),
    rest: {
      get:
        params.restGet ??
        vi.fn().mockResolvedValue({
          content: "starter message",
          author: { id: "u1", username: "Alice", discriminator: "0001" },
          timestamp: new Date().toISOString(),
        }),
    },
  } as unknown as Client;
}

export function createThreadEvent(messageId: string, channelId = "t1") {
  return {
    message: {
      id: messageId,
      content: "thread hello",
      channelId,
      timestamp: new Date().toISOString(),
      type: MessageType.Default,
      attachments: [],
      embeds: [],
      mentionedEveryone: false,
      mentionedUsers: [],
      mentionedRoles: [],
      author: { id: "u1", bot: false, username: "Ada" },
    },
    author: { id: "u1", bot: false, username: "Ada" },
    member: { nickname: "Ada" },
    guild: { id: "g1", name: "Guild" },
    guild_id: "g1",
  };
}

export function createMentionRequiredGuildConfig(overrides?: Partial<Config>): Config {
  return {
    ...BASE_CFG,
    channels: {
      discord: {
        dm: { enabled: true, policy: "open" },
        groupPolicy: "open",
        guilds: {
          "*": {
            requireMention: true,
            channels: { c1: { enabled: true } },
          },
        },
      },
    },
    ...overrides,
  };
}

export function captureNextDispatchCtx<
  T extends {
    SessionKey?: string;
    ParentSessionKey?: string;
    ThreadStarterBody?: string;
    ThreadLabel?: string;
    WasMentioned?: boolean;
  },
>(): () => T | undefined {
  let capturedCtx: T | undefined;
  dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
    capturedCtx = ctx as T;
    dispatcher.sendFinalReply({ text: "hi" });
    return { queuedFinal: true, counts: { final: 1 } };
  });
  return () => capturedCtx;
}
