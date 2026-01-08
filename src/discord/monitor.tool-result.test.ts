import type { Client } from "@buape/carbon";
import { ChannelType, MessageType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const updateLastRouteMock = vi.fn();
const dispatchMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageDiscord: (...args: unknown[]) => sendMock(...args),
}));
vi.mock("../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: (...args: unknown[]) => dispatchMock(...args),
}));
vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    resolveStorePath: vi.fn(() => "/tmp/clawdbot-sessions.json"),
    updateLastRoute: (...args: unknown[]) => updateLastRouteMock(...args),
    resolveSessionKey: vi.fn(),
  };
});

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue(undefined);
  updateLastRouteMock.mockReset();
  dispatchMock.mockReset().mockImplementation(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text: "hi" });
    return { queuedFinal: true, counts: { final: 1 } };
  });
  vi.resetModules();
});

describe("discord tool result dispatch", () => {
  it("sends status replies with responsePrefix", async () => {
    const { createDiscordMessageHandler } = await import("./monitor.js");
    const cfg = {
      agent: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/clawd" },
      session: { store: "/tmp/clawdbot-sessions.json" },
      messages: { responsePrefix: "PFX" },
      discord: { dm: { enabled: true, policy: "open" } },
      routing: { allowFrom: [] },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const runtimeError = vi.fn();
    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.discord,
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
  }, 10000);

  it("accepts guild messages when mentionPatterns match", async () => {
    const { createDiscordMessageHandler } = await import("./monitor.js");
    const cfg = {
      agent: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/clawd" },
      session: { store: "/tmp/clawdbot-sessions.json" },
      messages: { responsePrefix: "PFX" },
      discord: {
        dm: { enabled: true, policy: "open" },
        guilds: { "*": { requireMention: true } },
      },
      routing: {
        allowFrom: [],
        groupChat: { mentionPatterns: ["\\bclawd\\b"] },
      },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.discord,
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
      guildEntries: { "*": { requireMention: true } },
    });

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.GuildText,
        name: "general",
      }),
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m2",
          content: "clawd: hello",
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
        member: { nickname: "Ada" },
        guild: { id: "g1", name: "Guild" },
        guild_id: "g1",
      },
      client,
    );

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  }, 10000);

  it("forks thread sessions and injects starter context", async () => {
    const { createDiscordMessageHandler } = await import("./monitor.js");
    let capturedCtx:
      | {
          SessionKey?: string;
          ParentSessionKey?: string;
          ThreadStarterBody?: string;
          ThreadLabel?: string;
        }
      | undefined;
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedCtx = ctx;
      dispatcher.sendFinalReply({ text: "hi" });
      return { queuedFinal: true, counts: { final: 1 } };
    });

    const cfg = {
      agent: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/clawd" },
      session: { store: "/tmp/clawdbot-sessions.json" },
      messages: { responsePrefix: "PFX" },
      discord: {
        dm: { enabled: true, policy: "open" },
        guilds: { "*": { requireMention: false } },
      },
      routing: { allowFrom: [] },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.discord,
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
      guildEntries: { "*": { requireMention: false } },
    });

    const threadChannel = {
      type: ChannelType.GuildText,
      name: "thread-name",
      parentId: "p1",
      parent: { id: "p1", name: "general" },
      isThread: () => true,
      fetchStarterMessage: async () => ({
        content: "starter message",
        author: { tag: "Alice#1", username: "Alice" },
        createdTimestamp: Date.now(),
      }),
    };

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.GuildText,
        name: "thread-name",
      }),
      rest: {
        get: vi.fn().mockResolvedValue({
          content: "starter message",
          author: { id: "u1", username: "Alice", discriminator: "0001" },
          timestamp: new Date().toISOString(),
        }),
      },
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m4",
          content: "thread reply",
          channelId: "t1",
          channel: threadChannel,
          timestamp: new Date().toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u2", bot: false, username: "Bob", tag: "Bob#2" },
        },
        author: { id: "u2", bot: false, username: "Bob", tag: "Bob#2" },
        member: { displayName: "Bob" },
        guild: { id: "g1", name: "Guild" },
        guild_id: "g1",
      },
      client,
    );

    expect(capturedCtx?.SessionKey).toBe("agent:main:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe("agent:main:discord:channel:p1");
    expect(capturedCtx?.ThreadStarterBody).toContain("starter message");
    expect(capturedCtx?.ThreadLabel).toContain("Discord thread #general");
  });

  it("scopes thread sessions to the routed agent", async () => {
    const { createDiscordMessageHandler } = await import("./monitor.js");

    let capturedCtx:
      | {
          SessionKey?: string;
          ParentSessionKey?: string;
        }
      | undefined;
    dispatchMock.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      capturedCtx = ctx;
      dispatcher.sendFinalReply({ text: "hi" });
      return { queuedFinal: true, counts: { final: 1 } };
    });

    const cfg = {
      agent: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/clawd" },
      session: { store: "/tmp/clawdbot-sessions.json" },
      messages: { responsePrefix: "PFX" },
      discord: {
        dm: { enabled: true, policy: "open" },
        guilds: { "*": { requireMention: false } },
      },
      routing: {
        allowFrom: [],
        bindings: [
          { agentId: "support", match: { provider: "discord", guildId: "g1" } },
        ],
      },
    } as ReturnType<typeof import("../config/config.js").loadConfig>;

    const handler = createDiscordMessageHandler({
      cfg,
      discordConfig: cfg.discord,
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
      guildEntries: { "*": { requireMention: false } },
    });

    const threadChannel = {
      type: ChannelType.GuildText,
      name: "thread-name",
      parentId: "p1",
      parent: { id: "p1", name: "general" },
      isThread: () => true,
    };

    const client = {
      fetchChannel: vi.fn().mockResolvedValue({
        type: ChannelType.GuildText,
        name: "thread-name",
      }),
      rest: {
        get: vi.fn().mockResolvedValue({
          content: "starter message",
          author: { id: "u1", username: "Alice", discriminator: "0001" },
          timestamp: new Date().toISOString(),
        }),
      },
    } as unknown as Client;

    await handler(
      {
        message: {
          id: "m5",
          content: "thread reply",
          channelId: "t1",
          channel: threadChannel,
          timestamp: new Date().toISOString(),
          type: MessageType.Default,
          attachments: [],
          embeds: [],
          mentionedEveryone: false,
          mentionedUsers: [],
          mentionedRoles: [],
          author: { id: "u2", bot: false, username: "Bob", tag: "Bob#2" },
        },
        author: { id: "u2", bot: false, username: "Bob", tag: "Bob#2" },
        member: { displayName: "Bob" },
        guild: { id: "g1", name: "Guild" },
        guild_id: "g1",
      },
      client,
    );

    expect(capturedCtx?.SessionKey).toBe("agent:support:discord:channel:t1");
    expect(capturedCtx?.ParentSessionKey).toBe(
      "agent:support:discord:channel:p1",
    );
  });
});
