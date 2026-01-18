import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listNativeCommandSpecs,
  listNativeCommandSpecsForConfig,
} from "../auto-reply/commands-registry.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import * as replyModule from "../auto-reply/reply.js";
import { expectInboundContextContract } from "../../test/helpers/inbound-contract.js";
import { createTelegramBot, getTelegramSequentialKey } from "./bot.js";
import { resolveTelegramFetch } from "./fetch.js";

function resolveSkillCommands(config: Parameters<typeof listNativeCommandSpecsForConfig>[0]) {
  return listSkillCommandsForAgents({ cfg: config });
}

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("../web/media.js", () => ({
  loadWebMedia,
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

const { readTelegramAllowFromStore, upsertTelegramPairingRequest } = vi.hoisted(() => ({
  readTelegramAllowFromStore: vi.fn(async () => [] as string[]),
  upsertTelegramPairingRequest: vi.fn(async () => ({
    code: "PAIRCODE",
    created: true,
  })),
}));

vi.mock("./pairing-store.js", () => ({
  readTelegramAllowFromStore,
  upsertTelegramPairingRequest,
}));

const { enqueueSystemEvent } = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
}));
vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

const { wasSentByBot } = vi.hoisted(() => ({
  wasSentByBot: vi.fn(() => false),
}));
vi.mock("./sent-message-cache.js", () => ({
  wasSentByBot,
  recordSentMessage: vi.fn(),
  clearSentMessageCache: vi.fn(),
}));

const useSpy = vi.fn();
const middlewareUseSpy = vi.fn();
const onSpy = vi.fn();
const stopSpy = vi.fn();
const commandSpy = vi.fn();
const botCtorSpy = vi.fn();
const answerCallbackQuerySpy = vi.fn(async () => undefined);
const sendChatActionSpy = vi.fn();
const setMessageReactionSpy = vi.fn(async () => undefined);
const setMyCommandsSpy = vi.fn(async () => undefined);
const sendMessageSpy = vi.fn(async () => ({ message_id: 77 }));
const sendAnimationSpy = vi.fn(async () => ({ message_id: 78 }));
const sendPhotoSpy = vi.fn(async () => ({ message_id: 79 }));
type ApiStub = {
  config: { use: (arg: unknown) => void };
  answerCallbackQuery: typeof answerCallbackQuerySpy;
  sendChatAction: typeof sendChatActionSpy;
  setMessageReaction: typeof setMessageReactionSpy;
  setMyCommands: typeof setMyCommandsSpy;
  sendMessage: typeof sendMessageSpy;
  sendAnimation: typeof sendAnimationSpy;
  sendPhoto: typeof sendPhotoSpy;
};
const apiStub: ApiStub = {
  config: { use: useSpy },
  answerCallbackQuery: answerCallbackQuerySpy,
  sendChatAction: sendChatActionSpy,
  setMessageReaction: setMessageReactionSpy,
  setMyCommands: setMyCommandsSpy,
  sendMessage: sendMessageSpy,
  sendAnimation: sendAnimationSpy,
  sendPhoto: sendPhotoSpy,
};

vi.mock("grammy", () => ({
  Bot: class {
    api = apiStub;
    use = middlewareUseSpy;
    on = onSpy;
    stop = stopSpy;
    command = commandSpy;
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch } },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
  webhookCallback: vi.fn(),
}));

