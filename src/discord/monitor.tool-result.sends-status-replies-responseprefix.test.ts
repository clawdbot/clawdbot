import type { Client } from "@buape/carbon";
import { ChannelType, MessageType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordMessageHandler } from "./monitor.js";
import { __resetDiscordChannelInfoCacheForTest } from "./monitor/message-utils.js";
import { __resetDiscordThreadStarterCacheForTest } from "./monitor/threading.js";

const sendMock = vi.fn();
const reactMock = vi.fn();
const updateLastRouteMock = vi.fn();
const dispatchMock = vi.fn();
const readAllowFromStoreMock = vi.fn();
const upsertPairingRequestMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMock(...args),
  reactMessageDiscord: async (...args: unknown[]) => {
    reactMock(...args);
  },
}));
vi.mock("../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: (...args: unknown[]) => dispatchMock(...args),
    dispatchInboundMessageWithDispatcher: (...args: unknown[]) => dispatchMock(...args),
    dispatchInboundMessageWithBufferedDispatcher: (...args: unknown[]) => dispatchMock(...args),
  };
});
vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readAllowFromStoreMock(...args),
  upsertChannelPairingRequest: (...args: unknown[]) => upsertPairingRequestMock(...args),
}));
vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: vi.fn(() => "/tmp/moltbot-sessions.json"),
    updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
    resolveSessionKey: vi.fn(),
  };
});

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue(undefined);
  updateLastRouteMock.mockReset();
  dispatchMock.mockReset().mockImplementation(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text: "hi" });
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  });
  readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  __resetDiscordChannelInfoCacheForTest();
  __resetDiscordThreadStarterCacheForTest();
});

