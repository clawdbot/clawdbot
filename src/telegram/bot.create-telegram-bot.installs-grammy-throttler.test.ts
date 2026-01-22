import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { escapeRegExp, formatEnvelopeTimestamp } from "../../test/helpers/envelope-timestamp.js";
import { resetInboundDedupe } from "../auto-reply/reply/inbound-dedupe.js";
import { createTelegramBot, getTelegramSequentialKey } from "./bot.js";
import { resolveTelegramFetch } from "./fetch.js";

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
      public options?: {
        client?: { fetch?: typeof fetch; timeoutSeconds?: number };
      },
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

const replyModule = await import("../auto-reply/reply.js");

const getOnHandler = (event: string) => {
  const handler = onSpy.mock.calls.find((call) => call[0] === event)?.[1];
  if (!handler) throw new Error(`Missing handler for event: ${event}`);
  return handler as (ctx: Record<string, unknown>) => Promise<void>;
};

const ORIGINAL_TZ = process.env.TZ;

describe("createTelegramBot", () => {
  beforeEach(() => {
    process.env.TZ = "UTC";
    resetInboundDedupe();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
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
    middlewareUseSpy.mockReset();
    sequentializeSpy.mockReset();
    botCtorSpy.mockReset();
    sequentializeKey = undefined;
  });
  afterEach(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  // groupPolicy tests

  it("installs grammY throttler", () => {
    createTelegramBot({ token: "tok" });
    expect(throttlerSpy).toHaveBeenCalledTimes(1);
    expect(useSpy).toHaveBeenCalledWith("throttler");
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
      expect(fetchImpl).toBeTypeOf("function");
      expect(fetchImpl).not.toBe(fetchSpy);
      const clientFetch = (botCtorSpy.mock.calls[0]?.[1] as { client?: { fetch?: unknown } })
        ?.client?.fetch;
      expect(clientFetch).toBeTypeOf("function");
      expect(clientFetch).not.toBe(fetchSpy);
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
  it("passes timeoutSeconds even without a custom fetch", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], timeoutSeconds: 60 },
      },
    });
    createTelegramBot({ token: "tok" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 60 }),
      }),
    );
  });
  it("prefers per-account timeoutSeconds overrides", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          timeoutSeconds: 60,
          accounts: {
            foo: { timeoutSeconds: 61 },
          },
        },
      },
    });
    createTelegramBot({ token: "tok", accountId: "foo" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 61 }),
      }),
    );
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
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123 }, text: "/stop" },
      }),
    ).toBe("telegram:123:control");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123 }, text: "/status" },
      }),
    ).toBe("telegram:123:control");
    expect(
      getTelegramSequentialKey({
        message: { chat: { id: 123 }, text: "stop" },
      }),
    ).toBe("telegram:123:control");
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
      const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
      const timestampPattern = escapeRegExp(expectedTimestamp);
      expect(payload.Body).toMatch(
        new RegExp(
          `^\\[Telegram Ada Lovelace \\(@ada_bot\\) id:1234 (\\+\\d+[smhd] )?${timestampPattern}\\]`,
        ),
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
});
