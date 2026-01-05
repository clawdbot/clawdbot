import { beforeEach, describe, expect, it, vi } from "vitest";
import * as replyModule from "../auto-reply/reply.js";
import { createTelegramBot } from "./bot.js";

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../config/config.js", () => ({
  loadConfig,
}));

const useSpy = vi.fn();
const onSpy = vi.fn();
const stopSpy = vi.fn();
const sendChatActionSpy = vi.fn();
const sendMessageSpy = vi.fn(async () => ({ message_id: 77 }));
type ApiStub = {
  config: { use: (arg: unknown) => void };
  sendChatAction: typeof sendChatActionSpy;
  sendMessage: typeof sendMessageSpy;
};
const apiStub: ApiStub = {
  config: { use: useSpy },
  sendChatAction: sendChatActionSpy,
  sendMessage: sendMessageSpy,
};

vi.mock("grammy", () => ({
  Bot: class {
    api = apiStub;
    on = onSpy;
    stop = stopSpy;
    constructor(public token: string) {}
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

const throttlerSpy = vi.fn(() => "throttler");

vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: () => throttlerSpy(),
}));

vi.mock("../auto-reply/reply.js", () => {
  const replySpy = vi.fn(async (_ctx, opts) => {
    await opts?.onReplyStart?.();
    return undefined;
  });
  return { getReplyFromConfig: replySpy, __replySpy: replySpy };
});

describe("createTelegramBot", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
  });

  it("installs grammY throttler", () => {
    createTelegramBot({ token: "tok" });
    expect(throttlerSpy).toHaveBeenCalledTimes(1);
    expect(useSpy).toHaveBeenCalledWith("throttler");
  });

  it("wraps inbound message with Telegram envelope", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Europe/Vienna";

    try {
      onSpy.mockReset();
      const replySpy = replyModule.__replySpy as unknown as ReturnType<
        typeof vi.fn
      >;
      replySpy.mockReset();

      createTelegramBot({ token: "tok" });
      expect(onSpy).toHaveBeenCalledWith("message", expect.any(Function));
      const handler = onSpy.mock.calls[0][1] as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;

      const message = {
        chat: { id: 1234, type: "private" },
        text: "hello world",
        date: 1736380800, // 2025-01-09T00:00:00Z
        from: {
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada_bot",
        },
      };
      await handler({
        message,
        me: { username: "clawdbot_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.Body).toMatch(
        /^\[Telegram Ada Lovelace \(@ada_bot\) id:1234 2025-01-09T01:00\+01:00\{Europe\/Vienna\}\]/,
      );
      expect(payload.Body).toContain("hello world");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("triggers typing cue via onReplyStart", async () => {
    onSpy.mockReset();
    sendChatActionSpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    await handler({
      message: { chat: { id: 42, type: "private" }, text: "hi" },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendChatActionSpy).toHaveBeenCalledWith(42, "typing");
  });

  it("includes reply-to context when a Telegram reply is received", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "private" },
        text: "Sure, see below",
        date: 1736380800,
        reply_to_message: {
          message_id: 9001,
          text: "Can you summarize this?",
          from: { first_name: "Ada" },
        },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Replying to Ada id:9001]");
    expect(payload.Body).toContain("Can you summarize this?");
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("Can you summarize this?");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("sends replies without native reply threading", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "a".repeat(4500) });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    await handler({
      message: {
        chat: { id: 5, type: "private" },
        text: "hi",
        date: 1736380800,
        message_id: 101,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMessageSpy.mock.calls) {
      expect(call[2]?.reply_to_message_id).toBeUndefined();
    }
  });

  it("honors replyToMode=first for threaded replies", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    replySpy.mockResolvedValue({
      text: "a".repeat(4500),
      replyToId: "101",
    });

    createTelegramBot({ token: "tok", replyToMode: "first" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    await handler({
      message: {
        chat: { id: 5, type: "private" },
        text: "hi",
        date: 1736380800,
        message_id: 101,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
    const [first, ...rest] = sendMessageSpy.mock.calls;
    expect(first?.[2]?.reply_to_message_id).toBe(101);
    for (const call of rest) {
      expect(call[2]?.reply_to_message_id).toBeUndefined();
    }
  });

  it("honors replyToMode=all for threaded replies", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    replySpy.mockResolvedValue({
      text: "a".repeat(4500),
      replyToId: "101",
    });

    createTelegramBot({ token: "tok", replyToMode: "all" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    await handler({
      message: {
        chat: { id: 5, type: "private" },
        text: "hi",
        date: 1736380800,
        message_id: 101,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMessageSpy.mock.calls) {
      expect(call[2]?.reply_to_message_id).toBe(101);
    }
  });

  it("skips group messages without mention when requireMention is enabled", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: { groups: { "*": { requireMention: true } } },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123, type: "group", title: "Dev Chat" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("allows per-group requireMention override", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groups: {
          "*": { requireMention: true },
          "123": { requireMention: false },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123, type: "group", title: "Dev Chat" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("honors groups default when no explicit group override exists", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groups: { "*": { requireMention: false } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: 456, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("does not block group messages when bot username is unknown", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: { groups: { "*": { requireMention: true } } },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: 789, type: "group", title: "No Me" },
        text: "hello",
        date: 1736380800,
      },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  // groupPolicy tests
  it("blocks all group messages when groupPolicy is 'disabled'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "disabled",
        allowFrom: ["123456789"],
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "@clawdbot_bot hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    // Should NOT call getReplyFromConfig because groupPolicy is disabled
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("blocks group messages from senders not in allowFrom when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["123456789"], // Does not include sender 999999
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "notallowed" }, // Not in allowFrom
        text: "@clawdbot_bot hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("allows group messages from senders in allowFrom (by ID) when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["123456789"],
        groups: { "*": { requireMention: false } }, // Skip mention check
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" }, // In allowFrom
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows group messages from senders in allowFrom (by username) when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["@testuser"], // By username
        groups: { "*": { requireMention: false } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 12345, username: "testuser" }, // Username matches @testuser
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows all group messages when groupPolicy is 'open' (default)", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        // groupPolicy not set, should default to "open"
        groups: { "*": { requireMention: false } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" }, // Random sender
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("matches usernames case-insensitively when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["@TestUser"], // Uppercase in config
        groups: { "*": { requireMention: false } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 12345, username: "testuser" }, // Lowercase in message
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows direct messages regardless of groupPolicy", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "disabled", // Even with disabled, DMs should work
        allowFrom: ["123456789"],
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123456789, type: "private" }, // Direct message
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows direct messages with tg/Telegram-prefixed allowFrom entries", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        allowFrom: ["  TG:123456789  "],
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123456789, type: "private" }, // Direct message
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows direct messages with telegram:-prefixed allowFrom entries", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        allowFrom: ["telegram:123456789"],
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123456789, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows group messages with wildcard in allowFrom when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["*"], // Wildcard allows everyone
        groups: { "*": { requireMention: false } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" }, // Random sender, but wildcard allows
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("blocks group messages with no sender ID when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["123456789"],
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        // No `from` field (e.g., channel post or anonymous admin)
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("matches telegram:-prefixed allowFrom entries in group allowlist", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["telegram:123456789"], // Prefixed format
        groups: { "*": { requireMention: false } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" }, // Matches after stripping prefix
        text: "hello from prefixed user",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    // Should call reply because sender ID matches after stripping telegram: prefix
    expect(replySpy).toHaveBeenCalled();
  });

  it("matches tg:-prefixed allowFrom entries case-insensitively in group allowlist", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<
      typeof vi.fn
    >;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["TG:123456789"], // Prefixed format (case-insensitive)
        groups: { "*": { requireMention: false } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = onSpy.mock.calls[0][1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" }, // Matches after stripping tg: prefix
        text: "hello from prefixed user",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    // Should call reply because sender ID matches after stripping tg: prefix
    expect(replySpy).toHaveBeenCalled();
  });
});