describe("discord tool result dispatch", () => {
  it("sends status replies with responsePrefix", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-5",
          workspace: "/tmp/clawd",
        },
      },
      session: { store: "/tmp/moltbot-sessions.json" },
      messages: { responsePrefix: "PFX" },
      channels: { discord: { dm: { enabled: true, policy: "open" } } },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const runtimeError = vi.fn();
    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.channels.discord,
      accountId: "default",
      token: "token",
      runtime: {
        log: vi.fn(),
        error: runtimeError,
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
    });

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.DM,
        name: "dm",
      }),
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m1",
          content: "/status",
          channelId: "c1",
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
        guild_id: null,
      },
      client,
    );

    expect(runtimeError).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[1]).toMatch(/^PFX /);
  }, 30_000);

  it("caches channel info lookups between messages", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-5",
          workspace: "/tmp/clawd",
        },
      },
      session: { store: "/tmp/moltbot-sessions.json" },
      channels: { discord: { dm: { enabled: true, policy: "open" } } },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.channels.discord,
      accountId: "default",
      token: "token",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
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
    });

    const fetchChannel = vi.fn().mockResolvedValue({
      type: ChannelType.DM,
      name: "dm",
    });
    const client = { fetchChannel } as unknown as Client;
    const baseMessage = {
      content: "hello",
      channelId: "cache-channel-1",
      timestamp: new Date().toISOString(),
      type: MessageType.Default,
      attachments: [],
      embeds: [],
      mentionedEveryone: false,
      mentionedUsers: [],
      mentionedRoles: [],
      author: { id: "u-cache", bot: false, username: "Ada" },
    };

    await handler(
      {
        message: { ...baseMessage, id: "m-cache-1" },
        author: baseMessage.author,
        guild_id: null,
      },
      client,
    );
    await handler(
      {
        message: { ...baseMessage, id: "m-cache-2" },
        author: baseMessage.author,
        guild_id: null,
      },
      client,
    );

    expect(fetchChannel).toHaveBeenCalledTimes(1);
  });

  it("includes forwarded message snapshots in body", async () => {
    let capturedBody = "";
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedBody = ctx.Body ?? "";
      dispatcher.sendFinalReply({ text: "ok" });
      return { queuedFinal: true, counts: { final: 1 } };
    });

    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-5",
          workspace: "/tmp/clawd",
        },
      },
      session: { store: "/tmp/moltbot-sessions.json" },
      channels: { discord: { dm: { enabled: true, policy: "open" } } },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.channels.discord,
      accountId: "default",
      token: "token",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
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
    });

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.DM,
        name: "dm",
      }),
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m-forward-1",
          content: "",
          channelId: "c-forward-1",
          timestamp: new Date().toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u1", bot: false, username: "Ada" },
          rawData: {
            message_snapshots: [
              {
                message: {
                  content: "forwarded hello",
                  embeds: [],
                  attachments: [],
                  author: {
                    id: "u2",
                    username: "Bob",
                    discriminator: "0",
                  },
                },
              },
            ],
          },
        },
        author: { id: "u1", bot: false, username: "Ada" },
        guild_id: null,
      },
      client,
    );

    expect(capturedBody).toContain("[Forwarded message from @Bob]");
    expect(capturedBody).toContain("forwarded hello");
  });

  it("uses channel id allowlists for non-thread channels with categories", async () => {
    const { createDiscordMessageHandler } = await import("./monitor.js");
    let capturedCtx: { SessionKey?: string } | undefined;
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedCtx = ctx;
      dispatcher.sendFinalReply({ text: "hi" });
      return { queuedFinal: true, counts: { final: 1 } };
    });

    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-5",
          workspace: "/tmp/clawd",
        },
      },
      session: { store: "/tmp/moltbot-sessions.json" },
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
          guilds: {
            "*": {
              requireMention: false,
              channels: { c1: { allow: true } },
            },
          },
        },
      },
      routing: { allowFrom: [] },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.channels.discord,
      accountId: "default",
      token: "token",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
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
      guildEntries: {
        "*": { requireMention: false, channels: { c1: { allow: true } } },
      },
    });

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.GuildText,
        name: "general",
        parentId: "category-1",
      }),
      rest: { get: vi.fn() },
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m-category",
          content: "hello",
          channelId: "c1",
          timestamp: new Date().toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u1", bot: false, username: "Ada", tag: "Ada#1" },
        },
        author: { id: "u1", bot: false, username: "Ada", tag: "Ada#1" },
        member: { displayName: "Ada" },
        guild: { id: "g1", name: "Guild" },
        guild_id: "g1",
      },
      client,
    );

    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:c1");
  });

  it("prefixes group bodies with sender label", async () => {
    const { createDiscordMessageHandler } = await import("./monitor.js");
    let capturedBody = "";
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedBody = ctx.Body ?? "";
      dispatcher.sendFinalReply({ text: "ok" });
      return { queuedFinal: true, counts: { final: 1 } };
    });

    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-5",
          workspace: "/tmp/clawd",
        },
      },
      session: { store: "/tmp/moltbot-sessions.json" },
      channels: {
        discord: {
          dm: { enabled: true, policy: "open" },
          guilds: {
            "*": {
              requireMention: false,
              channels: { c1: { allow: true } },
            },
          },
        },
      },
      routing: { allowFrom: [] },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.channels.discord,
      accountId: "default",
      token: "token",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
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
      guildEntries: {
        "*": { requireMention: false, channels: { c1: { allow: true } } },
      },
    });

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.GuildText,
        name: "general",
        parentId: "category-1",
      }),
      rest: { get: vi.fn() },
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m-prefix",
          content: "hello",
          channelId: "c1",
          timestamp: new Date("2026-01-17T00:00:00Z").toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u1", bot: false, username: "Ada", discriminator: "1234" },
        },
        author: { id: "u1", bot: false, username: "Ada", discriminator: "1234" },
        member: { displayName: "Ada" },
        guild: { id: "g1", name: "Guild" },
        guild_id: "g1",
      },
      client,
    );

    expect(capturedBody).toContain("Ada (Ada#1234): hello");
  });

  it("replies with pairing code and sender id when dmPolicy is pairing", async () => {
    const { createDiscordMessageHandler } = await import("./monitor.js");
    const cfg = {
      agents: {
        defaults: {
          model: "anthropic/claude-opus-4-5",
          workspace: "/tmp/clawd",
        },
      },
      session: { store: "/tmp/moltbot-sessions.json" },
      channels: {
        discord: { dm: { enabled: true, policy: "pairing", allowFrom: [] } },
      },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.channels.discord,
      accountId: "default",
      token: "token",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
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
    });

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.DM,
        name: "dm",
      }),
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m1",
          content: "hello",
          channelId: "c1",
          timestamp: new Date().toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u2", bot: false, username: "Ada" },
        },
        author: { id: "u2", bot: false, username: "Ada" },
        guild_id: null,
      },
      client,
    );

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(upsertPairingRequestMock).toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Your Discord user id: u2");
    expect(String(sendMock.mock.calls[0]?.[1] ?? "")).toContain("Pairing code: PAIRCODE");
  }, 10000);
});