const sequentializeMiddleware = vi.fn();
const sequentializeSpy = vi.fn(() => sequentializeMiddleware);
let sequentializeKey: ((ctx: unknown) => string) | undefined;
vi.mock("@grammyjs/runner", () => ({
  sequentialize: (keyFn: (ctx: unknown) => string) => {
    sequentializeKey = keyFn;
    return sequentializeSpy();
  },
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

const getOnHandler = (event: string) => {
  const handler = onSpy.mock.calls.find((call) => call[0] === event)?.[1];
  if (!handler) throw new Error(`Missing handler for event: ${event}`);
  return handler as (ctx: Record<string, unknown>) => Promise<void>;
};

describe("createTelegramBot", () => {
  beforeEach(() => {
    resetInboundDedupe();
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    loadWebMedia.mockReset();
    sendAnimationSpy.mockReset();
    sendPhotoSpy.mockReset();
    setMessageReactionSpy.mockReset();
    answerCallbackQuerySpy.mockReset();
    setMyCommandsSpy.mockReset();
    wasSentByBot.mockReset();
    middlewareUseSpy.mockReset();
    sequentializeSpy.mockReset();
    botCtorSpy.mockReset();
    sequentializeKey = undefined;
  });

  it("installs grammY throttler", () => {
    createTelegramBot({ token: "tok" });
    expect(throttlerSpy).toHaveBeenCalledTimes(1);
    expect(useSpy).toHaveBeenCalledWith("throttler");
  });

  it("merges custom commands with native commands", () => {
    const config = {
      channels: {
        telegram: {
          customCommands: [
            { command: "custom_backup", description: "Git backup" },
            { command: "/Custom_Generate", description: "Create an image" },
          ],
        },
      },
    };
    loadConfig.mockReturnValue(config);

    createTelegramBot({ token: "tok" });

    const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    const skillCommands = resolveSkillCommands(config);
    const native = listNativeCommandSpecsForConfig(config, { skillCommands }).map((command) => ({
      command: command.name,
      description: command.description,
    }));
    expect(registered.slice(0, native.length)).toEqual(native);
    expect(registered.slice(native.length)).toEqual([
      { command: "custom_backup", description: "Git backup" },
      { command: "custom_generate", description: "Create an image" },
    ]);
  });

  it("ignores custom commands that collide with native commands", () => {
    const errorSpy = vi.fn();
    const config = {
      channels: {
        telegram: {
          customCommands: [
            { command: "status", description: "Custom status" },
            { command: "custom_backup", description: "Git backup" },
          ],
        },
      },
    };
    loadConfig.mockReturnValue(config);

    createTelegramBot({
      token: "tok",
      runtime: {
        log: vi.fn(),
        error: errorSpy,
        exit: ((code: number) => {
          throw new Error(`exit ${code}`);
        }) as (code: number) => never,
      },
    });

    const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    const skillCommands = resolveSkillCommands(config);
    const native = listNativeCommandSpecsForConfig(config, { skillCommands }).map((command) => ({
      command: command.name,
      description: command.description,
    }));
    const nativeStatus = native.find((command) => command.command === "status");
    expect(nativeStatus).toBeDefined();
    expect(registered).toContainEqual({ command: "custom_backup", description: "Git backup" });
    expect(registered).not.toContainEqual({ command: "status", description: "Custom status" });
    expect(registered.filter((command) => command.command === "status")).toEqual([nativeStatus]);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("registers custom commands when native commands are disabled", () => {
    const config = {
      commands: { native: false },
      channels: {
        telegram: {
          customCommands: [
            { command: "custom_backup", description: "Git backup" },
            { command: "custom_generate", description: "Create an image" },
          ],
        },
      },
    };
    loadConfig.mockReturnValue(config);

    createTelegramBot({ token: "tok" });

    const registered = setMyCommandsSpy.mock.calls[0]?.[0] as Array<{
      command: string;
      description: string;
    }>;
    expect(registered).toEqual([
      { command: "custom_backup", description: "Git backup" },
      { command: "custom_generate", description: "Create an image" },
    ]);
    const reserved = listNativeCommandSpecs().map((command) => command.name);
    expect(registered.some((command) => reserved.includes(command.command))).toBe(false);
  });

  it("forces native fetch only under Bun", () => {
    const originalFetch = globalThis.fetch;
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      (globalThis as { Bun?: unknown }).Bun = {};
      createTelegramBot({ token: "tok" });
      const fetchImpl = resolveTelegramFetch();
      expect(fetchImpl).toBe(fetchSpy);
      expect(botCtorSpy).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({
          client: expect.objectContaining({ fetch: fetchSpy }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBun === undefined) {
        delete (globalThis as { Bun?: unknown }).Bun;
      } else {
        (globalThis as { Bun?: unknown }).Bun = originalBun;
      }
    }
  });

  it("does not force native fetch on Node", () => {
    const originalFetch = globalThis.fetch;
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
      if (originalBun !== undefined) {
        delete (globalThis as { Bun?: unknown }).Bun;
      }
      createTelegramBot({ token: "tok" });
      const fetchImpl = resolveTelegramFetch();
      expect(fetchImpl).toBeUndefined();
      expect(botCtorSpy).toHaveBeenCalledWith("tok", undefined);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBun === undefined) {
        delete (globalThis as { Bun?: unknown }).Bun;
      } else {
        (globalThis as { Bun?: unknown }).Bun = originalBun;
      }
    }
  });

  it("sequentializes updates by chat and thread", () => {
    createTelegramBot({ token: "tok" });
    expect(sequentializeSpy).toHaveBeenCalledTimes(1);
    expect(middlewareUseSpy).toHaveBeenCalledWith(sequentializeSpy.mock.results[0]?.value);
    expect(sequentializeKey).toBe(getTelegramSequentialKey);
    expect(getTelegramSequentialKey({ message: { chat: { id: 123 } } })).toBe("telegram:123");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123 }, message_thread_id: 9 },
      }),
    ).toBe("telegram:123:topic:9");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123, is_forum: true } },
      }),
    ).toBe("telegram:123:topic:1");
    expect(
      getTelegramSequentialKey({
        update: { message: { chat: { id: 555 } } },
      }),
    ).toBe("telegram:555");
  });

  it("routes callback_query payloads as messages and answers callbacks", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-1",
        data: "cmd:option_a",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 10,
        },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("cmd:option_a");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-1");
  });

  it("blocks callback_query when inline buttons are allowlist-only and sender not authorized", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    createTelegramBot({
      token: "tok",
      config: {
        channels: {
          telegram: {
            dmPolicy: "pairing",
            capabilities: { inlineButtons: "allowlist" },
            allowFrom: [],
          },
        },
      },
    });
    const callbackHandler = onSpy.mock.calls.find((call) => call[0] === "callback_query")?.[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    expect(callbackHandler).toBeDefined();

    await callbackHandler({
      callbackQuery: {
        id: "cbq-2",
        data: "cmd:option_b",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 11,
        },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-2");
  });

  it("wraps inbound message with Telegram envelope", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "Europe/Vienna";

    try {
      onSpy.mockReset();
      const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
      replySpy.mockReset();

      createTelegramBot({ token: "tok" });
      expect(onSpy).toHaveBeenCalledWith("message", expect.any(Function));
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
        /^\[Telegram Ada Lovelace \(@ada_bot\) id:1234 2025-01-09T00:00Z\]/,
      );
      expect(payload.Body).toContain("hello world");
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it("requests pairing by default for unknown DM senders", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readTelegramAllowFromStore.mockResolvedValue([]);
    upsertTelegramPairingRequest.mockResolvedValue({
      code: "PAIRME12",
      created: true,
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        date: 1736380800,
        from: { id: 999, username: "random" },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[0]).toBe(1234);
    expect(String(sendMessageSpy.mock.calls[0]?.[1])).toContain("Your Telegram user id: 999");
    expect(String(sendMessageSpy.mock.calls[0]?.[1])).toContain("Pairing code:");
    expect(String(sendMessageSpy.mock.calls[0]?.[1])).toContain("PAIRME12");
  });

  it("does not resend pairing code when a request is already pending", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readTelegramAllowFromStore.mockResolvedValue([]);
    upsertTelegramPairingRequest
      .mockResolvedValueOnce({ code: "PAIRME12", created: true })
      .mockResolvedValueOnce({ code: "PAIRME12", created: false });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const message = {
      chat: { id: 1234, type: "private" },
      text: "hello",
      date: 1736380800,
      from: { id: 999, username: "random" },
    };

    await handler({
      message,
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    await handler({
      message: { ...message, text: "hello again" },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("triggers typing cue via onReplyStart", async () => {
    onSpy.mockReset();
    sendChatActionSpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: { chat: { id: 42, type: "private" }, text: "hi" },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendChatActionSpy).toHaveBeenCalledWith(42, "typing", undefined);
  });

  it("accepts group messages when mentionPatterns match (without @botUsername)", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      identity: { name: "Bert" },
      messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "bert: introduce yourself",
        date: 1736380800,
        message_id: 1,
        from: { id: 9, first_name: "Ada" },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expectInboundContextContract(payload);
    expect(payload.WasMentioned).toBe(true);
    expect(payload.Body).toMatch(/^\[Telegram Test Group id:7 2025-01-09T00:00Z\]/);
    expect(payload.SenderName).toBe("Ada");
    expect(payload.SenderId).toBe("9");
  });

  it("includes sender identity in group envelope headers", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
        message_id: 2,
        from: {
          id: 99,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expectInboundContextContract(payload);
    expect(payload.Body).toMatch(/^\[Telegram Ops id:42 2025-01-09T00:00Z\]/);
    expect(payload.SenderName).toBe("Ada Lovelace");
    expect(payload.SenderId).toBe("99");
    expect(payload.SenderUsername).toBe("ada");
  });

  it("reacts to mention-gated group messages when ackReaction is enabled", async () => {
    onSpy.mockReset();
    setMessageReactionSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
        groupChat: { mentionPatterns: ["\\bbert\\b"] },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "bert hello",
        date: 1736380800,
        message_id: 123,
        from: { id: 9, first_name: "Ada" },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(setMessageReactionSpy).toHaveBeenCalledWith(7, 123, [{ type: "emoji", emoji: "👀" }]);
  });

  it("clears native commands when disabled", () => {
    loadConfig.mockReturnValue({
      commands: { native: false },
    });

    createTelegramBot({ token: "tok" });

    expect(setMyCommandsSpy).toHaveBeenCalledWith([]);
  });

  it("skips group messages when requireMention is enabled and no mention matches", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "hello everyone",
        date: 1736380800,
        message_id: 2,
        from: { id: 9, first_name: "Ada" },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("allows group messages when requireMention is enabled but mentions cannot be detected", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      messages: { groupChat: { mentionPatterns: [] } },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "hello everyone",
        date: 1736380800,
        message_id: 3,
        from: { id: 9, first_name: "Ada" },
      },
      me: {},
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.WasMentioned).toBe(false);
  });

  it("includes reply-to context when a Telegram reply is received", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "a".repeat(4500) });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    replySpy.mockResolvedValue({
      text: "a".repeat(4500),
      replyToId: "101",
    });

    createTelegramBot({ token: "tok", replyToMode: "first" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
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

  it("prefixes tool and final replies with responsePrefix", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    replySpy.mockImplementation(async (_ctx, opts) => {
      await opts?.onToolResult?.({ text: "tool result" });
      return { text: "final reply" };
    });
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
      messages: { responsePrefix: "PFX" },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: {
        chat: { id: 5, type: "private" },
        text: "hi",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(sendMessageSpy.mock.calls[0][1]).toBe("PFX tool result");
    expect(sendMessageSpy.mock.calls[1][1]).toBe("PFX final reply");
  });

  it("honors replyToMode=all for threaded replies", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    replySpy.mockResolvedValue({
      text: "a".repeat(4500),
      replyToId: "101",
    });

    createTelegramBot({ token: "tok", replyToMode: "all" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
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

  it("blocks group messages when telegram.groups is set without a wildcard", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groups: {
            "123": { requireMention: false },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 456, type: "group", title: "Ops" },
        text: "@clawdbot_bot hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("skips group messages without mention when requireMention is enabled", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: { groups: { "*": { requireMention: true } } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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

  it("accepts group replies to the bot without explicit mention when requireMention is enabled", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: { groups: { "*": { requireMention: true } } },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 456, type: "group", title: "Ops Chat" },
        text: "following up",
        date: 1736380800,
        reply_to_message: {
          message_id: 42,
          text: "original reply",
          from: { id: 999, first_name: "Clawdbot" },
        },
      },
      me: { id: 999, username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.WasMentioned).toBe(true);
  });

  it("honors routed group activation from session store", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-telegram-"));
    const storePath = path.join(storeDir, "sessions.json");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:ops:telegram:group:123": { groupActivation: "always" },
      }),
      "utf-8",
    );
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
      bindings: [
        {
          agentId: "ops",
          match: {
            channel: "telegram",
            peer: { kind: "group", id: "123" },
          },
        },
      ],
      session: { store: storePath },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123, type: "group", title: "Routing" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("routes DMs by telegram accountId binding", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          accounts: {
            opie: {
              botToken: "tok-opie",
              dmPolicy: "open",
            },
          },
        },
      },
      bindings: [
        {
          agentId: "opie",
          match: { channel: "telegram", accountId: "opie" },
        },
      ],
    });

    createTelegramBot({ token: "tok", accountId: "opie" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 999, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.AccountId).toBe("opie");
    expect(payload.SessionKey).toBe("agent:opie:main");
  });

  it("allows per-group requireMention override", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "*": { requireMention: true },
            "123": { requireMention: false },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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

  it("allows per-topic requireMention override", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "*": { requireMention: true },
            "-1001234567890": {
              requireMention: true,
              topics: {
                "99": { requireMention: false },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("inherits group allowlist + requireMention in topics", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              requireMention: false,
              allowFrom: ["123456789"],
              topics: {
                "99": {},
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("prefers topic allowFrom over group allowFrom", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: {
            "-1001234567890": {
              allowFrom: ["123456789"],
              topics: {
                "99": { allowFrom: ["999999999"] },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_thread_id: 99,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(0);
  });

  it("honors groups default when no explicit group override exists", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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

  it("sends GIF replies as animations", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    replySpy.mockResolvedValueOnce({
      text: "caption",
      mediaUrl: "https://example.com/fun",
    });

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("GIF89a"),
      contentType: "image/gif",
      fileName: "fun.gif",
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello world",
        date: 1736380800,
        message_id: 5,
        from: { first_name: "Ada" },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendAnimationSpy).toHaveBeenCalledTimes(1);
    expect(sendAnimationSpy).toHaveBeenCalledWith("1234", expect.anything(), {
      caption: "caption",
      reply_to_message_id: undefined,
    });
    expect(sendPhotoSpy).not.toHaveBeenCalled();
  });

  // groupPolicy tests
  it("blocks all group messages when groupPolicy is 'disabled'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "disabled",
          allowFrom: ["123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["123456789"], // Does not include sender 999999
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["123456789"],
          groups: { "*": { requireMention: false } }, // Skip mention check
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["@testuser"], // By username
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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

  it("allows group messages from telegram:-prefixed allowFrom entries when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["telegram:77112533"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 77112533, username: "mneves" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows group messages from tg:-prefixed allowFrom entries case-insensitively when groupPolicy is 'allowlist'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["TG:77112533"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 77112533, username: "mneves" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows all group messages when groupPolicy is 'open'", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["@TestUser"], // Uppercase in config
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "disabled", // Even with disabled, DMs should work
          allowFrom: ["123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["  TG:123456789  "],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          allowFrom: ["telegram:123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["*"], // Wildcard allows everyone
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["123456789"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["telegram:123456789"], // Prefixed format
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["TG:123456789"], // Prefixed format (case-insensitive)
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

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

  it("blocks group messages when groupPolicy allowlist has no groupAllowFrom", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).not.toHaveBeenCalled();
  });

  it("allows control commands with TG-prefixed groupAllowFrom entries", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["  TG:123456789  "],
          groups: { "*": { requireMention: true } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "/status",
        date: 1736380800,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("isolates forum topic sessions and carries thread metadata", async () => {
    onSpy.mockReset();
    sendChatActionSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.SessionKey).toContain("telegram:group:-1001234567890:topic:99");
    expect(payload.From).toBe("telegram:group:-1001234567890:topic:99");
    expect(payload.MessageThreadId).toBe(99);
    expect(payload.IsForum).toBe(true);
    expect(sendChatActionSpy).toHaveBeenCalledWith(-1001234567890, "typing", {
      message_thread_id: 99,
    });
  });

  it("falls back to General topic thread id for typing in forums", async () => {
    onSpy.mockReset();
    sendChatActionSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(sendChatActionSpy).toHaveBeenCalledWith(-1001234567890, "typing", {
      message_thread_id: 1,
    });
  });

  it("routes General topic replies using thread id 1", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const sendParams = sendMessageSpy.mock.calls[0]?.[2] as { message_thread_id?: number };
    expect(sendParams?.message_thread_id).toBeUndefined();
  });

  it("applies topic skill filters and system prompts", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-1001234567890": {
              requireMention: false,
              systemPrompt: "Group prompt",
              skills: ["group-skill"],
              topics: {
                "99": {
                  skills: [],
                  systemPrompt: "Topic prompt",
                },
              },
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.GroupSystemPrompt).toBe("Group prompt\n\nTopic prompt");
    const opts = replySpy.mock.calls[0][1];
    expect(opts?.skillFilter).toEqual([]);
  });

  it("passes message_thread_id to topic replies", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });

  it("threads native command replies inside topics", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    expect(commandSpy).toHaveBeenCalled();
    const handler = commandSpy.mock.calls[0][1] as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: {
          id: -1001234567890,
          type: "supergroup",
          title: "Forum Group",
          is_forum: true,
        },
        from: { id: 12345, username: "testuser" },
        text: "/status",
        date: 1736380800,
        message_id: 42,
        message_thread_id: 99,
      },
      match: "",
    });

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99 }),
    );
  });

  it("streams tool summaries for native slash commands", async () => {
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    commandSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();
    replySpy.mockImplementation(async (_ctx, opts) => {
      await opts?.onToolResult?.({ text: "tool update" });
      return { text: "final reply" };
    });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const verboseHandler = commandSpy.mock.calls.find((call) => call[0] === "verbose")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!verboseHandler) throw new Error("verbose command handler missing");

    await verboseHandler({
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/verbose on",
        date: 1736380800,
        message_id: 42,
      },
      match: "on",
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toContain("tool update");
    expect(sendMessageSpy.mock.calls[1]?.[1]).toContain("final reply");
  });

  it("dedupes duplicate message updates by update_id", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const ctx = {
      update: { update_id: 111 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await handler(ctx);
    await handler(ctx);

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("dedupes duplicate callback_query updates by update_id", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const ctx = {
      update: { update_id: 222 },
      callbackQuery: {
        id: "cb-1",
        data: "ping",
        from: { id: 789, username: "testuser" },
        message: {
          chat: { id: 123, type: "private" },
          date: 1736380800,
          message_id: 9001,
        },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({}),
    };

    await handler(ctx);
    await handler(ctx);

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows distinct callback_query ids without update_id", async () => {
    onSpy.mockReset();
    const replySpy = replyModule.__replySpy as unknown as ReturnType<typeof vi.fn>;
    replySpy.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      callbackQuery: {
        id: "cb-1",
        data: "ping",
        from: { id: 789, username: "testuser" },
        message: {
          chat: { id: 123, type: "private" },
          date: 1736380800,
          message_id: 9001,
        },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({}),
    });

    await handler({
      callbackQuery: {
        id: "cb-2",
        data: "ping",
        from: { id: 789, username: "testuser" },
        message: {
          chat: { id: 123, type: "private" },
          date: 1736380800,
          message_id: 9001,
        },
      },
      me: { username: "clawdbot_bot" },
      getFile: async () => ({}),
    });

    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  it("registers message_reaction handler", () => {
    onSpy.mockReset();
    createTelegramBot({ token: "tok" });
    const reactionHandler = onSpy.mock.calls.find((call) => call[0] === "message_reaction");
    expect(reactionHandler).toBeDefined();
  });

  it("enqueues system event for reaction", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 500 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada", username: "ada_bot" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Telegram reaction added: 👍 by Ada (@ada_bot) on msg 42",
      expect.objectContaining({
        contextKey: expect.stringContaining("telegram:reaction:add:1234:42:9"),
      }),
    );
  });

  it("skips reaction when reactionNotifications is off", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "off" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 501 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("defaults reactionNotifications to own", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 502 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 43,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("allows reaction in all mode regardless of message sender", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🎉" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Telegram reaction added: 🎉 by Ada on msg 99",
      expect.any(Object),
    );
  });

  it("skips reaction in own mode when message is not sent by bot", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();
    wasSentByBot.mockReturnValue(false);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🎉" }],
      },
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("allows reaction in own mode when message is sent by bot", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "own" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🎉" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
  });

  it("skips reaction from bot users", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();
    wasSentByBot.mockReturnValue(true);

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 503 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 99,
        user: { id: 9, first_name: "Bot", is_bot: true },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🎉" }],
      },
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("skips reaction removal (only processes added reactions)", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 504 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada" },
        date: 1736380800,
        old_reaction: [{ type: "emoji", emoji: "👍" }],
        new_reaction: [],
      },
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("uses correct session key for forum group reactions with topic", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 505 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 100,
        message_thread_id: 42,
        user: { id: 10, first_name: "Bob", username: "bob_user" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "🔥" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Telegram reaction added: 🔥 by Bob (@bob_user) on msg 100",
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:5678:topic:42"),
        contextKey: expect.stringContaining("telegram:reaction:add:5678:100:10"),
      }),
    );
  });

  it("uses correct session key for forum group reactions in general topic", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 506 },
      messageReaction: {
        chat: { id: 5678, type: "supergroup", is_forum: true },
        message_id: 101,
        // No message_thread_id - should default to general topic (1)
        user: { id: 10, first_name: "Bob" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "👀" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Telegram reaction added: 👀 by Bob on msg 101",
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:5678:topic:1"),
        contextKey: expect.stringContaining("telegram:reaction:add:5678:101:10"),
      }),
    );
  });

  it("uses correct session key for regular group reactions without topic", async () => {
    onSpy.mockReset();
    enqueueSystemEvent.mockReset();

    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message_reaction") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      update: { update_id: 507 },
      messageReaction: {
        chat: { id: 9999, type: "group" },
        message_id: 200,
        user: { id: 11, first_name: "Charlie" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "❤️" }],
      },
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Telegram reaction added: ❤️ by Charlie on msg 200",
      expect.objectContaining({
        sessionKey: expect.stringContaining("telegram:group:9999"),
        contextKey: expect.stringContaining("telegram:reaction:add:9999:200:11"),
      }),
    );
    // Verify session key does NOT contain :topic:
    const sessionKey = enqueueSystemEvent.mock.calls[0][1].sessionKey;
    expect(sessionKey).not.toContain(":topic:");
  });
});
