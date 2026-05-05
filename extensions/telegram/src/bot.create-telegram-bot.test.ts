import { escapeRegExp, formatEnvelopeTimestamp } from "openclaw/plugin-sdk/channel-test-helpers";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotOptions } from "./bot.types.js";
const harness = await import("./bot.create-telegram-bot.test-harness.js");
const conversationRuntime = await import("openclaw/plugin-sdk/conversation-runtime");
const configMutation = await import("openclaw/plugin-sdk/config-mutation");
const sessionStoreRuntime = await import("openclaw/plugin-sdk/session-store-runtime");
const EYES_EMOJI = "\u{1F440}";
const {
  answerCallbackQuerySpy,
  botCtorSpy,
  commandSpy,
  dispatchReplyWithBufferedBlockDispatcher,
  editMessageReplyMarkupSpy,
  editMessageTextSpy,
  enqueueSystemEventSpy,
  getLoadWebMediaMock,
  getChatSpy,
  getLoadConfigMock,
  getLoadSessionStoreMock,
  getOnHandler,
  getReadChannelAllowFromStoreMock,
  getUpsertChannelPairingRequestMock,
  listSkillCommandsForAgents,
  makeForumGroupMessageCtx,
  middlewareUseSpy,
  onSpy,
  replySpy,
  resolveExecApprovalSpy,
  sendAnimationSpy,
  sendChatActionSpy,
  sendMessageSpy,
  sendPhotoSpy,
  sequentializeSpy,
  setSessionStoreEntriesForTest,
  setMessageReactionSpy,
  setMyCommandsSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
  throttlerSpy,
  useSpy,
} = harness;
const { resolveTelegramFetch } = await import("./fetch.js");
const {
  createTelegramBotCore: createTelegramBotBase,
  getTelegramSequentialKey,
  setTelegramBotRuntimeForTest,
} = await import("./bot-core.js");
const { resetTelegramForumFlagCacheForTest } = await import("./bot/helpers.js");
let createTelegramBot: (
  opts: TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();
const loadSessionStore = getLoadSessionStoreMock();
const loadWebMedia = getLoadWebMediaMock();
const readChannelAllowFromStore = getReadChannelAllowFromStoreMock();
const upsertChannelPairingRequest = getUpsertChannelPairingRequestMock();

const ORIGINAL_TZ = process.env.TZ;
const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

type TelegramMiddlewareTestContext = Record<string, unknown>;
type TelegramMiddleware = (
  ctx: TelegramMiddlewareTestContext,
  next: () => Promise<void>,
) => Promise<void> | void;

function getRegisteredTelegramMiddlewares(): TelegramMiddleware[] {
  return middlewareUseSpy.mock.calls
    .map((call) => call[0])
    .filter((fn): fn is TelegramMiddleware => typeof fn === "function");
}

async function runTelegramMiddlewareChain(params: {
  ctx: TelegramMiddlewareTestContext;
  finalHandler: (ctx: TelegramMiddlewareTestContext) => Promise<void>;
}): Promise<void> {
  const middlewares = getRegisteredTelegramMiddlewares();
  let idx = -1;
  const dispatch = async (i: number): Promise<void> => {
    if (i <= idx) {
      throw new Error("middleware dispatch called multiple times");
    }
    idx = i;
    const fn = middlewares[i];
    if (!fn) {
      await params.finalHandler(params.ctx);
      return;
    }
    await fn(params.ctx, async () => dispatch(i + 1));
  };
  await dispatch(0);
}

function installPerKeySequentializer(): void {
  sequentializeSpy.mockImplementationOnce(() => {
    const lanes = new Map<string, Promise<void>>();
    return async (ctx: TelegramMiddlewareTestContext, next: () => Promise<void>) => {
      const key = harness.sequentializeKey?.(ctx) ?? "default";
      const previous = lanes.get(key) ?? Promise.resolve();
      const current = previous.then(async () => {
        await next();
      });
      lanes.set(
        key,
        current.catch(() => undefined),
      );
      try {
        await current;
      } finally {
        if (lanes.get(key) === current) {
          lanes.delete(key);
        }
      }
    };
  });
}

function mockTelegramConfigWrites() {
  return vi.spyOn(configMutation, "replaceConfigFile").mockResolvedValue({} as never);
}

async function withEnvAsync(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function flushTelegramTestMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createTelegramBot", () => {
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });
  beforeEach(() => {
    resetTelegramForumFlagCacheForTest();
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  // groupPolicy tests

  it("installs grammY throttler", () => {
    createTelegramBot({ token: "tok" });
    expect(throttlerSpy).toHaveBeenCalledTimes(1);
    expect(useSpy).toHaveBeenCalledWith("throttler");
  });

  it("logs middleware errors through grammY catch without rethrowing", () => {
    const runtime = {
      error: vi.fn(),
    } as unknown as NonNullable<TelegramBotOptions["runtime"]>;
    const bot = createTelegramBot({ token: "tok", runtime });
    const catchMock = bot.catch as unknown as {
      mock: { calls: Array<[(err: unknown) => void]> };
    };
    const errorHandler = catchMock.mock.calls[0]?.[0];

    expect(errorHandler).toBeTypeOf("function");
    expect(() => errorHandler?.(new Error("handler boom"))).not.toThrow();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("telegram bot error:"));
  });

  it("uses wrapped fetch when global fetch is available", () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    try {
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
    }
  });
  it("applies global and per-account timeoutSeconds", () => {
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
    botCtorSpy.mockClear();

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

  it("keeps low timeoutSeconds above the outbound request guard", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], timeoutSeconds: 10 },
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

  it("keeps polling client timeout above the outbound request guard", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], timeoutSeconds: 10 },
      },
    });
    createTelegramBot({ token: "tok", minimumClientTimeoutSeconds: 45 });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 60 }),
      }),
    );
  });

  it("passes startup probe botInfo to grammY", () => {
    const botInfo = {
      id: 123456,
      is_bot: true,
      first_name: "OpenClaw",
      username: "openclaw_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      can_manage_bots: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    } as const;

    createTelegramBot({ token: "tok", botInfo });

    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        botInfo,
      }),
    );
  });

  it("normalizes full Telegram bot endpoint apiRoot before passing it to grammY", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          apiRoot: "https://api.telegram.org/bot123456:ABC/",
        },
      },
    });

    createTelegramBot({ token: "tok" });

    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ apiRoot: "https://api.telegram.org" }),
      }),
    );
  });

  it("sequentializes updates by chat and thread", () => {
    createTelegramBot({ token: "tok" });
    expect(sequentializeSpy).toHaveBeenCalledTimes(1);
    expect(middlewareUseSpy).toHaveBeenCalledWith(sequentializeSpy.mock.results[0]?.value);
    expect(harness.sequentializeKey).toBe(getTelegramSequentialKey);
  });

  it("lets /status bypass a busy Telegram topic lane", async () => {
    installPerKeySequentializer();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    const events: string[] = [];
    let releaseTopicTurn!: () => void;
    const topicGate = new Promise<void>((resolve) => {
      releaseTopicTurn = resolve;
    });

    createTelegramBot({ token: "tok" });
    const sequentializer = sequentializeSpy.mock.results[0]?.value as
      | TelegramMiddleware
      | undefined;
    expect(sequentializer).toBeDefined();
    if (!sequentializer) {
      return;
    }

    const busyMessage = makeForumGroupMessageCtx({ threadId: 99, text: "hello there" }).message;
    const statusMessage = makeForumGroupMessageCtx({ threadId: 99, text: "/status" }).message;
    const busyCtx = {
      ...makeForumGroupMessageCtx({ threadId: 99, text: "hello there" }),
      message: { ...busyMessage, message_id: 101 },
      update: { update_id: 101 },
    };
    const statusCtx = {
      ...makeForumGroupMessageCtx({ threadId: 99, text: "/status" }),
      message: { ...statusMessage, message_id: 102 },
      update: { update_id: 102 },
    };

    const busyPromise = sequentializer(busyCtx, async () => {
      events.push("busy:start");
      await topicGate;
      events.push("busy:end");
    });

    await flushTelegramTestMicrotasks();
    expect(events).toEqual(["busy:start"]);

    await sequentializer(statusCtx, async () => {
      events.push("status");
    });

    expect(events).toEqual(["busy:start", "status"]);

    releaseTopicTurn();
    await busyPromise;
    expect(events).toEqual(["busy:start", "status", "busy:end"]);
  });

  it("keeps ordinary Telegram messages serialized within the same topic", async () => {
    installPerKeySequentializer();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: { "*": { requireMention: false } },
        },
      },
    });

    const startedBodies: string[] = [];
    let releaseFirstTurn!: () => void;
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });

    replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      const body = ctx.Body ?? "";
      startedBodies.push(body);
      if (body.includes("first message")) {
        await firstTurnGate;
      }
      return { text: `reply:${body}` };
    });

    createTelegramBot({ token: "tok" });
    const messageHandler = getOnHandler("message") as (
      ctx: TelegramMiddlewareTestContext,
    ) => Promise<void>;

    const firstCtx = {
      ...makeForumGroupMessageCtx({ threadId: 99, text: "first message" }),
      message: {
        ...makeForumGroupMessageCtx({ threadId: 99, text: "first message" }).message,
        message_id: 201,
      },
      update: { update_id: 201 },
    };
    const secondCtx = {
      ...makeForumGroupMessageCtx({ threadId: 99, text: "second message" }),
      message: {
        ...makeForumGroupMessageCtx({ threadId: 99, text: "second message" }).message,
        message_id: 202,
      },
      update: { update_id: 202 },
    };

    const firstPromise = runTelegramMiddlewareChain({
      ctx: firstCtx,
      finalHandler: messageHandler,
    });

    await vi.waitFor(() => {
      expect(startedBodies).toHaveLength(1);
      expect(startedBodies[0]).toContain("first message");
    });

    const secondPromise = runTelegramMiddlewareChain({
      ctx: secondCtx,
      finalHandler: messageHandler,
    });

    await Promise.resolve();
    expect(startedBodies).toHaveLength(1);
    expect(startedBodies[0]).toContain("first message");
    expect(sendMessageSpy).not.toHaveBeenCalled();

    releaseFirstTurn();
    await Promise.all([firstPromise, secondPromise]);

    expect(startedBodies).toHaveLength(2);
    expect(startedBodies[0]).toContain("first message");
    expect(startedBodies[1]).toContain("second message");
    const sentBodies = sendMessageSpy.mock.calls.map((call) => String(call[1]));
    expect(sentBodies[0]).toContain("first message");
    expect(sentBodies[1]).toContain("second message");
  });

  it("preserves same-chat reply order when a debounced run is still active", async () => {
    const DEBOUNCE_MS = 4321;
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      messages: {
        inbound: {
          debounceMs: DEBOUNCE_MS,
        },
      },
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    sequentializeSpy.mockImplementationOnce(() => {
      const lanes = new Map<string, Promise<void>>();
      return async (ctx: Record<string, unknown>, next: () => Promise<void>) => {
        const key = harness.sequentializeKey?.(ctx) ?? "default";
        const previous = lanes.get(key) ?? Promise.resolve();
        const current = previous.then(async () => {
          await next();
        });
        lanes.set(
          key,
          current.catch(() => undefined),
        );
        try {
          await current;
        } finally {
          if (lanes.get(key) === current) {
            lanes.delete(key);
          }
        }
      };
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const startedBodies: string[] = [];
    let releaseFirstRun!: () => void;
    const firstRunGate = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });

    replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      const body = ctx.Body ?? "";
      startedBodies.push(body);
      if (body.includes("first")) {
        await firstRunGate;
      }
      return { text: `reply:${body}` };
    });

    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      const middlewares = middlewareUseSpy.mock.calls
        .map((call) => call[0])
        .filter(
          (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
            typeof fn === "function",
        );
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await handler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const extractLatestDebounceFlush = () => {
      const debounceCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call) => call[1] === DEBOUNCE_MS,
      );
      expect(debounceCallIndex).toBeGreaterThanOrEqual(0);
      clearTimeout(
        setTimeoutSpy.mock.results[debounceCallIndex]?.value as ReturnType<typeof setTimeout>,
      );
      return setTimeoutSpy.mock.calls[debounceCallIndex]?.[0] as (() => Promise<void>) | undefined;
    };

    try {
      createTelegramBot({ token: "tok" });

      await runMiddlewareChain({
        update: { update_id: 101 },
        message: {
          chat: { id: 7, type: "private" },
          text: "first",
          date: 1736380800,
          message_id: 101,
          from: { id: 42, first_name: "Ada" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      const flushFirst = extractLatestDebounceFlush();
      const firstFlush = flushFirst?.();

      await vi.waitFor(() => {
        expect(startedBodies).toHaveLength(1);
        expect(startedBodies[0]).toContain("first");
      });

      await runMiddlewareChain({
        update: { update_id: 102 },
        message: {
          chat: { id: 7, type: "private" },
          text: "second",
          date: 1736380801,
          message_id: 102,
          from: { id: 42, first_name: "Ada" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      const flushSecond = extractLatestDebounceFlush();
      const secondFlush = flushSecond?.();
      await Promise.resolve();

      expect(startedBodies).toHaveLength(1);
      expect(sendMessageSpy).not.toHaveBeenCalled();

      releaseFirstRun();
      await Promise.all([firstFlush, secondFlush]);

      await vi.waitFor(() => {
        expect(startedBodies).toHaveLength(2);
        expect(sendMessageSpy).toHaveBeenCalledTimes(2);
      });

      expect(startedBodies[0]).toContain("first");
      expect(startedBodies[1]).toContain("second");
      expect(sendMessageSpy.mock.calls.map((call) => call[1])).toEqual([
        expect.stringContaining("first"),
        expect.stringContaining("second"),
      ]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("routes callback_query payloads as messages and answers callbacks", async () => {
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("cmd:option_a");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-1");
  });
  it("preserves native command source for prefixed callback_query payloads", async () => {
    loadConfig.mockReturnValue({
      commands: { text: false, native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
      callbackQuery: {
        id: "cbq-native-1",
        data: "tgcmd:/fast status",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 10,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.CommandBody).toBe("/fast status");
    expect(payload.CommandSource).toBe("native");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-native-1");
  });
  it("reloads callback model routing bindings without recreating the bot", async () => {
    const buildModelsProviderDataMock =
      telegramBotDepsForTest.buildModelsProviderData as unknown as ReturnType<typeof vi.fn>;
    let boundAgentId = "agent-a";
    loadConfig.mockImplementation(() => ({
      agents: {
        defaults: {
          model: "openai/gpt-4.1",
        },
        list: [{ id: "agent-a" }, { id: "agent-b" }],
      },
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
      bindings: [
        {
          agentId: boundAgentId,
          match: { channel: "telegram", accountId: "default" },
        },
      ],
    }));

    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    const sendModelCallback = async (id: number) => {
      await callbackHandler({
        callbackQuery: {
          id: `cbq-model-${id}`,
          data: "mdl_prov",
          from: { id: 9, first_name: "Ada", username: "ada_bot" },
          message: {
            chat: { id: 1234, type: "private" },
            date: 1736380800 + id,
            message_id: id,
          },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
    };

    buildModelsProviderDataMock.mockClear();
    await sendModelCallback(1);
    expect(buildModelsProviderDataMock).toHaveBeenCalled();
    expect(buildModelsProviderDataMock.mock.calls.at(-1)?.[1]).toBe("agent-a");

    boundAgentId = "agent-b";
    await sendModelCallback(2);
    expect(buildModelsProviderDataMock.mock.calls.at(-1)?.[1]).toBe("agent-b");
  });
  it("wraps inbound message with Telegram envelope", async () => {
    await withEnvAsync({ TZ: "Europe/Vienna" }, async () => {
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
        me: { username: "openclaw_bot" },
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
    });
  });
  it("handles pairing DM flows for new and already-pending requests", async () => {
    const cases = [
      {
        name: "new unknown sender",
        messages: ["hello"],
        expectedSendCount: 1,
        pairingUpsertResults: [{ code: "PAIRCODE", created: true }],
      },
      {
        name: "already pending request",
        messages: ["hello", "hello again"],
        expectedSendCount: 1,
        pairingUpsertResults: [
          { code: "PAIRCODE", created: true },
          { code: "PAIRCODE", created: false },
        ],
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      onSpy.mockClear();
      sendMessageSpy.mockClear();
      replySpy.mockClear();
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "pairing" } },
      });
      readChannelAllowFromStore.mockResolvedValue([]);
      upsertChannelPairingRequest.mockClear();
      let pairingUpsertCall = 0;
      upsertChannelPairingRequest.mockImplementation(async () => {
        const result =
          testCase.pairingUpsertResults[
            Math.min(pairingUpsertCall, testCase.pairingUpsertResults.length - 1)
          ];
        pairingUpsertCall += 1;
        return result;
      });

      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const senderId = Number(`${Date.now()}${index}`.slice(-9));
      for (const text of testCase.messages) {
        await handler({
          message: {
            chat: { id: 1234, type: "private" },
            text,
            date: 1736380800,
            from: { id: senderId, username: "random" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({ download: async () => new Uint8Array() }),
        });
      }

      expect(replySpy, testCase.name).not.toHaveBeenCalled();
      expect(sendMessageSpy, testCase.name).toHaveBeenCalledTimes(testCase.expectedSendCount);
      expect(sendMessageSpy.mock.calls[0]?.[0], testCase.name).toBe(1234);
      const pairingText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(pairingText, testCase.name).toContain(`Your Telegram user id: ${senderId}`);
      expect(pairingText, testCase.name).toContain("Pairing code:");
      expect(pairingText, testCase.name).toContain("openclaw pairing approve telegram");
      expect(sendMessageSpy.mock.calls[0]?.[2], testCase.name).toEqual(
        expect.objectContaining({ parse_mode: "HTML" }),
      );
    }
  });

  it("ignores private self-authored message updates instead of issuing a pairing challenge", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private", first_name: "Harold" },
        message_id: 1884,
        date: 1736380800,
        from: { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
        pinned_message: {
          message_id: 1883,
          date: 1736380799,
          chat: { id: 1234, type: "private", first_name: "Harold" },
          from: { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
          text: "Binding: Review pull request 54118 (openclaw)",
        },
      },
      me: { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("blocks unauthorized DM media before download and sends pairing reply", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRME12", created: true });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    const senderId = Number(`${Date.now()}01`.slice(-9));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 410,
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: senderId, username: "random" },
        },
        me: { username: "openclaw_bot" },
        getFile: getFileSpy,
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const pairingText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(pairingText).toContain("Pairing code:");
      expect(pairingText).toContain("<pre><code>");
      expect(sendMessageSpy.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({ parse_mode: "HTML" }),
      );
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("ignores group self-authored message updates instead of re-processing bot output", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: -1001234, type: "supergroup", title: "OpenClaw Ops" },
        message_id: 1884,
        date: 1736380800,
        from: { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
        text: "approval card update",
      },
      me: { id: 7, is_bot: true, first_name: "OpenClaw", username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
  });

  it("blocks DM media downloads completely when dmPolicy is disabled", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "disabled" } },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 411,
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: 999, username: "random" },
        },
        me: { username: "openclaw_bot" },
        getFile: getFileSpy,
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("blocks unauthorized DM media groups before any photo download", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockResolvedValue({ code: "PAIRME12", created: true });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    const senderId = Number(`${Date.now()}02`.slice(-9));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
    );
    const getFileSpy = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));

    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 412,
          media_group_id: "dm-album-1",
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: senderId, username: "random" },
        },
        me: { username: "openclaw_bot" },
        getFile: getFileSpy,
      });

      expect(getFileSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const pairingText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(pairingText).toContain("Pairing code:");
      expect(pairingText).toContain("<pre><code>");
      expect(sendMessageSpy.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({ parse_mode: "HTML" }),
      );
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
  it("triggers typing cue via onReplyStart", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.typingCallbacks?.onReplyStart?.();
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      },
    );
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: {
        chat: { id: 42, type: "private" },
        from: { id: 999, username: "random" },
        text: "hi",
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(sendChatActionSpy).toHaveBeenCalledWith(42, "typing", undefined);
  });

  it("dedupes duplicate updates for callback_query, message, and channel_post", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groupPolicy: "open",
          groups: {
            "-100777111222": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const channelPostHandler = getOnHandler("channel_post") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await callbackHandler({
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    await callbackHandler({
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    expect(replySpy).toHaveBeenCalledTimes(1);

    replySpy.mockClear();

    await messageHandler({
      update: { update_id: 111 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    await messageHandler({
      update: { update_id: 111 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "hello",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(replySpy).toHaveBeenCalledTimes(1);

    replySpy.mockClear();

    await channelPostHandler({
      channelPost: {
        chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
        from: { id: 98765, is_bot: true, first_name: "wakebot", username: "wake_bot" },
        message_id: 777,
        text: "wake check",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    await channelPostHandler({
      channelPost: {
        chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
        from: { id: 98765, is_bot: true, first_name: "wakebot", username: "wake_bot" },
        message_id: 777,
        text: "wake check",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("persists accepted update offsets before completion", async () => {
    // For this test we need sequentialize(...) to behave like a normal middleware and call next().
    sequentializeSpy.mockImplementationOnce(
      () => async (_ctx: unknown, next: () => Promise<void>) => {
        await next();
      },
    );

    const onUpdateId = vi.fn();
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });

    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 100,
        onUpdateId,
      },
    });

    type Middleware = (
      ctx: Record<string, unknown>,
      next: () => Promise<void>,
    ) => Promise<void> | void;

    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter((fn): fn is Middleware => typeof fn === "function");

    const runMiddlewareChain = async (
      ctx: Record<string, unknown>,
      finalNext: () => Promise<void>,
    ) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await finalNext();
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    let releaseUpdate101: (() => void) | undefined;
    const update101Gate = new Promise<void>((resolve) => {
      releaseUpdate101 = resolve;
    });

    // Start processing update 101 but keep it pending (simulates a long-running turn).
    const p101 = runMiddlewareChain({ update: { update_id: 101 } }, async () => update101Gate);
    // Let update 101 enter the chain and persist acceptance before 102 completes.
    await Promise.resolve();
    expect(onUpdateId).toHaveBeenCalledWith(101);

    // Complete update 102 while 101 is still pending. Restart replay protection is at-most-once.
    await runMiddlewareChain({ update: { update_id: 102 } }, async () => {});
    expect(onUpdateId).toHaveBeenCalledWith(102);

    releaseUpdate101?.();
    await p101;

    expect(onUpdateId.mock.calls.map((call) => Number(call[0]))).toEqual([101, 102]);
  });
  it("logs and swallows update watermark persistence failures", async () => {
    sequentializeSpy.mockImplementationOnce(
      () => async (_ctx: unknown, next: () => Promise<void>) => {
        await next();
      },
    );

    const onUpdateId = vi.fn().mockRejectedValueOnce(new Error("disk boom"));
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    };

    createTelegramBot({
      token: "tok",
      runtime,
      updateOffset: {
        lastUpdateId: 13_099,
        onUpdateId,
      },
    });

    type Middleware = (
      ctx: Record<string, unknown>,
      next: () => Promise<void>,
    ) => Promise<void> | void;

    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter((fn): fn is Middleware => typeof fn === "function");

    const runMiddlewareChain = async (
      ctx: Record<string, unknown>,
      finalNext: () => Promise<void>,
    ) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await finalNext();
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await runMiddlewareChain({ update: { update_id: 13_100 } }, async () => {});
      await flushTelegramTestMicrotasks();
      expect(onUpdateId).toHaveBeenCalledWith(13_100);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("persists failed updates once accepted while preserving same-process retries", async () => {
    sequentializeSpy.mockImplementationOnce(
      () => async (_ctx: unknown, next: () => Promise<void>) => {
        await next();
      },
    );

    const onUpdateId = vi.fn();

    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 200,
        onUpdateId,
      },
    });

    type Middleware = (
      ctx: Record<string, unknown>,
      next: () => Promise<void>,
    ) => Promise<void> | void;

    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter((fn): fn is Middleware => typeof fn === "function");

    const runMiddlewareChain = async (
      ctx: Record<string, unknown>,
      finalNext: () => Promise<void>,
    ) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await finalNext();
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    await expect(
      runMiddlewareChain({ update: { update_id: 201 } }, async () => {
        throw new Error("middleware boom");
      }),
    ).rejects.toThrow("middleware boom");
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).toHaveBeenCalledWith(201);

    await runMiddlewareChain({ update: { update_id: 202 } }, async () => {});

    await flushTelegramTestMicrotasks();
    expect(onUpdateId).toHaveBeenCalledWith(202);

    const retryHandler = vi.fn();
    await runMiddlewareChain({ update: { update_id: 201 } }, async () => {
      retryHandler();
    });

    await flushTelegramTestMicrotasks();
    expect(retryHandler).toHaveBeenCalledTimes(1);
    expect(onUpdateId.mock.calls.map((call) => Number(call[0]))).toEqual([201, 202]);
  });

  it("skips replayed update ids even when the semantic update key differs", async () => {
    sequentializeSpy.mockImplementationOnce(
      () => async (_ctx: unknown, next: () => Promise<void>) => {
        await next();
      },
    );

    const onUpdateId = vi.fn();

    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 300,
        onUpdateId,
      },
    });

    type Middleware = (
      ctx: Record<string, unknown>,
      next: () => Promise<void>,
    ) => Promise<void> | void;

    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter((fn): fn is Middleware => typeof fn === "function");

    const runMiddlewareChain = async (
      ctx: Record<string, unknown>,
      finalNext: () => Promise<void>,
    ) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await finalNext();
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const handler = vi.fn();
    await runMiddlewareChain(
      {
        update: {
          update_id: 301,
          message: { chat: { id: 1 }, message_id: 10 },
        },
      },
      async () => {
        handler();
      },
    );

    const replayHandler = vi.fn();
    await runMiddlewareChain(
      {
        update: {
          update_id: 301,
          message: { chat: { id: 1 }, message_id: 11 },
        },
      },
      async () => {
        replayHandler();
      },
    );

    await flushTelegramTestMicrotasks();
    expect(onUpdateId).toHaveBeenCalledWith(301);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(replayHandler).not.toHaveBeenCalled();
  });
  it("allows distinct callback_query ids without update_id", async () => {
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
      me: { username: "openclaw_bot" },
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({}),
    });

    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  const groupPolicyCases: Array<{
    name: string;
    config: Record<string, unknown>;
    message: Record<string, unknown>;
    expectedReplyCount: number;
  }> = [
    {
      name: "blocks all group messages when groupPolicy is 'disabled'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "disabled",
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "@openclaw_bot hello",
        date: 1736380800,
      },
      expectedReplyCount: 0,
    },
    {
      name: "blocks group messages from senders not in allowFrom when groupPolicy is 'allowlist'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "notallowed" },
        text: "@openclaw_bot hello",
        date: 1736380800,
      },
      expectedReplyCount: 0,
    },
    {
      name: "allows group messages from senders in allowFrom (by ID) when groupPolicy is 'allowlist'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["123456789"],
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "blocks group messages when allowFrom is configured with @username entries (numeric IDs required)",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["@testuser"],
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 0,
    },
    {
      name: "allows group messages from tg:-prefixed allowFrom entries case-insensitively",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["TG:77112533"],
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 77112533, username: "mneves" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "blocks group messages when per-group allowFrom override is explicitly empty",
      config: {
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: {
              "-100123456789": {
                allowFrom: [],
                requireMention: false,
              },
            },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 0,
    },
    {
      name: "allows all group messages when groupPolicy is 'open'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
  ];

  it("applies groupPolicy cases", async () => {
    for (const [index, testCase] of groupPolicyCases.entries()) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: {
          ...testCase.message,
          message_id: 1_000 + index,
          date: 1_736_380_800 + index,
        },
      });
      expect(replySpy.mock.calls.length, testCase.name).toBe(testCase.expectedReplyCount);
    }
  });

  it("routes DMs by telegram accountId binding", async () => {
    const config = {
      channels: {
        telegram: {
          allowFrom: ["*"],
          accounts: {
            opie: {
              botToken: "tok-opie",
              dmPolicy: "open",
              allowFrom: ["*"],
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
    };
    loadConfig.mockReturnValue(config);

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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.AccountId).toBe("opie");
    expect(payload.SessionKey).toBe("agent:opie:main");
  });

  it("reloads DM routing bindings between messages without recreating the bot", async () => {
    let boundAgentId = "agent-a";
    const configForAgent = (agentId: string) => ({
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: {
            work: {
              botToken: "tok-work",
              dmPolicy: "open",
              allowFrom: ["*"],
            },
            opie: {
              botToken: "tok-opie",
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      },
      agents: {
        list: [{ id: "agent-a" }, { id: "agent-b" }],
      },
      bindings: [
        {
          agentId,
          match: { channel: "telegram", accountId: "opie" },
        },
      ],
    });
    loadConfig.mockImplementation(() => configForAgent(boundAgentId));

    createTelegramBot({ token: "tok", accountId: "opie" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const sendDm = async (messageId: number, text: string) => {
      await handler({
        message: {
          chat: { id: 123, type: "private" },
          from: { id: 999, username: "testuser" },
          text,
          date: 1736380800 + messageId,
          message_id: messageId,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
    };

    await sendDm(42, "hello one");
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0]?.[0].AccountId).toBe("opie");
    expect(replySpy.mock.calls[0]?.[0].SessionKey).toContain("agent:agent-a:");

    boundAgentId = "agent-b";
    await sendDm(43, "hello two");
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls[1]?.[0].AccountId).toBe("opie");
    expect(replySpy.mock.calls[1]?.[0].SessionKey).toContain("agent:agent-b:");
  });

  it("reloads topic agent overrides between messages without recreating the bot", async () => {
    let topicAgentId = "topic-a";
    loadConfig.mockImplementation(() => ({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: {
            "-1001234567890": {
              requireMention: false,
              topics: {
                "99": {
                  agentId: topicAgentId,
                },
              },
            },
          },
        },
      },
      agents: {
        list: [{ id: "topic-a" }, { id: "topic-b" }],
      },
    }));

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    const sendTopicMessage = async (messageId: number) => {
      await handler({
        message: {
          chat: { id: -1001234567890, type: "supergroup", title: "Forum Group", is_forum: true },
          from: { id: 12345, username: "testuser" },
          text: "hello",
          date: 1736380800 + messageId,
          message_id: messageId,
          message_thread_id: 99,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
    };

    await sendTopicMessage(301);
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0]?.[0].SessionKey).toContain("agent:topic-a:");

    topicAgentId = "topic-b";
    await sendTopicMessage(302);
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls[1]?.[0].SessionKey).toContain("agent:topic-b:");
  });

  it("routes non-default account DMs to the per-account fallback session without explicit bindings", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: {
            work: {
              botToken: "tok-work",
              dmPolicy: "open",
              allowFrom: ["*"],
            },
            opie: {
              botToken: "tok-opie",
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      },
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0]?.[0];
    expect(payload.AccountId).toBe("opie");
    expect(payload.SessionKey).toContain("agent:main:telegram:opie:");
  });

  it("applies group mention overrides and fallback behavior", async () => {
    const cases: Array<{
      config: Record<string, unknown>;
      message: Record<string, unknown>;
      me?: Record<string, unknown>;
    }> = [
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: {
                "*": { requireMention: true },
                "123": { requireMention: false },
              },
            },
          },
        },
        message: {
          chat: { id: 123, type: "group", title: "Dev Chat" },
          text: "hello",
          date: 1736380800,
        },
      },
      {
        config: {
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
        },
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
      },
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: false } },
            },
          },
        },
        message: {
          chat: { id: 456, type: "group", title: "Ops" },
          text: "hello",
          date: 1736380800,
        },
      },
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: true } },
            },
          },
        },
        message: {
          chat: { id: 789, type: "group", title: "No Me" },
          text: "hello",
          date: 1736380800,
        },
        me: {},
      },
    ];

    for (const testCase of cases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: testCase.message,
        me: testCase.me,
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
    }
  });

  it("routes forum topics to parent or topic-specific bindings", async () => {
    const cases: Array<{
      config: Record<string, unknown>;
      expectedSessionKeyFragment: string;
      text: string;
    }> = [
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: false } },
            },
          },
          agents: {
            list: [{ id: "forum-agent" }],
          },
          bindings: [
            {
              agentId: "forum-agent",
              match: {
                channel: "telegram",
                peer: { kind: "group", id: "-1001234567890" },
              },
            },
          ],
        },
        expectedSessionKeyFragment: "agent:forum-agent:",
        text: "hello from topic",
      },
      {
        config: {
          channels: {
            telegram: {
              groupPolicy: "open",
              groups: { "*": { requireMention: false } },
            },
          },
          agents: {
            list: [{ id: "topic-agent" }, { id: "group-agent" }],
          },
          bindings: [
            {
              agentId: "topic-agent",
              match: {
                channel: "telegram",
                peer: { kind: "group", id: "-1001234567890:topic:99" },
              },
            },
            {
              agentId: "group-agent",
              match: {
                channel: "telegram",
                peer: { kind: "group", id: "-1001234567890" },
              },
            },
          ],
        },
        expectedSessionKeyFragment: "agent:topic-agent:",
        text: "hello from topic 99",
      },
    ];

    for (const testCase of cases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: {
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Forum Group",
            is_forum: true,
          },
          from: { id: 999, username: "testuser" },
          text: testCase.text,
          date: 1736380800,
          message_id: 42,
          message_thread_id: 99,
        },
      });
      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.SessionKey).toContain(testCase.expectedSessionKeyFragment);
      expect(payload.BodyForAgent).toBe(testCase.text);
      expect(payload.BodyForAgent).not.toContain("t.me/c/");
    }
  });

  it("sends GIF replies as animations", async () => {
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendAnimationSpy).toHaveBeenCalledTimes(1);
    expect(sendAnimationSpy).toHaveBeenCalledWith("1234", expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
      reply_to_message_id: undefined,
    });
    expect(sendPhotoSpy).not.toHaveBeenCalled();
    expect(loadWebMedia).toHaveBeenCalledTimes(1);
    expect(loadWebMedia.mock.calls[0]?.[0]).toBe("https://example.com/fun");
  });

  function resetHarnessSpies() {
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
    setMessageReactionSpy.mockClear();
    setMyCommandsSpy.mockClear();
  }
  function getMessageHandler() {
    createTelegramBot({ token: "tok" });
    return getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
  }
  async function dispatchMessage(params: {
    message: Record<string, unknown>;
    me?: Record<string, unknown>;
  }) {
    const handler = getMessageHandler();
    await handler({
      message: params.message,
      me: params.me ?? { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
  }

  it("accepts mentionPatterns matches with and without unrelated mentions", async () => {
    const cases = [
      {
        name: "plain mention pattern text",
        message: {
          chat: { id: 7, type: "group", title: "Test Group" },
          text: "bert: introduce yourself",
          date: 1736380800,
          message_id: 1,
          from: { id: 9, first_name: "Ada" },
        },
        assertEnvelope: true,
      },
      {
        name: "mention pattern plus another @mention",
        message: {
          chat: { id: 7, type: "group", title: "Test Group" },
          text: "bert: hello @alice",
          entities: [{ type: "mention", offset: 12, length: 6 }],
          date: 1736380801,
          message_id: 3,
          from: { id: 9, first_name: "Ada" },
        },
        assertEnvelope: false,
      },
    ] as const;

    for (const testCase of cases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue({
        agents: {
          defaults: {
            envelopeTimezone: "utc",
          },
        },
        identity: { name: "Bert" },
        messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: true } },
          },
        },
      });

      await dispatchMessage({
        message: testCase.message,
      });

      expect(replySpy.mock.calls.length, testCase.name).toBe(1);
      const payload = replySpy.mock.calls[0][0];
      expect(payload.WasMentioned, testCase.name).toBe(true);
      if (testCase.assertEnvelope) {
        expect(payload.SenderName).toBe("Ada");
        expect(payload.SenderId).toBe("9");
        const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
        const timestampPattern = escapeRegExp(expectedTimestamp);
        expect(payload.Body).toMatch(
          new RegExp(`^\\[Telegram Test Group id:7 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
        );
      }
    }
  });
  it("keeps group envelope headers stable (sender identity is separate)", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    await dispatchMessage({
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
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.SenderName).toBe("Ada Lovelace");
    expect(payload.SenderId).toBe("99");
    expect(payload.SenderUsername).toBe("ada");
    const expectedTimestamp = formatEnvelopeTimestamp(new Date("2025-01-09T00:00:00Z"));
    const timestampPattern = escapeRegExp(expectedTimestamp);
    expect(payload.Body).toMatch(
      new RegExp(`^\\[Telegram Ops id:42 (\\+\\d+[smhd] )?${timestampPattern}\\]`),
    );
  });
  it("reacts to mention-gated group messages when ackReaction is enabled", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      messages: {
        ackReaction: EYES_EMOJI,
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

    await dispatchMessage({
      message: {
        chat: { id: 7, type: "group", title: "Test Group" },
        text: "bert hello",
        date: 1736380800,
        message_id: 123,
        from: { id: 9, first_name: "Ada" },
      },
    });

    expect(setMessageReactionSpy).toHaveBeenCalledWith(7, 123, [
      { type: "emoji", emoji: EYES_EMOJI },
    ]);
  });
  it("clears native commands when disabled", () => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
      commands: { native: false },
    });

    createTelegramBot({ token: "tok" });

    expect(setMyCommandsSpy).toHaveBeenCalledWith([]);
    expect(setMyCommandsSpy).toHaveBeenCalledWith([], {
      scope: { type: "all_group_chats" },
    });
  });
  it("handles requireMention when mentions do and do not resolve", async () => {
    const cases = [
      {
        name: "mention pattern configured but no match",
        config: { messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } } },
        me: { username: "openclaw_bot" },
        expectedReplyCount: 0,
        expectedWasMentioned: undefined,
      },
      {
        name: "mention detection unavailable",
        config: { messages: { groupChat: { mentionPatterns: [] } } },
        me: {},
        expectedReplyCount: 1,
        expectedWasMentioned: false,
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      resetHarnessSpies();
      loadConfig.mockReturnValue({
        ...testCase.config,
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: true } },
          },
        },
      });

      await dispatchMessage({
        message: {
          chat: { id: 7, type: "group", title: "Test Group" },
          text: "hello everyone",
          date: 1_736_380_800 + index,
          message_id: 2 + index,
          from: { id: 9, first_name: "Ada" },
        },
        me: testCase.me,
      });

      expect(replySpy.mock.calls.length, testCase.name).toBe(testCase.expectedReplyCount);
      if (testCase.expectedWasMentioned != null) {
        const payload = replySpy.mock.calls[0][0];
        expect(payload.WasMentioned, testCase.name).toBe(testCase.expectedWasMentioned);
      }
    }
  });
  it("includes reply-to context when a Telegram reply is received", async () => {
    resetHarnessSpies();

    await dispatchMessage({
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
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = replySpy.mock.calls[0][0];
    expect(payload.Body).toContain("[Replying to Ada id:9001]");
    expect(payload.Body).toContain("Can you summarize this?");
    expect(payload.ReplyToId).toBe("9001");
    expect(payload.ReplyToBody).toBe("Can you summarize this?");
    expect(payload.ReplyToSender).toBe("Ada");
  });

  it("blocks group messages for restrictive group config edge cases", async () => {
    const blockedCases = [
      {
        name: "allowlist policy with no groupAllowFrom",
        config: {
          channels: {
            telegram: {
              groupPolicy: "allowlist",
              groups: { "*": { requireMention: false } },
            },
          },
        },
        message: {
          chat: { id: -100123456789, type: "group", title: "Test Group" },
          from: { id: 123456789, username: "testuser" },
          text: "hello",
          date: 1736380800,
        },
      },
      {
        name: "groups map without wildcard",
        config: {
          channels: {
            telegram: {
              groups: {
                "123": { requireMention: false },
              },
            },
          },
        },
        message: {
          chat: { id: 456, type: "group", title: "Ops" },
          text: "@openclaw_bot hello",
          date: 1736380800,
        },
      },
    ] as const;

    for (const testCase of blockedCases) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({ message: testCase.message });
      expect(replySpy.mock.calls.length, testCase.name).toBe(0);
    }
  });
  it("blocks group sender not in groupAllowFrom even when sender is paired in DM store", async () => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["222222222"],
          groups: { "*": { requireMention: false } },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValueOnce(["123456789"]);

    await dispatchMessage({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
    });

    expect(replySpy).not.toHaveBeenCalled();
  });
  it("allows control commands with TG-prefixed groupAllowFrom entries", async () => {
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });
  it("handles forum topic metadata and typing thread fallbacks", async () => {
    const forumCases = [
      {
        name: "topic-scoped forum message",
        threadId: 99,
        expectedTypingThreadId: 99,
        assertTopicMetadata: true,
      },
      {
        name: "General topic forum message",
        threadId: undefined,
        expectedTypingThreadId: 1,
        assertTopicMetadata: false,
      },
    ] as const;

    for (const testCase of forumCases) {
      resetHarnessSpies();
      sendChatActionSpy.mockClear();
      let dispatchCall:
        | {
            ctx: {
              SessionKey?: unknown;
              From?: unknown;
              MessageThreadId?: unknown;
              IsForum?: unknown;
            };
          }
        | undefined;
      dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
        dispatchCall = params as typeof dispatchCall;
        await params.dispatcherOptions.typingCallbacks?.onReplyStart?.();
        return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
      });
      loadConfig.mockReturnValue({
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      });

      const handler = getMessageHandler();
      await handler(makeForumGroupMessageCtx({ threadId: testCase.threadId }));

      const payload = dispatchCall?.ctx;
      expect(payload).toBeDefined();
      if (!payload) {
        continue;
      }
      if (testCase.assertTopicMetadata) {
        expect(payload.SessionKey).toContain("telegram:group:-1001234567890:topic:99");
        expect(payload.From).toBe("telegram:group:-1001234567890:topic:99");
        expect(payload.MessageThreadId).toBe(99);
        expect(payload.IsForum).toBe(true);
      }
      expect(sendChatActionSpy).toHaveBeenCalledWith(-1001234567890, "typing", {
        message_thread_id: testCase.expectedTypingThreadId,
      });
    }
  });

  it("routes General-topic forum messages via getChat when Telegram omits forum metadata", async () => {
    resetHarnessSpies();
    sendChatActionSpy.mockClear();
    getChatSpy.mockResolvedValue({
      id: -1001234567890,
      type: "supergroup",
      is_forum: true,
      title: "Forum Group",
    });
    let dispatchCall:
      | {
          ctx: {
            SessionKey?: unknown;
            From?: unknown;
            MessageThreadId?: unknown;
            IsForum?: unknown;
          };
        }
      | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
      dispatchCall = params as typeof dispatchCall;
      await params.dispatcherOptions.typingCallbacks?.onReplyStart?.();
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    const handler = getMessageHandler();
    await handler({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Forum Group" },
        from: { id: 12345, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(getChatSpy).toHaveBeenCalledOnce();
    expect(getChatSpy).toHaveBeenCalledWith(-1001234567890);
    expect(dispatchCall?.ctx).toEqual(
      expect.objectContaining({
        SessionKey: expect.stringContaining("telegram:group:-1001234567890:topic:1"),
        From: "telegram:group:-1001234567890:topic:1",
        MessageThreadId: 1,
        IsForum: true,
      }),
    );
    expect(sendChatActionSpy).toHaveBeenCalledWith(-1001234567890, "typing", {
      message_thread_id: 1,
    });
  });
  it("threads forum replies only when a topic id exists", async () => {
    const threadCases = [
      { name: "General topic reply", threadId: undefined, expectedMessageThreadId: undefined },
      { name: "topic reply", threadId: 99, expectedMessageThreadId: 99 },
    ] as const;

    for (const testCase of threadCases) {
      resetHarnessSpies();
      replySpy.mockResolvedValue({ text: "response" });
      loadConfig.mockReturnValue({
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      });

      const handler = getMessageHandler();
      await handler(makeForumGroupMessageCtx({ threadId: testCase.threadId }));

      expect(sendMessageSpy.mock.calls.length, testCase.name).toBe(1);
      const sendParams = sendMessageSpy.mock.calls[0]?.[2] as { message_thread_id?: number };
      if (testCase.expectedMessageThreadId == null) {
        expect(sendParams?.message_thread_id, testCase.name).toBeUndefined();
      } else {
        expect(sendParams?.message_thread_id, testCase.name).toBe(testCase.expectedMessageThreadId);
      }
    }
  });

  const allowFromEdgeCases: Array<{
    name: string;
    config: Record<string, unknown>;
    message: Record<string, unknown>;
    expectedReplyCount: number;
  }> = [
    {
      name: "allows direct messages regardless of groupPolicy",
      config: {
        channels: {
          telegram: {
            groupPolicy: "disabled",
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: 123456789, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "allows direct messages with tg/Telegram-prefixed allowFrom entries",
      config: {
        channels: {
          telegram: {
            allowFrom: ["  TG:123456789  "],
          },
        },
      },
      message: {
        chat: { id: 123456789, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "matches direct message allowFrom against sender user id when chat id differs",
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: 777777777, type: "private" },
        from: { id: 123456789, username: "testuser" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "falls back to direct message chat id when sender user id is missing",
      config: {
        channels: {
          telegram: {
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: 123456789, type: "private" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "allows group messages with wildcard in allowFrom when groupPolicy is 'allowlist'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["*"],
            groups: { "*": { requireMention: false } },
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        from: { id: 999999, username: "random" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 1,
    },
    {
      name: "blocks group messages with no sender ID when groupPolicy is 'allowlist'",
      config: {
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            allowFrom: ["123456789"],
          },
        },
      },
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        text: "hello",
        date: 1736380800,
      },
      expectedReplyCount: 0,
    },
  ];

  it("applies allowFrom edge cases", async () => {
    for (const [index, testCase] of allowFromEdgeCases.entries()) {
      resetHarnessSpies();
      loadConfig.mockReturnValue(testCase.config);
      await dispatchMessage({
        message: {
          ...testCase.message,
          message_id: 2_000 + index,
          date: 1_736_380_900 + index,
        },
      });
      expect(replySpy.mock.calls.length, testCase.name).toBe(testCase.expectedReplyCount);
    }
  });
  it("sends replies without native reply threading", async () => {
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
    for (const call of sendMessageSpy.mock.calls) {
      expect(
        (call[2] as { reply_to_message_id?: number } | undefined)?.reply_to_message_id,
      ).toBeUndefined();
    }
  });
  it("prefixes final replies with responsePrefix", async () => {
    replySpy.mockResolvedValue({ text: "final reply" });
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][1]).toBe("PFX final reply");
  });

  it("sends Codex usage-limit reset details as the Telegram reply body", async () => {
    const codexRateLimitText =
      "⚠️ You've reached your Codex subscription usage limit. Next reset in 42 minutes (2026-05-04T21:34:00.000Z). Run /codex account for current usage details.";
    replySpy.mockResolvedValue({ text: codexRateLimitText });
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler({
      message: {
        chat: { id: 5, type: "private" },
        text: "hi",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0][0]).toBe("5");
    expect(sendMessageSpy.mock.calls[0][1]).toBe(codexRateLimitText);
    expect(String(sendMessageSpy.mock.calls[0][1])).not.toContain(
      "All models are temporarily rate-limited",
    );
  });

  it("honors threaded replies for replyToMode=first/all", async () => {
    for (const [mode, messageId] of [
      ["first", 101],
      ["all", 102],
    ] as const) {
      onSpy.mockClear();
      sendMessageSpy.mockClear();
      replySpy.mockClear();
      replySpy.mockResolvedValue({
        text: "a".repeat(4500),
        replyToId: String(messageId),
      });

      createTelegramBot({ token: "tok", replyToMode: mode });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      await handler({
        message: {
          chat: { id: 5, type: "private" },
          text: "hi",
          date: 1736380800,
          message_id: messageId,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });

      expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(1);
      for (const [index, call] of sendMessageSpy.mock.calls.entries()) {
        const params = call[2] as
          | { reply_to_message_id?: number; reply_parameters?: { message_id?: number } }
          | undefined;
        const actual = params?.reply_parameters?.message_id ?? params?.reply_to_message_id;
        if (mode === "all" || index === 0) {
          expect(actual).toBe(messageId);
        } else {
          expect(actual).toBeUndefined();
        }
      }
    }
  });
  it("honors routed group activation from session store", async () => {
    const storePath = "/tmp/openclaw-telegram-group-activation.json";
    const routedGroupEntry = {
      sessionId: "agent:ops:telegram:group:123",
      updatedAt: 0,
      groupActivation: "always",
      chatType: "group",
    } as const;
    setSessionStoreEntriesForTest({
      "agent:ops:telegram:group:123": routedGroupEntry,
    });
    loadSessionStore.mockImplementation(() => ({
      "agent:ops:telegram:group:123": routedGroupEntry,
    }));
    const config = {
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
    };
    loadConfig.mockReturnValue(config);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 123, type: "group", title: "Routing" },
        from: { id: 999, username: "ops" },
        text: "hello",
        date: 1736380800,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("applies topic skill filters and system prompts", async () => {
    let dispatchCall:
      | {
          ctx: {
            GroupSystemPrompt?: unknown;
          };
          replyOptions?: {
            skillFilter?: unknown;
          };
        }
      | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async (params) => {
      dispatchCall = params as typeof dispatchCall;
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });
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

    await handler(makeForumGroupMessageCtx({ threadId: 99 }));

    const payload = dispatchCall?.ctx;
    expect(payload).toBeDefined();
    if (!payload) {
      return;
    }
    expect(payload.GroupSystemPrompt).toBe("Group prompt\n\nTopic prompt");
    expect(dispatchCall?.replyOptions?.skillFilter).toEqual([]);
  });
  it("threads native command replies inside topics", async () => {
    commandSpy.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockResolvedValue({ text: "response" });

    loadConfig.mockReturnValue({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          replyToMode: "first",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    expect(commandSpy).toHaveBeenCalled();
    const handler = commandSpy.mock.calls[0][1] as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      ...makeForumGroupMessageCtx({ threadId: 99, text: "/status" }),
      match: "",
    });

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "-1001234567890",
      expect.any(String),
      expect.objectContaining({ message_thread_id: 99, reply_to_message_id: 42 }),
    );
  });
  it("reloads native command routing bindings between invocations without recreating the bot", async () => {
    commandSpy.mockClear();
    replySpy.mockClear();

    let boundAgentId = "agent-a";
    loadConfig.mockImplementation(() => ({
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
      agents: {
        list: [{ id: "agent-a" }, { id: "agent-b" }],
      },
      bindings: [
        {
          agentId: boundAgentId,
          match: { channel: "telegram", accountId: "default" },
        },
      ],
    }));

    createTelegramBot({ token: "tok" });
    const statusHandler = commandSpy.mock.calls.find((call) => call[0] === "status")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!statusHandler) {
      throw new Error("status command handler missing");
    }

    const invokeStatus = async (messageId: number) => {
      await statusHandler({
        message: {
          chat: { id: 1234, type: "private" },
          from: { id: 9, username: "ada_bot" },
          text: "/status",
          date: 1736380800 + messageId,
          message_id: messageId,
        },
        match: "",
      });
    };

    await invokeStatus(401);
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0]?.[0].SessionKey).toContain("agent:agent-a:");

    boundAgentId = "agent-b";
    await invokeStatus(402);
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls[1]?.[0].SessionKey).toContain("agent:agent-b:");
  });
  it("skips tool summaries for native slash commands", async () => {
    commandSpy.mockClear();
    replySpy.mockImplementation(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
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
    if (!verboseHandler) {
      throw new Error("verbose command handler missing");
    }

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

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toContain("final reply");
  });
  it("dedupes duplicate message updates by update_id", async () => {
    onSpy.mockReset();
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await handler(ctx);
    await handler(ctx);

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("retries native command updates after a bubbled handler failure", async () => {
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
    if (!verboseHandler) {
      throw new Error("verbose command handler missing");
    }

    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await verboseHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const ctx = {
      update: { update_id: 333 },
      message: {
        chat: { id: 12345, type: "private" },
        from: { id: 12345, username: "testuser" },
        text: "/verbose on",
        date: 1736380800,
        message_id: 42,
      },
      match: "on",
    };

    const loadConfigCallsBeforeRetry = loadConfig.mock.calls.length;
    loadConfig.mockImplementationOnce(() => {
      throw new Error("cfg boom");
    });
    await expect(runMiddlewareChain(ctx)).rejects.toThrow("cfg boom");
    const loadConfigCallsAfterFailure = loadConfig.mock.calls.length;
    await runMiddlewareChain(ctx);

    expect(loadConfigCallsAfterFailure).toBe(loadConfigCallsBeforeRetry + 1);
    expect(loadConfig.mock.calls.length).toBeGreaterThan(loadConfigCallsAfterFailure);
  });

  it("retries group migration updates after a bubbled handler failure", async () => {
    const writeConfigFileSpy = mockTelegramConfigWrites();
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groups: {
            "-1001": {
              enabled: true,
            },
          },
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const migrationHandler = getOnHandler("message:migrate_to_chat_id");
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await migrationHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const ctx = {
      update: { update_id: 444 },
      message: {
        chat: { id: -1001, type: "supergroup", title: "Old Group" },
        migrate_to_chat_id: -1002,
      },
    };

    const loadConfigCallsBeforeRetry = loadConfig.mock.calls.length;
    loadConfig.mockImplementationOnce(() => {
      throw new Error("cfg boom");
    });
    try {
      await expect(runMiddlewareChain(ctx)).rejects.toThrow("cfg boom");
      const loadConfigCallsAfterFailure = loadConfig.mock.calls.length;
      await runMiddlewareChain(ctx);

      expect(loadConfigCallsAfterFailure).toBe(loadConfigCallsBeforeRetry + 1);
      expect(loadConfig.mock.calls.length).toBeGreaterThan(loadConfigCallsAfterFailure);
      expect(writeConfigFileSpy).toHaveBeenCalledTimes(1);
    } finally {
      writeConfigFileSpy.mockRestore();
    }
  });

  it("retries reaction updates after a bubbled enqueue failure", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], reactionNotifications: "all" },
      },
    });

    createTelegramBot({ token: "tok" });
    const reactionHandler = getOnHandler("message_reaction");
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await reactionHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const ctx = {
      update: { update_id: 555 },
      messageReaction: {
        chat: { id: 1234, type: "private" },
        message_id: 42,
        user: { id: 9, first_name: "Ada", username: "ada_bot" },
        date: 1736380800,
        old_reaction: [],
        new_reaction: [{ type: "emoji", emoji: "\u{1F44D}" }],
      },
    };

    enqueueSystemEventSpy.mockImplementationOnce(() => {
      throw new Error("queue boom");
    });
    await expect(runMiddlewareChain(ctx)).rejects.toThrow("queue boom");
    await runMiddlewareChain(ctx);

    expect(enqueueSystemEventSpy).toHaveBeenCalledTimes(2);
    expect(enqueueSystemEventSpy.mock.calls.at(-1)?.[0]).toContain("Telegram reaction added:");
  });

  it("retries model callback updates after a bubbled preflight failure", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
      },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    const buildModelsProviderDataMock =
      telegramBotDepsForTest.buildModelsProviderData as unknown as ReturnType<typeof vi.fn>;
    buildModelsProviderDataMock.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await callbackHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const ctx = {
      update: { update_id: 666 },
      callbackQuery: {
        id: "cbq-model-retry-1",
        data: "mdl_prov",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 18,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    buildModelsProviderDataMock.mockImplementationOnce(async () => {
      throw new Error("providers boom");
    });
    await expect(runMiddlewareChain(ctx)).rejects.toThrow("providers boom");
    await runMiddlewareChain(ctx);

    expect(buildModelsProviderDataMock).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy.mock.calls[0]?.[2]).toContain("Select a provider:");
    expect(
      (
        editMessageTextSpy.mock.calls[0]?.[3] as {
          reply_markup?: { inline_keyboard?: unknown[][] };
        }
      )?.reply_markup?.inline_keyboard?.[0]?.[0],
    ).toEqual({
      text: "openai (1)",
      callback_data: "mdl_list_openai_1",
    });
  });

  it("retries command pagination callbacks after a bubbled edit failure", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await callbackHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const ctx = {
      update: { update_id: 777 },
      callbackQuery: {
        id: "cbq-commands-retry-1",
        data: "commands_page_2:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 19,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    editMessageTextSpy.mockImplementationOnce(async () => {
      throw new Error("edit boom");
    });
    await expect(runMiddlewareChain(ctx)).rejects.toThrow("edit boom");
    await runMiddlewareChain(ctx);

    expect(editMessageTextSpy).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy.mock.calls.at(-1)?.[2]).toContain("Commands (2/");
  });

  it("treats permanent command pagination edit failures as completed updates", async () => {
    sequentializeSpy.mockImplementationOnce(
      () => async (_ctx: unknown, next: () => Promise<void>) => {
        await next();
      },
    );

    const onUpdateId = vi.fn();
    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 776,
        onUpdateId,
      },
    });

    const callbackHandler = getOnHandler("callback_query");
    const ctx = {
      update: { update_id: 777 },
      callbackQuery: {
        id: "cbq-commands-permanent-edit-1",
        data: "commands_page_2:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 20,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    editMessageTextSpy.mockRejectedValueOnce(
      new Error("400: Bad Request: message can't be edited"),
    );

    await expect(
      runTelegramMiddlewareChain({
        ctx,
        finalHandler: callbackHandler,
      }),
    ).resolves.toBeUndefined();

    await flushTelegramTestMicrotasks();
    expect(onUpdateId).toHaveBeenCalledWith(777);

    await runTelegramMiddlewareChain({
      ctx,
      finalHandler: callbackHandler,
    });

    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
  });

  it("does not swallow unprefixed command pagination edit failures", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");

    const ctx = {
      update: { update_id: 778 },
      callbackQuery: {
        id: "cbq-commands-non-telegram-edit-1",
        data: "commands_page_2:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 21,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    editMessageTextSpy.mockRejectedValueOnce(new Error("message can't be edited"));

    await expect(
      runTelegramMiddlewareChain({
        ctx,
        finalHandler: callbackHandler,
      }),
    ).rejects.toThrow("message can't be edited");

    await runTelegramMiddlewareChain({
      ctx,
      finalHandler: callbackHandler,
    });

    expect(editMessageTextSpy).toHaveBeenCalledTimes(2);
  });

  it("retries command pagination callbacks after a bubbled preflight failure", async () => {
    const listSkillCommandsMock = listSkillCommandsForAgents as unknown as ReturnType<typeof vi.fn>;

    createTelegramBot({ token: "tok" });
    listSkillCommandsMock.mockClear();
    const callbackHandler = getOnHandler("callback_query");
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await callbackHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const ctx = {
      update: { update_id: 778 },
      callbackQuery: {
        id: "cbq-commands-retry-2",
        data: "commands_page_2:main",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 21,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    listSkillCommandsMock.mockImplementationOnce(() => {
      throw new Error("commands boom");
    });
    await expect(runMiddlewareChain(ctx)).rejects.toThrow("commands boom");
    await runMiddlewareChain(ctx);

    expect(listSkillCommandsMock).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy.mock.calls.at(-1)?.[2]).toContain("Commands (2/");
  });

  it("retries plugin binding approval callbacks after a bubbled resolution failure", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await callbackHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const resolvePluginBindingApprovalSpy = vi.spyOn(
      conversationRuntime,
      "resolvePluginConversationBindingApproval",
    );
    resolvePluginBindingApprovalSpy.mockRejectedValueOnce(new Error("binding boom"));

    const ctx = {
      update: { update_id: 888 },
      callbackQuery: {
        id: "cbq-plugin-binding-retry-1",
        data: conversationRuntime.buildPluginBindingApprovalCustomId("binding-1", "allow-once"),
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 20,
          text: "Plugin approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    try {
      await expect(runMiddlewareChain(ctx)).rejects.toThrow("binding boom");
      await runMiddlewareChain(ctx);
    } finally {
      resolvePluginBindingApprovalSpy.mockRestore();
    }

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toContain("plugin bind approval");
  });

  it("retries exec approval callbacks after a bubbled resolution failure", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          execApprovals: {
            enabled: true,
            approvers: ["9"],
            target: "dm",
          },
        },
      },
    });
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await callbackHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("approval boom"));

    const ctx = {
      update: { update_id: 8895 },
      callbackQuery: {
        id: "cbq-approval-retry-1",
        data: "/approve 138e9b8c allow-once",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 231,
          text: "Approval required.",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await expect(runMiddlewareChain(ctx)).rejects.toThrow("approval boom");
    await runMiddlewareChain(ctx);

    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(2);
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("retries model provider callbacks after a bubbled edit failure", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await callbackHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const ctx = {
      update: { update_id: 889 },
      callbackQuery: {
        id: "cbq-model-provider-retry-1",
        data: "mdl_prov",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 23,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    editMessageTextSpy.mockImplementationOnce(async () => {
      throw new Error("edit boom");
    });
    await expect(runMiddlewareChain(ctx)).rejects.toThrow("edit boom");
    await runMiddlewareChain(ctx);

    expect(editMessageTextSpy).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy.mock.calls.at(-1)?.[2]).toContain("Select a provider:");
    expect(
      (
        editMessageTextSpy.mock.calls.at(-1)?.[3] as {
          reply_markup?: { inline_keyboard?: unknown[][] };
        }
      )?.reply_markup?.inline_keyboard?.[0]?.[0],
    ).toEqual({
      text: "openai (1)",
      callback_data: "mdl_list_openai_1",
    });
  });

  it("retries model selection callbacks after a bubbled session-store failure", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const middlewares = middlewareUseSpy.mock.calls
      .map((call) => call[0])
      .filter(
        (fn): fn is (ctx: Record<string, unknown>, next: () => Promise<void>) => Promise<void> =>
          typeof fn === "function",
      );
    const runMiddlewareChain = async (ctx: Record<string, unknown>) => {
      let idx = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= idx) {
          throw new Error("middleware dispatch called multiple times");
        }
        idx = i;
        const fn = middlewares[i];
        if (!fn) {
          await callbackHandler(ctx);
          return;
        }
        await fn(ctx, async () => dispatch(i + 1));
      };
      await dispatch(0);
    };

    const updateSessionStoreSpy = vi.spyOn(sessionStoreRuntime, "updateSessionStore");
    updateSessionStoreSpy.mockRejectedValueOnce(new Error("session store boom"));

    const ctx = {
      update: { update_id: 890 },
      callbackQuery: {
        id: "cbq-model-select-retry-1",
        data: "mdl_sel_openai/gpt-5.4",
        from: { id: 9, first_name: "Ada", username: "ada_bot" },
        message: {
          chat: { id: 1234, type: "private" },
          date: 1736380800,
          message_id: 24,
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    try {
      await expect(runMiddlewareChain(ctx)).rejects.toThrow("session store boom");
      await runMiddlewareChain(ctx);
    } finally {
      updateSessionStoreSpy.mockRestore();
    }

    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(String(editMessageTextSpy.mock.calls.at(-1)?.[2] ?? "")).toContain(
      "Session-only model selection. Runtime unchanged.",
    );
    expect(
      editMessageTextSpy.mock.calls.some((call) =>
        String(call[2] ?? "").includes("Failed to change model"),
      ),
    ).toBe(false);
  });
});
