// Telegram tests cover bot.create telegram bot plugin behavior.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { escapeRegExp, formatEnvelopeTimestamp } from "openclaw/plugin-sdk/channel-test-helpers";
import type { TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildPluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "openclaw/plugin-sdk/conversation-runtime";
import {
  clearPluginInteractiveHandlers,
  registerPluginInteractiveHandler,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { GetReplyOptions, MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramCallbackContext,
  runTelegramTestMiddlewareChain,
  type TelegramTestContext as TelegramMiddlewareTestContext,
  type TelegramTestMiddleware as TelegramMiddleware,
} from "./bot.test-helpers.js";
import type { TelegramBotOptions } from "./bot.types.js";
import type { TelegramGetChat } from "./bot/types.js";
import { buildTelegramOpaqueCallbackData } from "./native-command-callback-data.js";

vi.mock("openclaw/plugin-sdk/conversation-runtime", { spy: true });

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const pluginStateTestRuntime = await import("openclaw/plugin-sdk/plugin-state-test-runtime");
const configMutation = await import("openclaw/plugin-sdk/config-mutation");
const sessionStoreRuntime = await import("openclaw/plugin-sdk/session-store-runtime");
const EYES_EMOJI = "\u{1F440}";
const tempStateDirs: string[] = [];
let previousStateDir: string | undefined;
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
  throttlerSpy,
  useSpy,
} = harness;
type BuildModelsProviderDataMock = ReturnType<
  typeof vi.fn<NonNullable<typeof telegramBotDepsForTest.buildModelsProviderData>>
>;
const { resolveTelegramFetch } = await import("./fetch.js");
const messageDispatchDedupe = await import("./message-dispatch-dedupe.js");
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");
const { getTelegramSequentialKey } = await import("./sequential-key.js");
const {
  createTelegramSpooledReplayDeferredParticipant,
  recordTelegramMessageProcessingResult,
  runWithTelegramSpooledReplayUpdate,
  TelegramSpooledReplayProcessingError,
} = await import("./bot-processing-outcome.js");
const { TELEGRAM_RICH_TEXT_LIMIT } = await import("./rich-message.js");
const { resolveTelegramConversationRoute } = await import("./conversation-route.js");
const { resetTelegramAccountThrottlersForTest } = await import("./runtime.test-support.js");
const {
  buildTelegramGroupFrom,
  buildTelegramThreadParams,
  buildTypingThreadParams,
  resolveTelegramForumFlag,
  resetTelegramForumFlagCacheForTest,
  resolveTelegramThreadSpec,
} = await import("./bot/helpers.js");
const { resolveTelegramGroupPromptSettings, resolveTelegramScopedGroupConfig } =
  await import("./group-config-helpers.js");
let createTelegramBot: (
  opts: TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

function createTelegramBotTestStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-telegram-bot-"));
  tempStateDirs.push(dir);
  return dir;
}

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
const INBOUND_DEBOUNCE_MS = 4321;

type TelegramMessageHandler = (ctx: TelegramMiddlewareTestContext) => Promise<void>;
type MessagePolicyCase = {
  name: string;
  config: Record<string, unknown>;
  message: Record<string, unknown>;
  expectedReplyCount: number;
};

function makeMessagePolicyCase(params: {
  name: string;
  telegram: Record<string, unknown>;
  expectedReplyCount: number;
  kind?: "private" | "group";
  rootConfig?: Record<string, unknown>;
  message?: Record<string, unknown>;
}): MessagePolicyCase {
  const isGroup = params.kind !== "private";
  return {
    name: params.name,
    config: { ...params.rootConfig, channels: { telegram: params.telegram } },
    message: {
      chat: isGroup
        ? { id: -100123456789, type: "group", title: "Test Group" }
        : { id: 123456789, type: "private" },
      from: { id: 123456789, username: "testuser" },
      text: "hello",
      date: 1736380800,
      ...params.message,
    },
    expectedReplyCount: params.expectedReplyCount,
  };
}

function makePrivateTextContext(params: {
  text: string;
  messageId?: number;
  updateId?: number;
  date?: number;
  chatId?: number;
  from?: Record<string, unknown>;
  message?: Record<string, unknown>;
  downloadable?: boolean;
}): TelegramMiddlewareTestContext {
  const from = params.from ?? { id: 42, first_name: "Ada" };
  return {
    ...(params.updateId === undefined ? {} : { update: { update_id: params.updateId } }),
    message: {
      chat: { id: params.chatId ?? 7, type: "private" },
      text: params.text,
      date: params.date ?? 1736380800,
      ...(params.messageId === undefined ? {} : { message_id: params.messageId }),
      from,
      ...params.message,
    },
    me: { username: "openclaw_bot" },
    getFile: params.downloadable
      ? async () => ({ download: async () => new Uint8Array() })
      : async () => ({}),
  };
}

function makeCallbackRetryContext(params: {
  updateId?: number;
  id: string;
  data: string;
  messageId: number;
  text?: string;
  message?: Record<string, unknown>;
  from?: Record<string, unknown>;
  downloadable?: boolean;
}): TelegramMiddlewareTestContext {
  return {
    ...(params.updateId === undefined ? {} : { update: { update_id: params.updateId } }),
    callbackQuery: {
      id: params.id,
      data: params.data,
      from: params.from ?? { id: 9, first_name: "Ada", username: "ada_bot" },
      message: {
        chat: { id: 1234, type: "private" },
        date: 1736380800,
        message_id: params.messageId,
        ...(params.text === undefined ? {} : { text: params.text }),
        ...params.message,
      },
    },
    me: { username: "openclaw_bot" },
    getFile:
      params.downloadable === false
        ? async () => ({})
        : async () => ({ download: async () => new Uint8Array() }),
  };
}

function configureOpenDm(
  params: {
    debounceMs?: number;
    timezone?: "envelopeTimezone" | "userTimezone";
  } = {},
): void {
  loadConfig.mockReturnValue({
    agents: params.timezone
      ? { defaults: { [params.timezone]: params.timezone === "userTimezone" ? "UTC" : "utc" } }
      : undefined,
    messages: params.debounceMs ? { inbound: { debounceMs: params.debounceMs } } : undefined,
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
  });
}

function getTelegramHandler(name: "message" | "callback_query"): TelegramMessageHandler {
  return requireValue(getOnHandler(name) as TelegramMessageHandler | undefined, `${name} handler`);
}

const getMessageHandler = () => getTelegramHandler("message");
const getCallbackHandler = () => getTelegramHandler("callback_query");

function takeLatestTimerCallback(delayMs: number): () => void {
  const setTimeoutMock = vi.mocked(globalThis.setTimeout);
  const callIndex = setTimeoutMock.mock.calls.findLastIndex((call) => call[1] === delayMs);
  expect(callIndex).toBeGreaterThanOrEqual(0);
  clearTimeout(setTimeoutMock.mock.results[callIndex]?.value as ReturnType<typeof setTimeout>);
  return requireValue(
    setTimeoutMock.mock.calls[callIndex]?.[0] as (() => void) | undefined,
    `timer callback for ${delayMs}ms`,
  );
}

async function dispatchPrivateText(
  messageHandler: TelegramMessageHandler,
  params: Parameters<typeof makePrivateTextContext>[0],
): Promise<void> {
  await runTelegramMiddlewareChain({
    ctx: makePrivateTextContext(params),
    finalHandler: messageHandler,
  });
}

async function dispatchSpooledPrivateText(
  messageHandler: TelegramMessageHandler,
  params: Parameters<typeof makePrivateTextContext>[0] & {
    updateId: number;
    replayUpdate?: "id" | "full";
  },
) {
  const ctx = makePrivateTextContext(params);
  const update = ctx.update ?? {};
  const replayUpdate =
    params.replayUpdate === "full" ? Object.assign({}, update, { message: ctx.message }) : update;
  return await runWithTelegramSpooledReplayUpdate(replayUpdate, async () => {
    await runTelegramMiddlewareChain({ ctx, finalHandler: messageHandler });
  });
}

function setupUpdateOffsetTracker(params: {
  lastUpdateId: number;
  onUpdateId?: ReturnType<typeof vi.fn<(updateId: number) => void | Promise<void>>>;
  runtime?: TelegramBotOptions["runtime"];
}) {
  sequentializeSpy.mockImplementationOnce(
    () => async (_ctx: unknown, next: () => Promise<void>) => {
      await next();
    },
  );
  const onUpdateId = params.onUpdateId ?? vi.fn<(updateId: number) => void | Promise<void>>();
  createTelegramBot({
    token: "tok",
    runtime: params.runtime,
    updateOffset: { lastUpdateId: params.lastUpdateId, onUpdateId },
  });
  return {
    onUpdateId,
    run: (ctx: Record<string, unknown>, finalNext: () => Promise<void>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, async () => finalNext()),
  };
}

async function runTelegramMiddlewareChain(params: {
  ctx: TelegramMiddlewareTestContext;
  finalHandler: (ctx: TelegramMiddlewareTestContext) => Promise<void>;
}): Promise<void> {
  await runTelegramTestMiddlewareChain(middlewareUseSpy, params.ctx, params.finalHandler);
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

async function withTelegramSpooledReplayUpdate<T>(
  update: object,
  fn: () => Promise<T>,
): Promise<T> {
  return (await runWithTelegramSpooledReplayUpdate(update, fn)).value;
}

function mockTelegramConfigWrites() {
  return vi.spyOn(configMutation, "mutateConfigFile").mockResolvedValue({} as never);
}

async function flushTelegramTestMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

function makeGenericCallbackContext(params: { id: string; updateId?: number }) {
  const data = "skip nightly build tonight";
  return createTelegramCallbackContext({
    id: params.id,
    data,
    update: params.updateId === undefined ? undefined : { update_id: params.updateId },
    message: {
      reply_markup: { inline_keyboard: [[{ text: "Skip tonight", callback_data: data }]] },
    },
  });
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(
  value: unknown,
  expected: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
  return record;
}

function getBotCtorOptions(callIndex = 0): Record<string, unknown> {
  const call = requireValue(
    botCtorSpy.mock.calls.at(callIndex),
    `bot constructor call ${callIndex}`,
  );
  expect(call[0]).toBe("tok");
  return requireRecord(call[1], `bot constructor options ${callIndex}`);
}

function expectBotClientFields(expected: Record<string, unknown>, callIndex = 0): void {
  const options = getBotCtorOptions(callIndex);
  expectRecordFields(options.client, expected, `bot constructor client ${callIndex}`);
}

describe("createTelegramBot", () => {
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    if (ORIGINAL_TZ === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = ORIGINAL_TZ;
    }
  });
  afterEach(() => {
    pluginStateTestRuntime.resetPluginStateStoreForTests();
    clearPluginInteractiveHandlers();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    for (const dir of tempStateDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = createTelegramBotTestStateDir();
    resetTelegramForumFlagCacheForTest();
    clearPluginInteractiveHandlers();
    resetTelegramAccountThrottlersForTest();
    throttlerSpy.mockReset();
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
    pluginStateTestRuntime.resetPluginStateStoreForTests({ closeDatabase: false });
  });

  // groupPolicy tests

  it("installs grammY throttler", () => {
    createTelegramBot({ token: "tok" });
    expect(throttlerSpy).toHaveBeenCalledTimes(1);
    expect(useSpy).toHaveBeenCalledWith(expect.any(Function));
  });

  it("reuses the grammY throttler for the same token", () => {
    createTelegramBot({ token: "tok" });
    createTelegramBot({ token: "tok" });
    createTelegramBot({ token: "other" });

    expect(throttlerSpy).toHaveBeenCalledTimes(2);
    expect(useSpy).toHaveBeenCalledTimes(3);
  });

  it("logs middleware errors through grammY catch without rethrowing", () => {
    const runtime = {
      error: vi.fn(),
    } as unknown as NonNullable<TelegramBotOptions["runtime"]>;
    const bot = createTelegramBot({ token: "tok", runtime });
    const catchMock = bot["catch"] as unknown as {
      mock: { calls: Array<[(err: unknown) => void]> };
    };
    const errorHandler = catchMock.mock.calls.at(0)?.[0];

    expect(errorHandler).toBeTypeOf("function");
    errorHandler?.(new Error("handler boom"));
    const errorCalls = (runtime.error as unknown as { mock: { calls: Array<[unknown]> } }).mock
      .calls;
    const errorMessage = sanitizeTerminalText(String(errorCalls[0]?.[0]));
    expect(errorMessage.startsWith("telegram bot error: Error: handler boom")).toBe(true);
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
      const clientFetch = (botCtorSpy.mock.calls.at(0)?.[1] as { client?: { fetch?: unknown } })
        ?.client?.fetch;
      expect(clientFetch).toBeTypeOf("function");
      expect(clientFetch).not.toBe(fetchSpy);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  it("ignores removed global and per-account timeoutSeconds", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], timeoutSeconds: 60 },
      },
    });
    createTelegramBot({ token: "tok" });
    expectBotClientFields({ timeoutSeconds: undefined });
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
    expectBotClientFields({ timeoutSeconds: undefined });
  });

  it("keeps low timeoutSeconds above the outbound request guard", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], timeoutSeconds: 10 },
      },
    });
    createTelegramBot({ token: "tok" });
    expectBotClientFields({ timeoutSeconds: undefined });
  });

  it("keeps polling client timeout above the outbound request guard", () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"], timeoutSeconds: 10 },
      },
    });
    createTelegramBot({ token: "tok", minimumClientTimeoutSeconds: 45 });
    expectBotClientFields({ timeoutSeconds: undefined });
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
      supports_join_request_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    } as const;

    createTelegramBot({ token: "tok", botInfo });

    expect(getBotCtorOptions().botInfo).toBe(botInfo);
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

    expectBotClientFields({ apiRoot: "https://api.telegram.org" });
  });

  it("sequentializes updates by chat and thread", () => {
    createTelegramBot({ token: "tok" });
    expect(sequentializeSpy).toHaveBeenCalledTimes(1);
    expect(middlewareUseSpy).toHaveBeenCalledWith(sequentializeSpy.mock.results[0]?.value);
    expect(harness.sequentializeKey).toBe(getTelegramSequentialKey);
  });

  it("answers callback queries before same-chat sequentialize delays handlers", async () => {
    installPerKeySequentializer();
    createTelegramBot({ token: "tok" });
    const callbackHandler = requireValue(
      getOnHandler("callback_query") as
        | ((ctx: Record<string, unknown>) => Promise<void>)
        | undefined,
      "callback_query handler",
    );
    let releaseBusyUpdate: (() => void) | undefined;
    const busyUpdateGate = new Promise<void>((resolve) => {
      releaseBusyUpdate = resolve;
    });
    const busyMessagePayload = {
      chat: { id: 1234, type: "private" },
      date: 1736380800,
      from: { id: 9, first_name: "Ada", username: "ada_bot" },
      message_id: 41,
      text: "busy",
    };
    const callbackQueryPayload = {
      id: "cbq-pre-sequentialize-1",
      data: "cmd:option_a",
      from: { id: 9, first_name: "Ada", username: "ada_bot" },
      message: {
        chat: { id: 1234, type: "private" },
        date: 1736380800,
        message_id: 42,
      },
    };
    const busyMessage = {
      update: { update_id: 401, message: busyMessagePayload },
      message: busyMessagePayload,
      me: { username: "openclaw_bot" },
    };
    const callbackCtx = {
      update: { update_id: 402, callback_query: callbackQueryPayload },
      callbackQuery: callbackQueryPayload,
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    const busyPromise = runTelegramMiddlewareChain({
      ctx: busyMessage,
      finalHandler: async () => {
        await busyUpdateGate;
      },
    });
    await flushTelegramTestMicrotasks();

    let callbackHandlerStarted = false;
    const callbackPromise = runTelegramMiddlewareChain({
      ctx: callbackCtx,
      finalHandler: async (ctx) => {
        callbackHandlerStarted = true;
        await callbackHandler(ctx);
      },
    });
    await flushTelegramTestMicrotasks();

    expect(callbackHandlerStarted).toBe(false);
    expect(answerCallbackQuerySpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-pre-sequentialize-1");

    if (!releaseBusyUpdate) {
      throw new Error("Expected Telegram busy update release callback to be initialized");
    }
    releaseBusyUpdate();
    await busyPromise;
    await callbackPromise;

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(answerCallbackQuerySpy).toHaveBeenCalledTimes(1);
  });

  it("acknowledges question callbacks before their handler completes", async () => {
    installPerKeySequentializer();
    loadConfig.mockReturnValue({ channels: { telegram: { dmPolicy: "disabled" } } });
    createTelegramBot({ token: "tok" });
    const callbackHandler = requireValue(
      getOnHandler("callback_query") as
        | ((ctx: Record<string, unknown>) => Promise<void>)
        | undefined,
      "callback_query handler",
    );
    answerCallbackQuerySpy.mockClear();
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const callbackQuery = {
      id: "cbq-question-early-ack",
      data: "tgq1:ask_0123456789abcdef0123456789abcdef:1",
      from: { id: 9, first_name: "Ada", username: "ada_bot" },
      message: {
        chat: { id: 1234, type: "private" },
        date: 1736380800,
        message_id: 42,
      },
    };
    const pending = runTelegramMiddlewareChain({
      ctx: {
        update: { update_id: 403, callback_query: callbackQuery },
        callbackQuery,
        me: { username: "openclaw_bot" },
      },
      finalHandler: async (ctx) => {
        await callbackHandler(ctx);
        await handlerGate;
      },
    });
    await flushTelegramTestMicrotasks();

    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-question-early-ack");
    if (!releaseHandler) {
      throw new Error("Expected Telegram question callback release callback to be initialized");
    }
    releaseHandler();
    await pending;
    expect(answerCallbackQuerySpy).toHaveBeenCalledTimes(1);
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
    let releaseTopicTurn: (() => void) | undefined;
    const topicGate = new Promise<void>((resolve) => {
      releaseTopicTurn = resolve;
    });

    createTelegramBot({ token: "tok" });
    const sequentializer = requireValue(
      sequentializeSpy.mock.results[0]?.value as TelegramMiddleware | undefined,
      "telegram sequentializer",
    );

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

    if (!releaseTopicTurn) {
      throw new Error("Expected Telegram topic turn release callback to be initialized");
    }
    releaseTopicTurn();
    await busyPromise;
    expect(events).toEqual(["busy:start", "status", "busy:end"]);
  });

  it("lets Telegram topic messages without chat forum metadata use separate lanes", async () => {
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
    let releaseFirstTopic!: () => void;
    const firstTopicGate = new Promise<void>((resolve) => {
      releaseFirstTopic = resolve;
    });

    createTelegramBot({ token: "tok" });
    const sequentializer = sequentializeSpy.mock.results[0]?.value as
      | TelegramMiddleware
      | undefined;
    if (!sequentializer) {
      throw new Error("Expected sequentialize middleware");
    }

    const topicCtx = (threadId: number, updateId: number) => {
      const base = makeForumGroupMessageCtx({ threadId, text: `topic ${threadId}` });
      return {
        ...base,
        message: {
          ...base.message,
          message_id: updateId,
          is_topic_message: true,
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Forum Group",
          },
        },
        update: { update_id: updateId },
      };
    };

    const firstPromise = sequentializer(topicCtx(10, 301), async () => {
      events.push("first:start");
      await firstTopicGate;
      events.push("first:end");
    });

    await flushTelegramTestMicrotasks();
    expect(events).toEqual(["first:start"]);

    await sequentializer(topicCtx(20, 302), async () => {
      events.push("second");
    });

    expect(events).toEqual(["first:start", "second"]);

    releaseFirstTopic();
    await firstPromise;
    expect(events).toEqual(["first:start", "second", "first:end"]);
  });

  it("keeps ordinary Telegram messages serialized within the same topic", async () => {
    installPerKeySequentializer();
    const events: string[] = [];
    let releaseFirstTurn!: () => void;
    const firstTurnGate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });

    createTelegramBot({ token: "tok" });
    const sequentializer = sequentializeSpy.mock.results[0]?.value as
      | TelegramMiddleware
      | undefined;
    if (!sequentializer) {
      throw new Error("Expected sequentialize middleware");
    }
    const firstCtx = makeForumGroupMessageCtx({ threadId: 99, text: "first message" });
    const secondCtx = makeForumGroupMessageCtx({ threadId: 99, text: "second message" });

    const firstPromise = sequentializer(firstCtx, async () => {
      events.push("first:start");
      await firstTurnGate;
      events.push("first:end");
    });

    await flushTelegramTestMicrotasks();
    expect(events).toEqual(["first:start"]);

    const secondPromise = sequentializer(secondCtx, async () => {
      events.push("second");
    });

    await flushTelegramTestMicrotasks();
    expect(events).toEqual(["first:start"]);

    releaseFirstTurn();
    await Promise.all([firstPromise, secondPromise]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });

  it("preserves same-chat reply order when a debounced run is still active", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });
    installPerKeySequentializer();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const startedBodies: string[] = [];
    let releaseFirstRun: (() => void) | undefined;
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

    try {
      createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      await dispatchPrivateText(messageHandler, { updateId: 101, messageId: 101, text: "first" });

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();

      await vi.waitFor(
        () => {
          expect(startedBodies).toHaveLength(1);
          expect(startedBodies[0]).toContain("first");
        },
        { interval: 1, timeout: 500 },
      );

      await dispatchPrivateText(messageHandler, {
        updateId: 102,
        messageId: 102,
        text: "second",
        date: 1736380801,
      });

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      await Promise.resolve();

      expect(startedBodies).toHaveLength(1);
      expect(sendMessageSpy).not.toHaveBeenCalled();

      if (!releaseFirstRun) {
        throw new Error("Expected first Telegram run release callback to be initialized");
      }
      releaseFirstRun();

      await vi.waitFor(
        () => {
          expect(startedBodies).toHaveLength(2);
          expect(sendMessageSpy).toHaveBeenCalledTimes(2);
        },
        { interval: 1, timeout: 500 },
      );

      expect(startedBodies[0]).toContain("first");
      expect(startedBodies[1]).toContain("second");
      const sentBodies = sendMessageSpy.mock.calls.map((call) => String(call[1]));
      expect(sentBodies[0]).toContain("first");
      expect(sentBodies[1]).toContain("second");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each(["stop", "/stop@openclaw_bot"] as const)(
    "lets %s bypass and cancel pending same-chat inbound debounce",
    async (stopText) => {
      configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "userTimezone" });

      installPerKeySequentializer();

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const startedBodies: string[] = [];
      replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
        await opts?.onReplyStart?.();
        const body = ctx.Body ?? "";
        startedBodies.push(body);
        return { text: `reply:${body}` };
      });

      try {
        createTelegramBot({ token: "tok" });
        const messageHandler = getMessageHandler();
        await dispatchPrivateText(messageHandler, { updateId: 101, messageId: 101, text: "first" });
        const flushFirst = takeLatestTimerCallback(INBOUND_DEBOUNCE_MS);
        await dispatchPrivateText(messageHandler, {
          updateId: 102,
          messageId: 102,
          text: stopText,
          date: 1736380801,
        });

        expect(startedBodies).toHaveLength(1);
        expect(startedBodies[0]).toContain("stop");

        flushFirst();
        await Promise.resolve();
        expect(startedBodies).toHaveLength(1);
        expect(sendMessageSpy.mock.calls.map((call) => String(call[1])).join("\n")).not.toContain(
          "reply:first",
        );

        await dispatchPrivateText(messageHandler, { updateId: 103, messageId: 101, text: "first" });
        takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
        await vi.waitFor(
          () => {
            expect(startedBodies).toHaveLength(2);
          },
          { interval: 1, timeout: 500 },
        );
        expect(startedBodies[1]).toContain("first");
      } finally {
        setTimeoutSpy.mockRestore();
      }
    },
  );

  it("settles spooled replay participants when stop cancels pending inbound debounce", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "userTimezone" });

    installPerKeySequentializer();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      const replay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 201,
        messageId: 201,
        text: "first",
      });

      const deferredWork = replay.deferredWork;
      expect(deferredWork).toBeDefined();
      if (!deferredWork) {
        throw new Error("Expected spooled replay deferred work");
      }
      await dispatchPrivateText(messageHandler, {
        updateId: 202,
        messageId: 202,
        text: "stop",
        date: 1736380801,
      });

      await expect(deferredWork.task).resolves.toEqual({ kind: "skipped" });
      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("settles spooled replay participants when stop cancels pending text fragments", async () => {
    configureOpenDm({ timezone: "envelopeTimezone" });

    installPerKeySequentializer();

    createTelegramBot({ token: "tok" });
    const messageHandler = getMessageHandler();
    const replay = await dispatchSpooledPrivateText(messageHandler, {
      updateId: 211,
      messageId: 211,
      text: "A".repeat(4050),
    });

    const deferredWork = replay.deferredWork;
    expect(deferredWork).toBeDefined();
    if (!deferredWork) {
      throw new Error("Expected spooled replay deferred work");
    }
    await dispatchPrivateText(messageHandler, {
      updateId: 212,
      messageId: 212,
      text: "stop",
      date: 1736380801,
    });

    await expect(deferredWork.task).resolves.toEqual({ kind: "skipped" });
  });

  it("keeps forced text-fragment flush settlement isolated from the triggering replay", async () => {
    configureOpenDm({ timezone: "envelopeTimezone" });

    installPerKeySequentializer();
    const secondDispatchError = new Error("triggering replay failed before adoption");
    replySpy
      .mockResolvedValueOnce({ text: "buffered replay completed" })
      .mockRejectedValueOnce(secondDispatchError);

    createTelegramBot({ token: "tok" });
    const messageHandler = getMessageHandler();

    const bufferedReplay = await dispatchSpooledPrivateText(messageHandler, {
      updateId: 213,
      messageId: 213,
      text: "A".repeat(4050),
      date: 1736381013,
      replayUpdate: "full",
    });
    const bufferedParticipant = requireValue(
      bufferedReplay.deferredWork,
      "buffered replay participant",
    );

    const triggeringReplay = await dispatchSpooledPrivateText(messageHandler, {
      updateId: 214,
      messageId: 215,
      text: "B",
      date: 1736381014,
      replayUpdate: "full",
    });
    const triggeringParticipant = requireValue(
      triggeringReplay.deferredWork,
      "triggering replay participant",
    );

    expect(triggeringParticipant).not.toBe(bufferedParticipant);
    await expect(bufferedParticipant.task).resolves.toEqual({ kind: "completed" });
    await expect(triggeringParticipant.task).resolves.toEqual({
      kind: "failed-retryable",
      error: secondDispatchError,
    });
    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  it("retries deferred adoption after durable commit fails without settling buffered participants", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });

    installPerKeySequentializer();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const commitError = new Error("durable dispatch commit failed");
    const commitSpy = vi
      .spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay")
      .mockRejectedValueOnce(commitError);
    let queuedLifecycle: GetReplyOptions["turnAdoptionLifecycle"];
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      queuedLifecycle = opts?.turnAdoptionLifecycle;
      queuedLifecycle?.onDeferred?.();
      return undefined;
    });

    try {
      createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      const firstReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 221,
        messageId: 221,
        text: "first buffered message",
        date: 1736381021,
      });
      const secondReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 222,
        messageId: 222,
        text: "second buffered message",
        date: 1736381022,
      });
      const firstParticipant = requireValue(
        firstReplay.deferredWork,
        "first buffered replay participant",
      );
      const secondParticipant = requireValue(
        secondReplay.deferredWork,
        "second buffered replay participant",
      );
      let firstSettled = false;
      let secondSettled = false;
      void firstParticipant.task.then(() => {
        firstSettled = true;
      });
      void secondParticipant.task.then(() => {
        secondSettled = true;
      });

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      await vi.waitFor(() => {
        expect(queuedLifecycle?.onAdopted).toEqual(expect.any(Function));
      });

      await expect(queuedLifecycle?.onAdopted?.()).rejects.toBe(commitError);
      await flushTelegramTestMicrotasks();
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      await queuedLifecycle?.onAdopted?.();
      await expect(Promise.all([firstParticipant.task, secondParticipant.task])).resolves.toEqual([
        { kind: "completed" },
        { kind: "completed" },
      ]);
      expect(commitSpy).toHaveBeenCalledTimes(2);
      queuedLifecycle?.onSettled?.();
    } finally {
      commitSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("serializes timeout settlement behind an in-flight durable adoption commit", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });

    installPerKeySequentializer();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let markCommitStarted: (() => void) | undefined;
    let releaseCommit: (() => void) | undefined;
    const commitStarted = new Promise<void>((resolve) => {
      markCommitStarted = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commitSpy = vi
      .spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay")
      .mockImplementationOnce(async () => {
        markCommitStarted?.();
        await commitGate;
      });
    const releaseSpy = vi.spyOn(messageDispatchDedupe, "releaseTelegramMessageDispatchReplay");
    let queuedLifecycle: GetReplyOptions["turnAdoptionLifecycle"];
    let queuedAbortSignal: AbortSignal | undefined;
    let runQueuedTurn: (() => Promise<void>) | undefined;
    let modelTurnRan = false;
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      queuedLifecycle = opts?.turnAdoptionLifecycle;
      queuedAbortSignal = opts?.abortSignal;
      queuedLifecycle?.onDeferred?.();
      runQueuedTurn = async () => {
        await queuedLifecycle?.onAdopted?.();
        if (queuedAbortSignal?.aborted) {
          throw queuedAbortSignal.reason;
        }
        modelTurnRan = true;
        queuedLifecycle?.onSettled?.();
      };
      return undefined;
    });

    try {
      createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      const firstReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 225,
        messageId: 225,
        text: "first buffered message",
        date: 1736381025,
      });
      const secondReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 226,
        messageId: 226,
        text: "second buffered message",
        date: 1736381026,
      });
      const firstParticipant = requireValue(
        firstReplay.deferredWork,
        "first buffered replay participant",
      );
      const secondParticipant = requireValue(
        secondReplay.deferredWork,
        "second buffered replay participant",
      );

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      await vi.waitFor(() => {
        expect(runQueuedTurn).toEqual(expect.any(Function));
      });

      const queuedTurn = runQueuedTurn?.();
      await commitStarted;
      const timeoutError = new Error("spooled replay timed out during durable adoption");
      let firstParticipantSettled = false;
      void firstParticipant.task.then(() => {
        firstParticipantSettled = true;
      });
      firstParticipant.settle({ kind: "failed-retryable", error: timeoutError });
      await flushTelegramTestMicrotasks();
      expect(firstParticipantSettled).toBe(false);
      expect(firstParticipant.abortSignal.aborted).toBe(false);
      expect(releaseSpy).not.toHaveBeenCalled();

      releaseCommit?.();
      await queuedTurn;
      expect(modelTurnRan).toBe(true);
      expect(queuedAbortSignal?.aborted).toBe(false);
      await expect(Promise.all([firstParticipant.task, secondParticipant.task])).resolves.toEqual([
        { kind: "completed" },
        { kind: "completed" },
      ]);
      expect(commitSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).not.toHaveBeenCalled();
    } finally {
      releaseCommit?.();
      commitSpy.mockRestore();
      releaseSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("blocks buffered adoption after an exposed replay participant times out", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });

    installPerKeySequentializer();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const commitSpy = vi.spyOn(messageDispatchDedupe, "commitTelegramMessageDispatchReplay");
    let queuedLifecycle: GetReplyOptions["turnAdoptionLifecycle"];
    let queuedAbortSignal: AbortSignal | undefined;
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      queuedLifecycle = opts?.turnAdoptionLifecycle;
      queuedAbortSignal = opts?.abortSignal;
      queuedLifecycle?.onDeferred?.();
      return undefined;
    });

    try {
      createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      const firstReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 223,
        messageId: 223,
        text: "first buffered message",
        date: 1736381023,
      });
      const secondReplay = await dispatchSpooledPrivateText(messageHandler, {
        updateId: 224,
        messageId: 224,
        text: "second buffered message",
        date: 1736381024,
      });
      const firstParticipant = requireValue(
        firstReplay.deferredWork,
        "first buffered replay participant",
      );
      const secondParticipant = requireValue(
        secondReplay.deferredWork,
        "second buffered replay participant",
      );

      takeLatestTimerCallback(INBOUND_DEBOUNCE_MS)();
      await vi.waitFor(() => {
        expect(queuedLifecycle?.onAdopted).toEqual(expect.any(Function));
      });

      const timeoutError = new Error("spooled replay timed out before admission");
      firstParticipant.settle({ kind: "failed-retryable", error: timeoutError });
      await vi.waitFor(() => {
        expect(queuedAbortSignal?.aborted).toBe(true);
      });
      await expect(secondParticipant.task).resolves.toEqual({
        kind: "failed-retryable",
        error: timeoutError,
      });
      await expect(queuedLifecycle?.onAdopted?.()).rejects.toBe(timeoutError);
      expect(commitSpy).not.toHaveBeenCalled();
      expect(replySpy).toHaveBeenCalledTimes(1);
    } finally {
      commitSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });

  it("preserves structured origin for a single forwarded debounce entry", async () => {
    configureOpenDm({ timezone: "envelopeTimezone" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      await messageHandler(
        makePrivateTextContext({
          text: "single forwarded note",
          messageId: 121,
          date: 1736380921,
          message: {
            forward_origin: {
              type: "hidden_user",
              date: 621,
              sender_user_name: "Original A",
            },
          },
        }),
      );

      takeLatestTimerCallback(80)();

      await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
      const payload = requireValue(replySpy.mock.calls[0]?.[0], "single forwarded payload");
      expect(payload.Body).toContain("[Forwarded from Original A");
      expect(payload.ForwardedFrom).toBe("Original A");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("preserves distinct origins for forwarded messages in one debounce batch", async () => {
    configureOpenDm({ timezone: "envelopeTimezone" });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    try {
      createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      for (const [messageId, text, origin] of [
        [121, "first forwarded note", "Original A"],
        [122, "second forwarded note", "Original B"],
      ] as const) {
        await messageHandler(
          makePrivateTextContext({
            text,
            date: 1736380800 + messageId,
            messageId,
            message: {
              forward_origin: {
                type: "hidden_user",
                date: 500 + messageId,
                sender_user_name: origin,
              },
            },
          }),
        );
      }

      takeLatestTimerCallback(80)();

      await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
      const payload = requireValue(replySpy.mock.calls[0]?.[0], "forwarded batch payload");
      expect(payload.Body).toContain("[Forwarded from Original A");
      expect(payload.Body).toContain("[Forwarded from Original B");
      expect(payload.Body).toMatch(
        /\[Forwarded from Original A[^\]]*\]\nfirst forwarded note\n\[Forwarded from Original B[^\]]*\]\nsecond forwarded note/,
      );
      expect(payload.BodyForAgent).toMatch(
        /\[Forwarded from Original A[^\]]*\]\nfirst forwarded note\n\[Forwarded from Original B[^\]]*\]\nsecond forwarded note/,
      );
      expect(payload.BodyForAgent).not.toContain("Conversation info (untrusted metadata)");
      expect(payload.CommandBody).toBe("first forwarded note\nsecond forwarded note");
      expect(payload.ForwardedFrom).toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("lets stop cancel pending same-chat forwarded debounce", async () => {
    configureOpenDm({ debounceMs: INBOUND_DEBOUNCE_MS, timezone: "envelopeTimezone" });

    installPerKeySequentializer();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const startedBodies: string[] = [];
    replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      const body = ctx.Body ?? "";
      startedBodies.push(body);
      return { text: `reply:${body}` };
    });

    try {
      createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();
      await dispatchPrivateText(messageHandler, {
        updateId: 121,
        messageId: 121,
        text: "forwarded first",
        message: {
          forward_date: 1736380700,
        },
      });

      const flushForward = takeLatestTimerCallback(80);

      await dispatchPrivateText(messageHandler, {
        updateId: 122,
        messageId: 122,
        text: "stop",
        date: 1736380801,
      });

      expect(startedBodies).toHaveLength(1);
      expect(startedBodies[0]).toContain("stop");

      flushForward();
      await Promise.resolve();
      expect(startedBodies).toHaveLength(1);
      expect(sendMessageSpy.mock.calls.map((call) => String(call[1])).join("\n")).not.toContain(
        "reply:forwarded first",
      );
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("does not let unauthorized group stop cancel pending same-sender inbound debounce", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      messages: {
        inbound: {
          debounceMs: INBOUND_DEBOUNCE_MS,
        },
      },
      channels: {
        telegram: {
          dmPolicy: "pairing",
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    });

    installPerKeySequentializer();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const startedBodies: string[] = [];
    replySpy.mockImplementation(async (ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      const body = ctx.Body ?? "";
      startedBodies.push(body);
      return { text: `reply:${body}` };
    });

    try {
      createTelegramBot({ token: "tok" });
      const messageHandler = getMessageHandler();

      await runTelegramMiddlewareChain({
        ctx: {
          update: { update_id: 104 },
          message: {
            chat: { id: -1007, type: "supergroup", title: "OpenClaw Ops" },
            text: "first",
            date: 1736380804,
            message_id: 104,
            from: { id: 42, first_name: "Ada" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        },
        finalHandler: messageHandler,
      });

      const flushFirst = takeLatestTimerCallback(INBOUND_DEBOUNCE_MS);

      await runTelegramMiddlewareChain({
        ctx: {
          update: { update_id: 105 },
          message: {
            chat: { id: -1007, type: "supergroup", title: "OpenClaw Ops" },
            text: "stop",
            date: 1736380805,
            message_id: 105,
            from: { id: 42, first_name: "Ada" },
          },
          me: { username: "openclaw_bot" },
          getFile: async () => ({}),
        },
        finalHandler: messageHandler,
      });

      flushFirst();
      await vi.waitFor(() => {
        expect(startedBodies.some((body) => body.includes("first"))).toBe(true);
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("routes generic callback_query payloads as callback_data messages and answers callbacks", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({ id: "cbq-1", data: "cmd:option_a", messageId: 10 }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.Body).toContain("callback_data: cmd:option_a");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-1");
  });

  it("routes plugin callback_query payloads to plugin handlers without fallback callback_data text", async () => {
    const pluginHandler = vi.fn(async (ctx) => {
      expect(ctx.callback.namespace).toBe("code-agent");
      expect(ctx.callback.payload).toBe("approve-123");
      await ctx.respond.clearButtons();
      return { handled: true };
    });
    expect(
      registerPluginInteractiveHandler("openclaw-code-agent", {
        channel: "telegram",
        namespace: "code-agent",
        handler: pluginHandler,
      }),
    ).toEqual({ ok: true });

    createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({
        id: "cbq-plugin-1",
        data: "code-agent:approve-123",
        messageId: 10,
        text: "Approve this code-agent action?",
        message: {
          reply_markup: {
            inline_keyboard: [[{ text: "Approve", callback_data: "code-agent:approve-123" }]],
          },
        },
      }),
    );

    expect(pluginHandler).toHaveBeenCalledTimes(1);
    expect(replySpy).not.toHaveBeenCalled();
    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-plugin-1");
  });

  it("preserves raw slash callback_query payloads as command text", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({ id: "cbq-slash-1", data: "/fast status", messageId: 10 }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.Body).toContain("/fast status");
    expect(payload.Body).not.toContain("callback_data: /fast status");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-slash-1");
  });

  it.each([
    { name: "clears buttons", id: "cbq-generic-clear-1", editError: undefined },
    {
      name: "continues after a permanent edit error",
      id: "cbq-generic-clear-permanent-1",
      editError: new Error("400: Bad Request: message can't be edited"),
    },
  ])("routes generic callback_query payloads and $name", async ({ id, editError }) => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    if (editError) {
      editMessageReplyMarkupSpy.mockRejectedValueOnce(editError);
    }

    await callbackHandler(makeGenericCallbackContext({ id }));

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.Body).toContain("skip nightly build tonight");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith(id);
  });

  it("retries generic callback_query button cleanup after transient edit failures", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const ctx = makeGenericCallbackContext({ id: "cbq-generic-clear-retry-1", updateId: 779 });

    editMessageReplyMarkupSpy.mockRejectedValueOnce(new Error("edit boom"));

    await expect(
      runTelegramMiddlewareChain({
        ctx,
        finalHandler: callbackHandler,
      }),
    ).rejects.toThrow("edit boom");
    expect(replySpy).not.toHaveBeenCalled();

    await runTelegramMiddlewareChain({
      ctx,
      finalHandler: callbackHandler,
    });

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(2);
    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.Body).toContain("skip nightly build tonight");
  });

  it("does not route opaque callback_query payloads as synthetic commands", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({
        id: "cbq-opaque-1",
        data: buildTelegramOpaqueCallbackData("/codex permissions yolo"),
        messageId: 10,
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-opaque-1");
  });

  it("toggles OC_MULTI buttons without routing through the generic callback message path", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({
        id: "cbq-multi-toggle-1",
        data: "OC_MULTI|toggle|env|prod",
        messageId: 10,
        message: {
          business_connection_id: "biz-multi-1",
          reply_markup: {
            inline_keyboard: [[{ text: "Prod", callback_data: "OC_MULTI|toggle|env|prod" }]],
          },
        },
      }),
    );

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      business_connection_id: "biz-multi-1",
      reply_markup: {
        inline_keyboard: [[{ text: "✅ Prod", callback_data: "OC_MULTI|toggle|env|prod" }]],
      },
    });
    expect(replySpy).not.toHaveBeenCalled();
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-multi-toggle-1");
  });

  it("submits OC_MULTI selections as a synthetic inbound message", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({
        id: "cbq-multi-submit-1",
        data: "OC_MULTI|submit",
        messageId: 10,
        message: {
          reply_markup: {
            inline_keyboard: [
              [{ text: "✅ Prod", callback_data: "OC_MULTI|toggle|env|prod" }],
              [{ text: "Blue", callback_data: "OC_MULTI|toggle|blue" }],
            ],
          },
        },
      }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(requireValue(replySpy.mock.calls.at(0), "replySpy call")[0].Body).toContain(
      "Multi-select submitted: env|prod",
    );
  });

  it("submits OC_SELECT values as a synthetic inbound message and clears buttons", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({
        id: "cbq-select-1",
        data: "OC_SELECT|env|canary",
        messageId: 10,
        message: {
          reply_markup: {
            inline_keyboard: [[{ text: "Canary", callback_data: "OC_SELECT|env|canary" }]],
          },
        },
      }),
    );

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledWith(1234, 10, {
      reply_markup: { inline_keyboard: [] },
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(requireValue(replySpy.mock.calls.at(0), "replySpy call")[0].Body).toContain(
      "Single-select submitted: env|canary",
    );
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
    const callbackHandler = getCallbackHandler();
    await callbackHandler(
      makeCallbackRetryContext({ id: "cbq-native-1", data: "tgcmd:/fast status", messageId: 10 }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.CommandBody).toBe("/fast status");
    expect(payload.CommandSource).toBe("native");
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cbq-native-1");
  });
  it("reloads callback model routing bindings without recreating the bot", async () => {
    const buildModelsProviderDataMock =
      telegramBotDepsForTest.buildModelsProviderData as unknown as BuildModelsProviderDataMock;
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
    const callbackHandler = getCallbackHandler();

    const sendModelCallback = async (id: number) => {
      await callbackHandler(
        makeCallbackRetryContext({ id: `cbq-model-${id}`, data: "mdl_prov", messageId: id }),
      );
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
      const messageRegistration = onSpy.mock.calls.find(([event]) => event === "message");
      expect(messageRegistration?.[1]).toBeTypeOf("function");
      const handler = getMessageHandler();
      await handler(
        makePrivateTextContext({
          chatId: 1234,
          text: "hello world",
          date: 1736380800, // 2025-01-09T00:00:00Z
          from: {
            first_name: "Ada",
            last_name: "Lovelace",
            username: "ada_bot",
          },
          downloadable: true,
        }),
      );

      expect(replySpy).toHaveBeenCalledTimes(1);
      const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
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
        return expectDefined(result, `pairing upsert result ${pairingUpsertCall}`);
      });

      createTelegramBot({ token: "tok" });
      const handler = getMessageHandler();
      const senderId = Number(`${Date.now()}${index}`.slice(-9));
      for (const text of testCase.messages) {
        await handler(
          makePrivateTextContext({
            chatId: 1234,
            text,
            from: { id: senderId, username: "random" },
            downloadable: true,
          }),
        );
      }

      expect(replySpy, testCase.name).not.toHaveBeenCalled();
      expect(sendMessageSpy, testCase.name).toHaveBeenCalledTimes(testCase.expectedSendCount);
      expect(sendMessageSpy.mock.calls.at(0)?.[0], testCase.name).toBe(1234);
      const pairingText = String(sendMessageSpy.mock.calls.at(0)?.[1]);
      expect(pairingText, testCase.name).toContain(`Your Telegram user id: ${senderId}`);
      expect(pairingText, testCase.name).toContain("Pairing code:");
      expect(pairingText, testCase.name).toContain("openclaw pairing approve telegram");
      expectRecordFields(
        sendMessageSpy.mock.calls.at(0)?.[2],
        { parse_mode: "HTML" },
        testCase.name,
      );
    }
  });

  it("sends a friendly retry hint when the pairing allowlist store cannot be read", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockRejectedValueOnce(new Error("store temporarily unavailable"));
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getMessageHandler();
    await handler(
      makePrivateTextContext({
        chatId: 1234,
        text: "hello",
        messageId: 9,
        from: { id: 123456789, username: "testuser" },
        downloadable: true,
      }),
    );

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      "⚠️ Couldn't process this message, please try again in a moment.",
      expect.objectContaining({
        reply_parameters: expect.objectContaining({ message_id: 9 }),
      }),
    );
  });

  it("marks spooled replay pairing store read failures retryable without apology spam", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore.mockRejectedValueOnce(new Error("store temporarily unavailable"));
    sendMessageSpy.mockClear();
    const onUpdateId = vi.fn();

    createTelegramBot({
      token: "tok",
      updateOffset: {
        lastUpdateId: 700,
        onUpdateId,
      },
    });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const update = {
      update_id: 701,
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        message_id: 9,
        date: 1736380800,
        from: { id: 123456789, username: "testuser" },
      },
    };
    const ctx = {
      update,
      message: update.message,
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    };

    await expect(
      withTelegramSpooledReplayUpdate(update, async () => {
        await runTelegramMiddlewareChain({
          ctx,
          finalHandler: async () => {
            await handler(ctx);
          },
        });
      }),
    ).rejects.toMatchObject({
      name: TelegramSpooledReplayProcessingError.name,
      cause: expect.objectContaining({ name: "TelegramPairingStoreReadError" }),
    });

    expect(onUpdateId).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("keeps the same private chat usable after a transient pairing store read failure", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing" } },
    });
    readChannelAllowFromStore
      .mockRejectedValueOnce(new Error("store temporarily unavailable"))
      .mockResolvedValueOnce(["123456789"]);
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getMessageHandler();
    const sender = { id: 123456789, username: "testuser" };
    await handler(
      makePrivateTextContext({
        chatId: 1234,
        text: "hello",
        messageId: 10,
        from: sender,
        downloadable: true,
      }),
    );
    await handler(
      makePrivateTextContext({
        chatId: 1234,
        text: "still there?",
        messageId: 11,
        date: 1736380801,
        from: sender,
        downloadable: true,
      }),
    );

    expect(readChannelAllowFromStore).toHaveBeenCalledTimes(2);
    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    // First message: failure → retry hint via sendMessageSpy. Second message: success → agent reply via replySpy.
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toMatch(/please try again/i);
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("allows a configured private sender when the pairing allowlist store cannot be read", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "pairing", allowFrom: ["123456789"] } },
    });
    readChannelAllowFromStore.mockRejectedValueOnce(new Error("store temporarily unavailable"));
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        date: 1736380800,
        from: { id: 123456789, username: "testuser" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(readChannelAllowFromStore).not.toHaveBeenCalled();
    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("does not require the pairing allowlist store for open private messages", async () => {
    configureOpenDm();
    readChannelAllowFromStore.mockRejectedValueOnce(new Error("store temporarily unavailable"));
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        date: 1736380800,
        from: { id: 123456789, username: "testuser" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(readChannelAllowFromStore).not.toHaveBeenCalled();
    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).toHaveBeenCalledTimes(1);
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
      const pairingText = String(sendMessageSpy.mock.calls.at(0)?.[1]);
      expect(pairingText).toContain("Pairing code:");
      expect(pairingText).toContain("<pre><code>");
      expectRecordFields(
        sendMessageSpy.mock.calls.at(0)?.[2],
        { parse_mode: "HTML" },
        "pairing reply options",
      );
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not leak blocked allowlist text DMs into authorized prompt context", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["123456789"],
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 411,
        date: 1736380800,
        text: "unauthorized secret",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(replySpy).not.toHaveBeenCalled();

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 412,
        date: 1736380860,
        text: "authorized follow-up",
        from: { id: 123456789, username: "allowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].UntrustedStructuredContext).toBeUndefined();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("does not cache blocked allowlist edited DMs into authorized prompt context", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowFrom: ["123456789"],
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const editedHandler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await editedHandler({
      editedMessage: {
        chat: { id: 1234, type: "private" },
        message_id: 414,
        date: 1736380800,
        edit_date: 1736380810,
        text: "edited unauthorized secret",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(replySpy).not.toHaveBeenCalled();

    await messageHandler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 415,
        date: 1736380860,
        text: "authorized follow-up",
        from: { id: 123456789, username: "allowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].UntrustedStructuredContext).toBeUndefined();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("does not cache blocked group-sender edits into authorized prompt context", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          allowFrom: ["123456789"],
          groups: { "*": { requireMention: false } },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const editedHandler = getOnHandler("edited_message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await editedHandler({
      editedMessage: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        message_id: 416,
        date: 1736380800,
        edit_date: 1736380810,
        text: "edited unauthorized group secret",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });
    expect(replySpy).not.toHaveBeenCalled();

    await messageHandler({
      message: {
        chat: { id: -100123456789, type: "group", title: "Test Group" },
        message_id: 417,
        date: 1736380860,
        text: "authorized follow-up",
        from: { id: 123456789, username: "allowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].UntrustedStructuredContext).toBeUndefined();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("drops topic-required root DMs before pairing challenges", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          dmPolicy: "pairing",
          direct: {
            "1234": { requireTopic: true },
          },
        },
      },
    });
    readChannelAllowFromStore.mockResolvedValue([]);
    upsertChannelPairingRequest.mockClear();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 413,
        date: 1736380870,
        text: "root dm without topic",
        from: { id: 999999, username: "notallowed" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    expect(upsertChannelPairingRequest).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
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
      const pairingText = String(sendMessageSpy.mock.calls.at(0)?.[1]);
      expect(pairingText).toContain("Pairing code:");
      expect(pairingText).toContain("<pre><code>");
      expectRecordFields(
        sendMessageSpy.mock.calls.at(0)?.[2],
        { parse_mode: "HTML" },
        "album pairing reply options",
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
        id: "cb-question-duplicate",
        data: "tgq1:ask_0123456789abcdef0123456789abcdef:1",
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
    expect(answerCallbackQuerySpy).toHaveBeenCalledWith("cb-question-duplicate");

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

  it("dedupes a replayed Telegram message after handler recreation", async () => {
    configureOpenDm();

    const replayedCtx = () => ({
      update: { update_id: 8488601 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "replay me once",
        date: 1736380800,
        message_id: 42,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    createTelegramBot({ token: "tok" });
    await (getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>)(
      replayedCtx(),
    );
    expect(replySpy).toHaveBeenCalledTimes(1);

    onSpy.mockClear();
    createTelegramBot({ token: "tok" });
    await (getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>)(
      replayedCtx(),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("dedupes a replayed Telegram message after handler recreation while dispatch is pending", async () => {
    configureOpenDm();

    const firstDispatchStarted = createDeferred();
    const finishFirstDispatch = createDeferred();
    replySpy.mockImplementationOnce(async (_ctx: MsgContext, opts?: GetReplyOptions) => {
      await opts?.onReplyStart?.();
      firstDispatchStarted.resolve();
      await finishFirstDispatch.promise;
      return undefined;
    });

    const replayedCtx = () => ({
      update: { update_id: 8488602 },
      message: {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "replay while pending",
        date: 1736380800,
        message_id: 43,
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    createTelegramBot({ token: "tok" });
    const firstRun = (getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>)(
      replayedCtx(),
    );
    await firstDispatchStarted.promise;
    expect(replySpy).toHaveBeenCalledTimes(1);

    onSpy.mockClear();
    createTelegramBot({ token: "tok" });
    await (getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>)(
      replayedCtx(),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    finishFirstDispatch.resolve();
    await firstRun;
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it("retries a spooled message after dispatch fails before turn adoption", async () => {
    configureOpenDm();
    const dispatchError = new Error("failed before turn adoption");
    replySpy.mockRejectedValueOnce(dispatchError).mockResolvedValueOnce({ text: "recovered" });

    createTelegramBot({ token: "tok" });
    const messageHandler = getOnHandler("message") as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;
    const replayedCtx = () => {
      const message = {
        chat: { id: 123, type: "private" },
        from: { id: 456, username: "testuser" },
        text: "retry after pre-adoption failure",
        date: 1736380800,
        message_id: 44,
      };
      const update = { update_id: 8488603, message };
      return {
        update,
        message,
        me: { username: "openclaw_bot" },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      };
    };

    const firstCtx = replayedCtx();
    const firstReplay = await runWithTelegramSpooledReplayUpdate(firstCtx.update, async () => {
      await runTelegramMiddlewareChain({
        ctx: firstCtx,
        finalHandler: messageHandler,
      });
    });
    const firstDeferredWork = requireValue(firstReplay.deferredWork, "first replay deferred work");
    await expect(firstDeferredWork.task).resolves.toEqual({
      kind: "failed-retryable",
      error: dispatchError,
    });
    await flushTelegramTestMicrotasks();

    const secondCtx = replayedCtx();
    const secondReplay = await runWithTelegramSpooledReplayUpdate(secondCtx.update, async () => {
      await runTelegramMiddlewareChain({
        ctx: secondCtx,
        finalHandler: messageHandler,
      });
    });
    const secondDeferredWork = requireValue(
      secondReplay.deferredWork,
      "second replay deferred work",
    );
    await expect(secondDeferredWork.task).resolves.toEqual({ kind: "completed" });
    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  it("persists update offsets after successful dispatch completion", async () => {
    configureOpenDm();
    const { onUpdateId, run: runMiddlewareChain } = setupUpdateOffsetTracker({
      lastUpdateId: 100,
    });

    let releaseUpdate101: (() => void) | undefined;
    const update101Gate = new Promise<void>((resolve) => {
      releaseUpdate101 = resolve;
    });

    // Start processing update 101 but keep it pending (simulates a long-running turn).
    const p101 = runMiddlewareChain({ update: { update_id: 101 } }, async () => update101Gate);
    // Let update 101 enter the chain. Telegram now persists the restart watermark only after
    // the handler completes, so a crash during the pending turn can replay the update.
    await Promise.resolve();
    expect(onUpdateId).not.toHaveBeenCalled();

    // Complete update 102 while 101 is still pending. The persisted watermark must not advance
    // past pending lower ids.
    await runMiddlewareChain({ update: { update_id: 102 } }, async () => {});
    expect(onUpdateId).not.toHaveBeenCalled();

    releaseUpdate101?.();
    await p101;

    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([102]);
  });
  it("logs and swallows update watermark persistence failures", async () => {
    const onUpdateId = vi.fn().mockRejectedValueOnce(new Error("disk boom"));
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
      exit: vi.fn(),
    };

    const { run: runMiddlewareChain } = setupUpdateOffsetTracker({
      lastUpdateId: 13_099,
      onUpdateId,
      runtime,
    });

    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await runMiddlewareChain({ update: { update_id: 13_100 } }, async () => {});
      await flushTelegramTestMicrotasks();
      expect(onUpdateId).toHaveBeenCalledWith(13_100);
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("keeps failed updates unpersisted while preserving same-process retries", async () => {
    const { onUpdateId, run: runMiddlewareChain } = setupUpdateOffsetTracker({
      lastUpdateId: 200,
    });

    await expect(
      runMiddlewareChain({ update: { update_id: 201 } }, async () => {
        throw new Error("middleware boom");
      }),
    ).rejects.toThrow("middleware boom");
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    await runMiddlewareChain({ update: { update_id: 202 } }, async () => {});

    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    const retryHandler = vi.fn();
    await runMiddlewareChain({ update: { update_id: 201 } }, async () => {
      retryHandler();
    });

    await flushTelegramTestMicrotasks();
    expect(retryHandler).toHaveBeenCalledTimes(1);
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([202]);
  });

  it("persists recorded dispatch failures during normal polling", async () => {
    const { onUpdateId, run: runMiddlewareChain } = setupUpdateOffsetTracker({
      lastUpdateId: 500,
    });

    const dispatchError = new Error("dispatch exploded");
    await runMiddlewareChain({ update: { update_id: 501 } }, async () => {
      recordTelegramMessageProcessingResult({
        kind: "failed-retryable",
        error: dispatchError,
      });
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501]);

    await runMiddlewareChain({ update: { update_id: 502 } }, async () => {});
    await flushTelegramTestMicrotasks();
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([501, 502]);
  });

  it("rejects recorded dispatch failures during isolated spool replay", async () => {
    const { onUpdateId, run: runMiddlewareChain } = setupUpdateOffsetTracker({
      lastUpdateId: 600,
    });

    const update = { update_id: 601 };
    const dispatchError = new Error("dispatch exploded");
    await expect(
      withTelegramSpooledReplayUpdate(update, async () => {
        await runMiddlewareChain({ update }, async () => {
          recordTelegramMessageProcessingResult({
            kind: "failed-retryable",
            error: dispatchError,
          });
        });
      }),
    ).rejects.toMatchObject({
      name: TelegramSpooledReplayProcessingError.name,
      cause: dispatchError,
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();
  });

  it("keeps deferred spooled failures retryable in the same bot tracker", async () => {
    const { onUpdateId, run: runMiddlewareChain } = setupUpdateOffsetTracker({
      lastUpdateId: 700,
    });

    const update = { update_id: 701 };
    const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
      await runMiddlewareChain({ update }, async () => {
        const participant = createTelegramSpooledReplayDeferredParticipant("test:deferred");
        if (!participant) {
          throw new Error("expected spooled replay participant");
        }
      });
    });
    const deferredWork = replay.deferredWork;
    expect(deferredWork).toBeDefined();
    if (!deferredWork) {
      throw new Error("Expected deferred spooled work");
    }
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    deferredWork.settle({
      kind: "failed-retryable",
      error: new Error("deferred dispatch failed"),
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();

    let retried = false;
    await runWithTelegramSpooledReplayUpdate(update, async () => {
      await runMiddlewareChain({ update }, async () => {
        retried = true;
      });
    });
    await flushTelegramTestMicrotasks();
    expect(retried).toBe(true);
    expect(onUpdateId.mock.calls.map((call) => call[0])).toEqual([701]);
  });

  it("skips replayed update ids even when the semantic update key differs", async () => {
    const { onUpdateId, run: runMiddlewareChain } = setupUpdateOffsetTracker({
      lastUpdateId: 300,
    });

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
    configureOpenDm();

    createTelegramBot({ token: "tok" });
    const handler = getCallbackHandler();
    for (const id of ["cb-1", "cb-2"]) {
      await handler(
        makeCallbackRetryContext({
          id,
          data: "ping",
          messageId: 9001,
          from: { id: 789, username: "testuser" },
          message: { chat: { id: 123, type: "private" } },
          downloadable: false,
        }),
      );
    }

    expect(replySpy).toHaveBeenCalledTimes(2);
  });

  const accessGroup = (member: string) => ({
    accessGroups: {
      operators: { type: "message.senders", members: { telegram: [member] } },
    },
  });
  const groupPolicyCases: MessagePolicyCase[] = [
    makeMessagePolicyCase({
      name: "blocks all group messages when groupPolicy is 'disabled'",
      telegram: { groupPolicy: "disabled", allowFrom: ["123456789"] },
      message: { text: "@openclaw_bot hello" },
      expectedReplyCount: 0,
    }),
    makeMessagePolicyCase({
      name: "blocks group messages from senders not in allowFrom when groupPolicy is 'allowlist'",
      telegram: { groupPolicy: "allowlist", allowFrom: ["123456789"] },
      message: { from: { id: 999999, username: "notallowed" }, text: "@openclaw_bot hello" },
      expectedReplyCount: 0,
    }),
    makeMessagePolicyCase({
      name: "allows group messages from senders in allowFrom (by ID) when groupPolicy is 'allowlist'",
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["123456789"],
        groups: { "*": { requireMention: false } },
      },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "allows group messages from sender access groups in groupAllowFrom",
      rootConfig: accessGroup("123456789"),
      telegram: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:operators"],
        groups: { "*": { requireMention: false } },
      },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "blocks explicitly configured group when groupAllowFrom access group does not match sender",
      rootConfig: accessGroup("111111111"),
      telegram: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:operators"],
        groups: { "-100123456789": { requireMention: false } },
      },
      expectedReplyCount: 0,
    }),
    makeMessagePolicyCase({
      name: "allows group messages from sender access groups in per-group allowFrom",
      rootConfig: accessGroup("123456789"),
      telegram: {
        groupPolicy: "open",
        groups: {
          "-100123456789": {
            allowFrom: ["accessGroup:operators"],
            requireMention: false,
          },
        },
      },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "blocks group messages when allowFrom is configured with @username entries (numeric IDs required)",
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["@testuser"],
        groups: { "*": { requireMention: false } },
      },
      message: { from: { id: 12345, username: "testuser" } },
      expectedReplyCount: 0,
    }),
    makeMessagePolicyCase({
      name: "allows group messages from tg:-prefixed allowFrom entries case-insensitively",
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["TG:77112533"],
        groups: { "*": { requireMention: false } },
      },
      message: { from: { id: 77112533, username: "mneves" } },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "blocks group messages when per-group allowFrom override is explicitly empty",
      telegram: {
        groupPolicy: "open",
        groups: { "-100123456789": { allowFrom: [], requireMention: false } },
      },
      message: { from: { id: 999999, username: "random" } },
      expectedReplyCount: 0,
    }),
    makeMessagePolicyCase({
      name: "allows all group messages when groupPolicy is 'open'",
      telegram: { groupPolicy: "open", groups: { "*": { requireMention: false } } },
      message: { from: { id: 999999, username: "random" } },
      expectedReplyCount: 1,
    }),
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
    const handler = getMessageHandler();
    await handler(
      makePrivateTextContext({
        chatId: 123,
        from: { id: 999, username: "testuser" },
        text: "hello",
        messageId: 42,
        downloadable: true,
      }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
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
    const handler = getMessageHandler();

    const sendDm = async (messageId: number, text: string) => {
      await handler(
        makePrivateTextContext({
          chatId: 123,
          from: { id: 999, username: "testuser" },
          text,
          date: 1736380800 + messageId,
          messageId,
          downloadable: true,
        }),
      );
    };

    await sendDm(42, "hello one");
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].AccountId).toBe("opie");
    expect(replySpy.mock.calls.at(0)?.[0].SessionKey).toContain("agent:agent-a:");

    boundAgentId = "agent-b";
    await sendDm(43, "hello two");
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls.at(1)?.[0].AccountId).toBe("opie");
    expect(replySpy.mock.calls.at(1)?.[0].SessionKey).toContain("agent:agent-b:");
  });

  it("reloads topic agent overrides between messages without recreating the bot", async () => {
    let topicAgentId = "topic-a";
    const configForTopicAgent = () => ({
      session: {
        typingMode: "never",
      },
      messages: {
        inbound: {
          debounceMs: 0,
        },
      },
      channels: {
        telegram: {
          botToken: "tok",
          dmPolicy: "open",
          allowFrom: ["*"],
          direct: {
            "123": {
              topics: {
                "99": {
                  agentId: topicAgentId,
                },
              },
            },
            "124": {
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
    });
    loadConfig.mockImplementation(configForTopicAgent);

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    replySpy.mockImplementation(async () => undefined);

    const sendTopicMessage = async (chatId: number, messageId: number, text: string) => {
      await handler({
        message: {
          chat: { id: chatId, type: "private" },
          from: { id: chatId, username: `user${chatId}` },
          text,
          date: 1736380800 + messageId,
          message_id: messageId,
          message_thread_id: 99,
        },
        me: { username: "openclaw_bot", has_topics_enabled: true },
        getFile: async () => ({ download: async () => new Uint8Array() }),
      });
    };

    await sendTopicMessage(123, 44, "topic one");
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls.at(0)?.[0].SessionKey).toContain("agent:topic-a:");
    expect(replySpy.mock.calls.at(0)?.[0].SessionKey).toContain("thread:123:99");

    topicAgentId = "topic-b";
    await sendTopicMessage(124, 45, "topic two");
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls.at(1)?.[0].SessionKey).toContain("agent:topic-b:");
    expect(replySpy.mock.calls.at(1)?.[0].SessionKey).toContain("thread:124:99");
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
    const handler = getMessageHandler();
    await handler(
      makePrivateTextContext({
        chatId: 123,
        from: { id: 999, username: "testuser" },
        text: "hello",
        messageId: 42,
        downloadable: true,
      }),
    );

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "reply call")[0];
    expect(payload.AccountId).toBe("opie");
    expect(payload.SessionKey).toContain("agent:main:telegram:opie:");
  });

  it.each([
    {
      config: {
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: {
              "*": { requireMention: false },
              "123": {},
            },
          },
        },
      },
      botRequireMention: true,
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
            groups: { "*": { requireMention: false } },
          },
        },
      },
      botRequireMention: undefined,
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
      botRequireMention: undefined,
      message: {
        chat: { id: 789, type: "group", title: "No Me" },
        text: "hello",
        date: 1736380800,
      },
      me: {},
    },
  ] as const)("applies group mention overrides and fallback behavior %#", async (testCase) => {
    resetHarnessSpies();
    loadConfig.mockReturnValue(testCase.config);
    await dispatchMessage({
      message: testCase.message,
      me: testCase.me,
      botRequireMention: testCase.botRequireMention,
    });
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "lets topic mention overrides fall back from wildcard group config",
      groupPolicy: "open",
      groups: {
        "*": { requireMention: true },
        "-1001234567890": { requireMention: true, topics: { "99": { requireMention: false } } },
      } as Record<string, TelegramGroupConfig>,
      topicId: 99,
      expectedGroup: { requireMention: true },
      expectedTopic: { requireMention: false },
    },
    {
      name: "lets topic configs inherit group allowlist and requireMention",
      groupPolicy: "allowlist",
      groups: {
        "-1001234567890": {
          requireMention: false,
          allowFrom: ["123456789"],
          topics: { "99": {} },
        },
      } as Record<string, TelegramGroupConfig>,
      topicId: 99,
      expectedGroup: { requireMention: false, allowFrom: ["123456789"] },
      expectedTopic: {},
    },
    {
      name: "uses topics.* as the default config for unmatched forum topics",
      groupPolicy: "allowlist",
      groups: {
        "-1001234567890": {
          allowFrom: ["999999999"],
          topics: { "*": { allowFrom: ["123456789"], agentId: "zu" } },
        },
      } as Record<string, TelegramGroupConfig>,
      topicId: 77,
      expectedGroup: { allowFrom: ["999999999"] },
      expectedTopic: { allowFrom: ["123456789"], agentId: "zu" },
    },
    {
      name: "prefers exact topic config over topics.* fallback",
      groupPolicy: "allowlist",
      groups: {
        "-1001234567890": {
          topics: {
            "*": { allowFrom: ["123456789"], agentId: "zu" },
            "77": { allowFrom: ["555555555"], agentId: "main" },
          },
        },
      } as Record<string, TelegramGroupConfig>,
      topicId: 77,
      expectedGroup: undefined,
      expectedTopic: { allowFrom: ["555555555"], agentId: "main" },
    },
    {
      name: "inherits topics.* fields that exact topic config does not override",
      groupPolicy: "allowlist",
      groups: {
        "-1001234567890": {
          topics: {
            "*": { allowFrom: ["123456789"], requireMention: false },
            "77": { agentId: "main" },
          },
        },
      } as Record<string, TelegramGroupConfig>,
      topicId: 77,
      expectedGroup: undefined,
      expectedTopic: { allowFrom: ["123456789"], requireMention: false, agentId: "main" },
    },
  ] satisfies Array<
    Record<string, unknown> & {
      groupPolicy: "open" | "allowlist";
      groups: Record<string, TelegramGroupConfig>;
    }
  >)("$name", ({ groupPolicy, groups, topicId, expectedGroup, expectedTopic }) => {
    const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
      { groupPolicy, groups },
      -1001234567890,
      topicId,
    );

    if (expectedGroup) {
      expect(groupConfig as TelegramGroupConfig | undefined).toMatchObject(expectedGroup);
    }
    expect(topicConfig).toEqual(expectedTopic);
  });

  it.each([
    {
      label: "parent binding",
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
    },
    {
      label: "topic binding",
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
    },
  ] satisfies Array<{
    label: string;
    config: Parameters<typeof resolveTelegramConversationRoute>[0]["cfg"];
    expectedSessionKeyFragment: string;
  }>)("routes forum topics to parent or topic-specific bindings: $label", (testCase) => {
    const result = resolveTelegramConversationRoute({
      cfg: testCase.config,
      accountId: "default",
      chatId: -1001234567890,
      isGroup: true,
      resolvedThreadId: 99,
    });

    expect(result.route.sessionKey).toContain(testCase.expectedSessionKeyFragment);
    expect(result.route.sessionKey).toContain("telegram:group:-1001234567890");
    expect(result.route.sessionKey).not.toContain("t.me/c/");
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
    const animationCall = requireValue(sendAnimationSpy.mock.calls.at(0), "animation send call");
    expect(animationCall[0]).toBe("1234");
    requireValue(animationCall[1], "animation payload");
    expect(animationCall[2]).toEqual({
      caption: "caption",
      parse_mode: "HTML",
      reply_to_message_id: undefined,
    });
    expect(sendPhotoSpy).not.toHaveBeenCalled();
    expect(loadWebMedia).toHaveBeenCalledTimes(1);
    expect(loadWebMedia.mock.calls.at(0)?.[0]).toBe("https://example.com/fun");
  });

  function resetHarnessSpies() {
    onSpy.mockClear();
    replySpy.mockClear();
    sendMessageSpy.mockClear();
    setMessageReactionSpy.mockClear();
    setMyCommandsSpy.mockClear();
  }
  function createMessageHandler(botRequireMention?: boolean) {
    createTelegramBot({
      token: "tok",
      ...(typeof botRequireMention === "boolean" ? { requireMention: botRequireMention } : {}),
    });
    return getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
  }
  async function dispatchMessage(params: {
    message: Record<string, unknown>;
    me?: Record<string, unknown>;
    botRequireMention?: boolean;
  }) {
    const handler = createMessageHandler(params.botRequireMention);
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
            userTimezone: "UTC",
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
      const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
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
  it("marks explicit Telegram bot-handle mentions in the inbound context", async () => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
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
        text: "@openclaw_bot status",
        entities: [{ type: "mention", offset: 0, length: "@openclaw_bot".length }],
        date: 1736380800,
        message_id: 4,
        from: { id: 9, first_name: "Ada" },
      },
      me: { id: 999, username: "openclaw_bot" },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.WasMentioned).toBe(true);
    expect(payload.ExplicitlyMentionedBot).toBe(true);
    expect(payload.MentionSource).toBe("explicit_bot");
    expect(payload.BotUsername).toBe("openclaw_bot");
  });

  it("keeps group envelope headers stable (sender identity is separate)", async () => {
    resetHarnessSpies();

    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          userTimezone: "UTC",
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
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
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
        const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
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
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.Body).toContain("[Reply chain - nearest first]");
    expect(payload.Body).toContain("[1. Ada id:9001]");
    expect(payload.Body).toContain("Can you summarize this?");
    expect(payload.Body).toContain("[/Reply chain]");
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
  it("routes generic-path control commands as text slash when native commands are off", async () => {
    resetHarnessSpies();
    loadConfig.mockReturnValue({
      commands: { text: false, native: false },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    await dispatchMessage({
      message: {
        chat: { id: 1234, type: "private" },
        from: { id: 42, first_name: "Ada" },
        text: "/compact",
        date: 1736380800,
        message_id: 5,
      },
    });

    expect(replySpy).toHaveBeenCalledTimes(1);
    const payload = requireValue(replySpy.mock.calls.at(0), "replySpy call")[0];
    expect(payload.CommandSource).toBe("text");
    expect(payload.CommandTurn).toMatchObject({
      kind: "text-slash",
      source: "text",
      authorized: true,
    });
  });
  it.each([
    { name: "resolves topic-scoped forum metadata", messageThreadId: 99, expectedTopicId: 99 },
    {
      name: "resolves General topic forum metadata and typing fallback",
      messageThreadId: undefined,
      expectedTopicId: 1,
    },
  ] as const)("$name", ({ messageThreadId, expectedTopicId }) => {
    const threadSpec = resolveTelegramThreadSpec({
      isGroup: true,
      isForum: true,
      messageThreadId,
    });
    const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : undefined;
    const route = resolveTelegramConversationRoute({
      cfg: {},
      accountId: "default",
      chatId: -1001234567890,
      isGroup: true,
      resolvedThreadId,
    });

    const expectedGroupFrom = `telegram:group:-1001234567890:topic:${expectedTopicId}`;
    expect(route.route.sessionKey).toContain(expectedGroupFrom);
    expect(buildTelegramGroupFrom(-1001234567890, resolvedThreadId)).toBe(expectedGroupFrom);
    expect(buildTypingThreadParams(resolvedThreadId)).toEqual({
      message_thread_id: expectedTopicId,
    });
  });

  it("routes General-topic forum metadata via getChat when Telegram omits forum metadata", async () => {
    getChatSpy.mockResolvedValue({
      id: -1001234567890,
      type: "supergroup",
      is_forum: true,
      title: "Forum Group",
    });
    const isForum = await resolveTelegramForumFlag({
      chatId: -1001234567890,
      chatType: "supergroup",
      isGroup: true,
      isForum: undefined,
      getChat: getChatSpy as TelegramGetChat,
    });
    const threadSpec = resolveTelegramThreadSpec({
      isGroup: true,
      isForum,
      messageThreadId: undefined,
    });
    const resolvedThreadId = threadSpec.scope === "forum" ? threadSpec.id : undefined;
    const route = resolveTelegramConversationRoute({
      cfg: {},
      accountId: "default",
      chatId: -1001234567890,
      isGroup: true,
      resolvedThreadId,
    });

    expect(getChatSpy).toHaveBeenCalledOnce();
    expect(getChatSpy).toHaveBeenCalledWith(-1001234567890);
    expect(route.route.sessionKey).toContain("telegram:group:-1001234567890:topic:1");
    expect(buildTelegramGroupFrom(-1001234567890, resolvedThreadId)).toBe(
      "telegram:group:-1001234567890:topic:1",
    );
    expect(buildTypingThreadParams(resolvedThreadId)).toEqual({ message_thread_id: 1 });
  });
  it("threads forum replies only when a topic id exists", () => {
    expect(
      buildTelegramThreadParams(
        resolveTelegramThreadSpec({
          isGroup: true,
          isForum: true,
          messageThreadId: undefined,
        }),
      ),
    ).toBeUndefined();
    expect(
      buildTelegramThreadParams(
        resolveTelegramThreadSpec({
          isGroup: true,
          isForum: true,
          messageThreadId: 99,
        }),
      ),
    ).toEqual({ message_thread_id: 99 });
  });

  const allowFromEdgeCases: MessagePolicyCase[] = [
    makeMessagePolicyCase({
      name: "allows direct messages regardless of groupPolicy",
      kind: "private",
      telegram: { groupPolicy: "disabled", allowFrom: ["123456789"] },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "allows direct messages with tg/Telegram-prefixed allowFrom entries",
      kind: "private",
      telegram: { allowFrom: ["  TG:123456789  "] },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "allows direct messages from sender access groups in allowFrom",
      kind: "private",
      rootConfig: accessGroup("123456789"),
      telegram: { dmPolicy: "allowlist", allowFrom: ["accessGroup:operators"] },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "matches direct message allowFrom against sender user id when chat id differs",
      kind: "private",
      telegram: { allowFrom: ["123456789"] },
      message: { chat: { id: 777777777, type: "private" } },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "falls back to direct message chat id when sender user id is missing",
      kind: "private",
      telegram: { allowFrom: ["123456789"] },
      message: { from: undefined },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "allows group messages with wildcard in allowFrom when groupPolicy is 'allowlist'",
      telegram: {
        groupPolicy: "allowlist",
        allowFrom: ["*"],
        groups: { "*": { requireMention: false } },
      },
      message: { from: { id: 999999, username: "random" } },
      expectedReplyCount: 1,
    }),
    makeMessagePolicyCase({
      name: "blocks group messages with no sender ID when groupPolicy is 'allowlist'",
      telegram: { groupPolicy: "allowlist", allowFrom: ["123456789"] },
      message: { from: undefined },
      expectedReplyCount: 0,
    }),
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
    replySpy.mockResolvedValue({ text: "a".repeat(TELEGRAM_RICH_TEXT_LIMIT + 1024) });

    createTelegramBot({ token: "tok" });
    const handler = getMessageHandler();
    await handler(
      makePrivateTextContext({
        chatId: 5,
        text: "hi",
        messageId: 101,
        message: { from: undefined },
        downloadable: true,
      }),
    );

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
        telegram: { dmPolicy: "open", allowFrom: ["*"], responsePrefix: "PFX" },
      },
    });

    createTelegramBot({ token: "tok" });
    const handler = getMessageHandler();
    await handler(
      makePrivateTextContext({
        chatId: 5,
        text: "hi",
        message: { from: undefined },
        downloadable: true,
      }),
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(requireValue(sendMessageSpy.mock.calls.at(0), "sendMessageSpy call")[1]).toBe(
      "PFX final reply",
    );
  });

  it("sends Codex usage-limit reset details as the Telegram reply body", async () => {
    const codexRateLimitText =
      "⚠️ You've reached your Codex subscription usage limit. Next reset in 42 minutes (2026-05-04T21:34:00.000Z). Run /codex account for current usage details.";
    replySpy.mockResolvedValue({ text: codexRateLimitText });
    configureOpenDm();

    createTelegramBot({ token: "tok" });
    const handler = getMessageHandler();
    await handler(
      makePrivateTextContext({
        chatId: 5,
        text: "hi",
        message: { from: undefined },
        downloadable: true,
      }),
    );

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(String(requireValue(sendMessageSpy.mock.calls.at(0), "sendMessageSpy call")[0])).toBe(
      "5",
    );
    expect(requireValue(sendMessageSpy.mock.calls.at(0), "sendMessageSpy call")[1]).toBe(
      codexRateLimitText,
    );
    expect(
      String(requireValue(sendMessageSpy.mock.calls.at(0), "sendMessageSpy call")[1]),
    ).not.toContain("All models are temporarily rate-limited");
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
        text: "a".repeat(TELEGRAM_RICH_TEXT_LIMIT + 1024),
        replyToId: String(messageId),
      });
      loadConfig.mockReturnValue({
        channels: {
          telegram: { dmPolicy: "open", allowFrom: ["*"], streamMode: "off" },
        },
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
      for (const call of sendMessageSpy.mock.calls) {
        const params = call[2] as
          | { reply_to_message_id?: number; reply_parameters?: { message_id?: number } }
          | undefined;
        const actual = params?.reply_parameters?.message_id ?? params?.reply_to_message_id;
        if (mode === "all") {
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

  it("applies topic skill filters and system prompts", () => {
    const { groupConfig, topicConfig } = resolveTelegramScopedGroupConfig(
      {
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
      -1001234567890,
      99,
    );
    const settings = resolveTelegramGroupPromptSettings({ groupConfig, topicConfig });

    expect(settings.groupSystemPrompt).toBe("Group prompt\n\nTopic prompt");
    expect(settings.skillFilter).toStrictEqual([]);
  });
  it("delivers native /compact through the reply dispatcher", async () => {
    commandSpy.mockClear();
    sendMessageSpy.mockClear();
    dispatchReplyWithBufferedBlockDispatcher.mockClear();
    replySpy.mockResolvedValue({
      text: "⚙️ Compaction skipped: already_compacted_recently • ctx 0%",
    });

    loadConfig.mockReturnValue({
      commands: { native: true },
      messages: { visibleReplies: "message_tool" },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    createTelegramBot({ token: "tok" });
    const compactHandler = commandSpy.mock.calls.find((call) => call[0] === "compact")?.[1] as
      | ((ctx: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (!compactHandler) {
      throw new Error("compact command handler missing");
    }

    await compactHandler({
      message: {
        chat: { id: 1234, type: "private" },
        from: { id: 42, first_name: "Ada" },
        text: "/compact",
        date: 1736380800,
        message_id: 5,
      },
      match: "",
    });

    expect(sendMessageSpy).toHaveBeenCalled();
    const compactReply = requireValue(sendMessageSpy.mock.calls.at(0), "compact reply call");
    expect(String(compactReply[1])).toContain("Compaction skipped");
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
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
    const handler = requireValue(commandSpy.mock.calls.at(0), "commandSpy call")[1] as (
      ctx: Record<string, unknown>,
    ) => Promise<void>;

    await handler({
      ...makeForumGroupMessageCtx({ threadId: 99, text: "/status" }),
      match: "",
    });

    const statusCall = requireValue(sendMessageSpy.mock.calls.at(0), "status reply call");
    expect(statusCall[0]).toBe("-1001234567890");
    expect(statusCall[1]).toBeTypeOf("string");
    expectRecordFields(
      statusCall[2],
      { message_thread_id: 99, reply_to_message_id: 42 },
      "status reply options",
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
    expect(replySpy.mock.calls.at(0)?.[0].SessionKey).toContain("agent:agent-a:");

    boundAgentId = "agent-b";
    await invokeStatus(402);
    expect(replySpy).toHaveBeenCalledTimes(2);
    expect(replySpy.mock.calls.at(1)?.[0].SessionKey).toContain("agent:agent-b:");
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
    expect(sendMessageSpy.mock.calls.at(0)?.[1]).toContain("final reply");
  });
  it("dedupes duplicate message updates by update_id", async () => {
    onSpy.mockReset();
    replySpy.mockReset();

    configureOpenDm();

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

    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, verboseHandler);

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
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, migrationHandler);

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
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, reactionHandler);

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
      telegramBotDepsForTest.buildModelsProviderData as unknown as BuildModelsProviderDataMock;
    buildModelsProviderDataMock.mockClear();
    editMessageTextSpy.mockClear();

    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    const ctx = makeCallbackRetryContext({
      updateId: 666,
      id: "cbq-model-retry-1",
      data: "mdl_prov",
      messageId: 18,
    });

    buildModelsProviderDataMock.mockImplementationOnce(async () => {
      throw new Error("providers boom");
    });
    await expect(runMiddlewareChain(ctx)).rejects.toThrow("providers boom");
    await runMiddlewareChain(ctx);

    expect(buildModelsProviderDataMock).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy.mock.calls.at(0)?.[2]).toContain("Select a provider:");
    expect(
      (
        editMessageTextSpy.mock.calls.at(0)?.[3] as {
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
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    const ctx = makeCallbackRetryContext({
      updateId: 777,
      id: "cbq-commands-retry-1",
      data: "commands_page_2:main",
      messageId: 19,
    });

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
    const ctx = makeCallbackRetryContext({
      updateId: 777,
      id: "cbq-commands-permanent-edit-1",
      data: "commands_page_2:main",
      messageId: 20,
    });

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

    const ctx = makeCallbackRetryContext({
      updateId: 778,
      id: "cbq-commands-non-telegram-edit-1",
      data: "commands_page_2:main",
      messageId: 21,
    });

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
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    const ctx = makeCallbackRetryContext({
      updateId: 778,
      id: "cbq-commands-retry-2",
      data: "commands_page_2:main",
      messageId: 21,
    });

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
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    const resolvePluginBindingApprovalSpy = vi.mocked(resolvePluginConversationBindingApproval);
    resolvePluginBindingApprovalSpy.mockRejectedValueOnce(new Error("binding boom"));

    const ctx = makeCallbackRetryContext({
      updateId: 888,
      id: "cbq-plugin-binding-retry-1",
      data: buildPluginBindingApprovalCustomId("binding-1", "allow-once"),
      messageId: 20,
      text: "Plugin approval required.",
    });

    try {
      await expect(runMiddlewareChain(ctx)).rejects.toThrow("binding boom");
      await runMiddlewareChain(ctx);
    } finally {
      resolvePluginBindingApprovalSpy.mockRestore();
    }

    expect(editMessageReplyMarkupSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy.mock.calls.at(0)?.[1]).toContain("plugin bind approval");
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
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    resolveExecApprovalSpy.mockRejectedValueOnce(new Error("approval boom"));

    const ctx = makeCallbackRetryContext({
      updateId: 8895,
      id: "cbq-approval-retry-1",
      data: "/approve 138e9b8c allow-once",
      messageId: 231,
      text: "Approval required.",
    });

    await expect(runMiddlewareChain(ctx)).rejects.toThrow("approval boom");
    await runMiddlewareChain(ctx);

    expect(resolveExecApprovalSpy).toHaveBeenCalledTimes(2);
    expect(editMessageTextSpy).toHaveBeenCalledWith(
      1234,
      231,
      expect.stringContaining("Result: Allowed once"),
      { reply_markup: { inline_keyboard: [] } },
    );
    expect(editMessageReplyMarkupSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("retries model provider callbacks after a bubbled edit failure", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    const ctx = makeCallbackRetryContext({
      updateId: 889,
      id: "cbq-model-provider-retry-1",
      data: "mdl_prov",
      messageId: 23,
    });

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
    const runMiddlewareChain = (ctx: Record<string, unknown>) =>
      runTelegramTestMiddlewareChain(middlewareUseSpy, ctx, callbackHandler);

    const patchSessionEntrySpy = vi.spyOn(sessionStoreRuntime, "patchSessionEntry");
    patchSessionEntrySpy.mockRejectedValueOnce(new Error("session store boom"));

    const ctx = makeCallbackRetryContext({
      updateId: 890,
      id: "cbq-model-select-retry-1",
      data: "mdl_sel_openai/gpt-5.4",
      messageId: 24,
    });

    try {
      await expect(runMiddlewareChain(ctx)).rejects.toThrow("session store boom");
      await runMiddlewareChain(ctx);
    } finally {
      patchSessionEntrySpy.mockRestore();
    }

    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    const finalEditMessageText = editMessageTextSpy.mock.calls.at(-1)?.[2];
    expect(typeof finalEditMessageText === "string" ? finalEditMessageText : "").toContain(
      "Session-only model selection. Runtime unchanged.",
    );
    expect(
      editMessageTextSpy.mock.calls.some((call) =>
        (typeof call[2] === "string" ? call[2] : "").includes("Failed to change model"),
      ),
    ).toBe(false);
  });

  it("shows a permanent rejection when model selection is locked", async () => {
    createTelegramBot({ token: "tok" });
    const callbackHandler = getOnHandler("callback_query");
    const patchSessionEntrySpy = vi
      .spyOn(sessionStoreRuntime, "patchSessionEntry")
      .mockImplementationOnce(async (params) => {
        const entry = {
          sessionId: "locked-session",
          updatedAt: Date.now(),
          modelSelectionLocked: true,
        };
        await params.update(entry, { existingEntry: entry });
        return entry;
      });
    const ctx = makeCallbackRetryContext({
      id: "cbq-model-select-locked-1",
      data: "mdl_sel_openai/gpt-5.4",
      messageId: 25,
    });

    try {
      await expect(callbackHandler(ctx)).resolves.toBeUndefined();
    } finally {
      patchSessionEntrySpy.mockRestore();
    }

    expect(editMessageTextSpy).toHaveBeenCalledTimes(1);
    expect(editMessageTextSpy.mock.calls.at(-1)?.[2]).toBe(
      "❌ Model selection is locked for this session.",
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
