// Telegram tests cover send plugin behavior.
import fs from "node:fs";
import type { Bot } from "grammy";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createRequireRecord, importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownToTelegramHtml, telegramHtmlToPlainTextFallback } from "./format.js";
import {
  recordTelegramGroupHistoryEntry,
  selectTelegramGroupHistoryAfterLastSelf,
} from "./group-history-window.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import {
  buildTelegramConversationContext,
  createTelegramMessageCache,
  hasProviderObservedTelegramThreadBinding,
} from "./message-cache.js";
import { registerTelegramOutboundGroupHistoryRecorder } from "./outbound-message-context.js";
import {
  beginTelegramPollRegistration,
  getPreparedTelegramPollAnswer,
  prepareTelegramPollAnswerContext,
  settleTelegramPollAnswerContext,
} from "./poll-answer-context.js";
import { recordTelegramPollRegistryEntry } from "./poll-registry.js";
import { createTelegramPromptContextProjectionCursor } from "./prompt-context-projection.js";
import {
  countInputRichBlockMedia,
  countInputRichBlocks,
  inputRichBlocksToPlainText,
  type InputRichBlock,
} from "./rich-block-model.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramMessageCacheForTest as resetTelegramMessageCacheBucketsForTest,
  resetTelegramSentMessageCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";
import type { TelegramApiOverride } from "./send.js";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";
import { recordSentMessage, wasSentByBot } from "./sent-message-cache.js";
import {
  TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
  TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
} from "./sent-message-cache.legacy-state.js";

installTelegramSendTestHooks();

const {
  botApi,
  botRawApi,
  botConfigUseSpy,
  botCtorSpy,
  imageMetadata,
  loadConfig,
  loadWebMedia,
  maybePersistResolvedTelegramTarget,
  probeVideoDimensions,
} = getTelegramSendTestMocks();
const telegramSendModule = await importTelegramSendModule();
const { PlatformMessageNotDispatchedError } = await import("openclaw/plugin-sdk/error-runtime");
const { TelegramRequestNotStartedError } = await import("./network-errors.js");
const { getChildLogger, resetLogger, setLoggerOverride } =
  await import("openclaw/plugin-sdk/runtime-env");
const {
  buildInlineKeyboard,
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageReplyMarkupTelegram,
  editMessageTelegram,
  pinMessageTelegram,
  reactMessageTelegram,
  renameForumTopicTelegram,
  sendLocationTelegram,
  sendMessageTelegram: sendMessageTelegramImported,
  sendTypingTelegram,
  sendPollTelegram,
  sendStickerTelegram,
  unpinMessageTelegram,
} = telegramSendModule;
const sendMessageTelegramImpl = sendMessageTelegramImported;

type RichRawTextTestApi = Omit<TelegramApiOverride, "raw" | "sendMessage"> & {
  raw?: {
    sendRichMessage?: (params: {
      chat_id: number | string;
      rich_message: {
        blocks?: InputRichBlock[];
        markdown?: string;
        html?: string;
        skip_entity_detection?: boolean;
      };
      [key: string]: unknown;
    }) => Promise<unknown>;
  };
  sendMessage?: (
    chatId: number | string,
    text: string,
    params?: Record<string, unknown>,
  ) => Promise<unknown>;
};

type RichMessageTestPayload = Parameters<
  NonNullable<NonNullable<RichRawTextTestApi["raw"]>["sendRichMessage"]>
>[0]["rich_message"];

function richTextForTest(richMessage: RichMessageTestPayload): string {
  if (richMessage.blocks) {
    return inputRichBlocksToPlainText(richMessage.blocks);
  }
  return richMessage.markdown != null
    ? markdownToTelegramHtml(richMessage.markdown)
    : (richMessage.html ?? "");
}

function sendMessageTexts(mockFn: typeof botApi.sendMessage): string[] {
  return mockFn.mock.calls.map((call) => String(call[1] ?? ""));
}

function withRichRawTextTestApi(
  api: TelegramApiOverride | undefined,
): TelegramApiOverride | undefined {
  if (!api) {
    return undefined;
  }
  const textApi = api as RichRawTextTestApi;
  if (textApi.raw?.sendRichMessage || !textApi.sendMessage) {
    return api;
  }
  textApi.raw = {
    ...textApi.raw,
    sendRichMessage: async ({ chat_id, rich_message, ...params }) =>
      await textApi.sendMessage?.(chat_id, richTextForTest(rich_message), {
        parse_mode: "HTML",
        ...(rich_message.skip_entity_detection === true ? { skip_entity_detection: true } : {}),
        ...params,
      }),
  };
  return api;
}

const sendMessageTelegram: typeof sendMessageTelegramImpl = async (to, text, opts) =>
  await sendMessageTelegramImpl(
    to,
    text,
    opts
      ? {
          ...opts,
          api: withRichRawTextTestApi(opts.api),
        }
      : opts,
  );

const TELEGRAM_TEST_CFG = {};
const TELEGRAM_POLL_REGISTRY_NAMESPACE = "telegram.poll-registry";
const TELEGRAM_POLL_REGISTRY_MAX_ENTRIES = 10_000;
type TelegramPollRegistryEntry = Omit<
  Parameters<typeof recordTelegramPollRegistryEntry>[0],
  "accountId" | "env"
> & { createdAt: number };
type PersistedSentMessageForTest = {
  scopeKey: string;
  chatId: string;
  messageId: string;
  timestamp: number;
};
let sentMessageStore: PluginStateSyncKeyedStore<PersistedSentMessageForTest>;

function markdownTable(columns: number): string {
  return [
    Array.from({ length: columns }, (_, index) => `H${index + 1}`).join(" | "),
    Array.from({ length: columns }, () => "---").join(" | "),
    Array.from({ length: columns }, (_, index) => String(index + 1)).join(" | "),
  ]
    .map((row) => `| ${row} |`)
    .join("\n");
}

function countTelegramRichBlocks(blocks: readonly InputRichBlock[] | undefined): number {
  return countInputRichBlocks(blocks ?? []);
}

beforeEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
  sentMessageStore = createPluginStateSyncKeyedStoreForTests("telegram", {
    namespace: TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE,
    maxEntries: TELEGRAM_SENT_MESSAGE_CACHE_MAX_ENTRIES,
  });
  sentMessageStore.clear();
  installTelegramStateRuntimeForTest(sentMessageStore);
  resetTelegramSentMessageCacheForTest();
});

function installTelegramStateRuntimeForTest(
  syncStore: PluginStateSyncKeyedStore<PersistedSentMessageForTest>,
): void {
  setTelegramRuntime({
    state: {
      openKeyedStore: ((options) =>
        createPluginStateKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openKeyedStore"],
      openSyncKeyedStore: ((options) =>
        options.namespace === TELEGRAM_SENT_MESSAGE_CACHE_NAMESPACE
          ? syncStore
          : createPluginStateSyncKeyedStoreForTests(
              "telegram",
              options,
            )) as TelegramRuntime["state"]["openSyncKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
}

describe("Telegram send Promise contract", () => {
  const contextFailureCalls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    [
      "sendMessageTelegram",
      () => sendMessageTelegramImported("123", "hello", { cfg: TELEGRAM_TEST_CFG }),
    ],
    ["sendTypingTelegram", () => sendTypingTelegram("123", { cfg: TELEGRAM_TEST_CFG })],
    [
      "reactMessageTelegram",
      () => reactMessageTelegram("123", 1, "👍", { cfg: TELEGRAM_TEST_CFG }),
    ],
    ["deleteMessageTelegram", () => deleteMessageTelegram("123", 1, { cfg: TELEGRAM_TEST_CFG })],
    ["pinMessageTelegram", () => pinMessageTelegram("123", 1, { cfg: TELEGRAM_TEST_CFG })],
    [
      "unpinMessageTelegram",
      () => unpinMessageTelegram("123", undefined, { cfg: TELEGRAM_TEST_CFG }),
    ],
    [
      "editForumTopicTelegram",
      () => editForumTopicTelegram("123", 1, { cfg: TELEGRAM_TEST_CFG, name: "topic" }),
    ],
    [
      "editMessageReplyMarkupTelegram",
      () => editMessageReplyMarkupTelegram("123", 1, [], { cfg: TELEGRAM_TEST_CFG }),
    ],
    [
      "editMessageTelegram",
      () => editMessageTelegram("123", 1, "hello", { cfg: TELEGRAM_TEST_CFG }),
    ],
    [
      "sendStickerTelegram",
      () => sendStickerTelegram("123", "file-id", { cfg: TELEGRAM_TEST_CFG }),
    ],
    [
      "sendPollTelegram",
      () =>
        sendPollTelegram(
          "123",
          { question: "Question?", options: ["A", "B"] },
          { cfg: TELEGRAM_TEST_CFG },
        ),
    ],
    [
      "createForumTopicTelegram",
      () => createForumTopicTelegram("123", "topic", { cfg: TELEGRAM_TEST_CFG }),
    ],
  ];

  it.each(contextFailureCalls)(
    "%s reports context failures as Promise rejections",
    async (_name, invoke) => {
      let operation: Promise<unknown> | undefined;
      expect(() => {
        operation = invoke();
      }).not.toThrow();
      if (!operation) {
        throw new Error("expected Telegram operation promise");
      }
      await expect(operation).rejects.toThrow(/Telegram bot token missing/i);
    },
  );
});

async function expectChatNotFoundWithChatId(
  action: Promise<unknown>,
  expectedChatId: string,
): Promise<void> {
  try {
    await action;
    throw new Error("Expected action to reject with chat-not-found context");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Expected action to reject with chat-not-found context"
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/chat not found/i);
    expect(message).toMatch(new RegExp(`chat_id=${expectedChatId}`));
  }
}

async function expectTelegramMembershipErrorWithChatId(
  action: Promise<unknown>,
  expectedChatId: string,
  expectedDetail: RegExp,
): Promise<void> {
  try {
    await action;
    throw new Error("Expected action to reject with membership error context");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Expected action to reject with membership error context"
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/not a member of the chat, was blocked, or was kicked/i);
    expect(message).toMatch(expectedDetail);
    expect(message).toMatch(/Fix: Add the bot to the channel\/group/i);
    expect(message).toMatch(new RegExp(`chat_id=${expectedChatId}`));
  }
}

function mockLoadedMedia({
  buffer = Buffer.from("media"),
  contentType,
  fileName,
}: {
  buffer?: Buffer;
  contentType?: string;
  fileName?: string;
}): void {
  loadWebMedia.mockResolvedValueOnce({
    buffer,
    ...(contentType ? { contentType } : {}),
    ...(fileName ? { fileName } : {}),
  });
}

function requireMockCall<T extends unknown[]>(call: T | undefined, label: string): T {
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

function mockCall(mock: ReturnType<typeof vi.fn>, index: number, label: string): unknown[] {
  const calls = mock.mock.calls;
  const resolvedIndex = index < 0 ? calls.length + index : index;
  return requireMockCall(calls[resolvedIndex], label);
}

function firstMockCall(mock: ReturnType<typeof vi.fn>, label: string): unknown[] {
  return mockCall(mock, 0, label);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${label} to be a string`);
  }
  return value;
}

const requireRecord = createRequireRecord("object", "expected-label");

function expectMediaSendCall(
  call: unknown[] | undefined,
  label: string,
  chatId: string,
  expectedParams: Record<string, unknown>,
): void {
  const [actualChatId, media, actualParams] = requireMockCall(call, label);
  expect(actualChatId).toBe(chatId);
  if (media === undefined) {
    throw new Error(`expected ${label} media`);
  }
  expect(actualParams).toEqual(expectedParams);
}

function createRichEntityInvalidError(entity = "EMAIL", operation = "sendRichMessage"): Error {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: RICH_MESSAGE_${entity}_INVALID)`,
  );
}

function createRichContentRequiredError(operation = "sendRichMessage"): Error {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: RICH_MESSAGE_CONTENT_REQUIRED)`,
  );
}

function createHtmlParseError(operation = "sendMessage"): Error {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: can't parse entities: Can't find end of the entity)`,
  );
}

function createChunkRejection(message = "chunk content rejected"): Error {
  return Object.assign(new Error(`400: Bad Request: ${message}`), { error_code: 400 });
}

function createQuoteNotFoundError(operation = "sendMessage"): Error {
  return new Error(
    `GrammyError: Call to '${operation}' failed! (400: Bad Request: quote not found)`,
  );
}

function expectPersistedTarget(fields: Record<string, unknown>): void {
  const [target] = requireMockCall(
    mockCall(maybePersistResolvedTelegramTarget, -1, "persisted Telegram target"),
    "persisted Telegram target",
  );
  const record = requireRecord(target, "persisted Telegram target");
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

let logCaptureCounter = 0;

function captureInfoLogs(): string {
  logCaptureCounter += 1;
  const logFile = `/tmp/openclaw-telegram-send-log-${process.pid}-${logCaptureCounter}.jsonl`;
  fs.rmSync(logFile, { force: true });
  setLoggerOverride({ level: "info", consoleLevel: "silent", file: logFile });
  return logFile;
}

async function capturedLogText(logFile: string): Promise<string> {
  const marker = `telegram-send-log-capture-ready=${logCaptureCounter}`;
  getChildLogger({ module: "telegram-send-test" }).info(marker);
  let content = "";
  // File logging is FIFO but asynchronous. Seeing this later marker proves all
  // records from the send attempt are durable before positive or negative checks.
  await vi.waitFor(() => {
    content = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    expect(content).toContain(marker);
  });
  return content;
}

afterEach(() => {
  resetTelegramSentMessageCacheForTest();
  clearTelegramRuntime();
  resetPluginStateStoreForTests();
  setLoggerOverride(null);
  resetLogger();
  resetTelegramMessageCacheBucketsForTest();
  vi.restoreAllMocks();
});

describe("sent-message-cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records and retrieves sent messages", () => {
    recordSentMessage(123, 1);
    recordSentMessage(123, 2);
    recordSentMessage(456, 10);

    expect(wasSentByBot(123, 1)).toBe(true);
    expect(wasSentByBot(123, 2)).toBe(true);
    expect(wasSentByBot(456, 10)).toBe(true);
    expect(wasSentByBot(123, 3)).toBe(false);
    expect(wasSentByBot(789, 1)).toBe(false);
  });

  it("handles string chat IDs", () => {
    recordSentMessage("123", 1);
    expect(wasSentByBot("123", 1)).toBe(true);
    expect(wasSentByBot(123, 1)).toBe(true);
  });

  it("keeps sent-message cache storage failures best-effort", () => {
    installTelegramStateRuntimeForTest({
      ...sentMessageStore,
      entries() {
        throw new Error("read boom");
      },
      register() {
        throw new Error("write boom");
      },
    });

    expect(() => recordSentMessage(123, 1)).not.toThrow();
    expect(wasSentByBot(123, 1)).toBe(true);
  });

  it("persists only the newly recorded sent-message row", () => {
    const persistedMessageIds: string[] = [];
    installTelegramStateRuntimeForTest({
      ...sentMessageStore,
      register(key, value, options) {
        sentMessageStore.register(key, value, options);
        persistedMessageIds.push(value.messageId);
      },
    });

    recordSentMessage(123, 1);
    recordSentMessage(123, 2);
    recordSentMessage(456, 10);

    expect(persistedMessageIds).toEqual(["1", "2", "10"]);
  });

  it("persists sent-message rows with a per-entry ttl", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-26T12:00:00.000Z"));
    const ttlByMessageId = new Map<string, number>();
    installTelegramStateRuntimeForTest({
      ...sentMessageStore,
      register(key, value, options) {
        sentMessageStore.register(key, value, options);
        ttlByMessageId.set(value.messageId, options?.ttlMs ?? 0);
      },
    });

    recordSentMessage(123, 1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    recordSentMessage(123, 2);

    expect(ttlByMessageId.get("1")).toBe(24 * 60 * 60 * 1000);
    expect(ttlByMessageId.get("2")).toBe(24 * 60 * 60 * 1000);
  });

  it("keeps sent-message ownership across restart", async () => {
    const persistedStorePath = `/tmp/openclaw-telegram-send-tests-${process.pid}-restart.json`;
    const sentMessageCfg = { session: { store: persistedStorePath } };

    recordSentMessage(123, 1, sentMessageCfg);
    expect(wasSentByBot(123, 1, sentMessageCfg)).toBe(true);

    resetTelegramSentMessageCacheForTest();

    const restartedCache = await importFreshModule<typeof import("./sent-message-cache.js")>(
      import.meta.url,
      "./sent-message-cache.js?scope=restart",
    );
    expect(restartedCache.wasSentByBot(123, 1, sentMessageCfg)).toBe(true);
  });

  it("keeps expired custom-store cleanup away from the default store", () => {
    const customStorePath = `/tmp/openclaw-telegram-send-tests-${process.pid}-custom-cleanup.json`;
    const customCfg = { session: { store: customStorePath } };
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);

    try {
      recordSentMessage(123, 2, customCfg);

      vi.setSystemTime(startedAt.getTime() + 24 * 60 * 60 * 1000 + 1);
      recordSentMessage(123, 1);

      expect(wasSentByBot(123, 2, customCfg)).toBe(false);
      expect(wasSentByBot(123, 1)).toBe(true);
    } finally {
      fs.rmSync(customStorePath, { force: true });
      fs.rmSync(`${customStorePath}.telegram-sent-messages.json`, { force: true });
    }
  });

  it("keeps default and custom stores isolated while both are loaded", () => {
    const customStorePath = `/tmp/openclaw-telegram-send-tests-${process.pid}-custom-isolated.json`;
    const customCfg = { session: { store: customStorePath } };

    try {
      recordSentMessage(123, 1);
      recordSentMessage(123, 2, customCfg);

      expect(wasSentByBot(123, 1)).toBe(true);
      expect(wasSentByBot(123, 2)).toBe(false);
      expect(wasSentByBot(123, 1, customCfg)).toBe(false);
      expect(wasSentByBot(123, 2, customCfg)).toBe(true);
    } finally {
      fs.rmSync(customStorePath, { force: true });
      fs.rmSync(`${customStorePath}.telegram-sent-messages.json`, { force: true });
    }
  });

  it("keeps sent-message ownership isolated across differently routed accounts", () => {
    const multiAgentCfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {} },
      },
      channels: {
        telegram: {
          accounts: {
            primary: { botToken: "123456:primary" },
            alerts: { botToken: "123456:alerts" },
          },
        },
      },
      bindings: [
        { agentId: "main", match: { channel: "telegram", accountId: "primary" } },
        { agentId: "ops", match: { channel: "telegram", accountId: "alerts" } },
      ],
      session: {
        store: "/tmp/openclaw-telegram-sent-owner/{agentId}/sessions.json",
      },
    } as OpenClawConfig;

    recordSentMessage(123, 1, multiAgentCfg, { accountId: "primary" });

    expect(wasSentByBot(123, 1, multiAgentCfg, { accountId: "primary" })).toBe(true);
    expect(wasSentByBot(123, 1, multiAgentCfg, { accountId: "alerts" })).toBe(false);

    recordSentMessage(123, 1, multiAgentCfg, { accountId: "alerts" });
    expect(wasSentByBot(123, 1, multiAgentCfg, { accountId: "alerts" })).toBe(true);
  });

  it("shares sent-message state across distinct module instances", async () => {
    const cacheA = await importFreshModule<typeof import("./sent-message-cache.js")>(
      import.meta.url,
      "./sent-message-cache.js?scope=shared-a",
    );
    const cacheB = await importFreshModule<typeof import("./sent-message-cache.js")>(
      import.meta.url,
      "./sent-message-cache.js?scope=shared-b",
    );
    resetTelegramSentMessageCacheForTest();

    try {
      cacheA.recordSentMessage(123, 1);
      expect(cacheB.wasSentByBot(123, 1)).toBe(true);
    } finally {
      resetTelegramSentMessageCacheForTest();
    }
  });
});

describe("buildInlineKeyboard", () => {
  it("normalizes keyboard inputs", () => {
    const cases: Array<{
      name: string;
      input: Parameters<typeof buildInlineKeyboard>[0];
      expected: ReturnType<typeof buildInlineKeyboard>;
    }> = [
      {
        name: "empty input",
        input: undefined,
        expected: undefined,
      },
      {
        name: "empty rows",
        input: [],
        expected: undefined,
      },
      {
        name: "valid rows",
        input: [
          [{ text: "Option A", callback_data: "cmd:a" }],
          [
            { text: "Option B", callback_data: "cmd:b" },
            { text: "Option C", callback_data: "cmd:c" },
          ],
        ],
        expected: {
          inline_keyboard: [
            [{ text: "Option A", callback_data: "cmd:a" }],
            [
              { text: "Option B", callback_data: "cmd:b" },
              { text: "Option C", callback_data: "cmd:c" },
            ],
          ],
        },
      },
      {
        name: "keeps button style fields",
        input: [
          [
            {
              text: "Option A",
              callback_data: "cmd:a",
              style: "primary",
            },
          ],
        ],
        expected: {
          inline_keyboard: [
            [
              {
                text: "Option A",
                callback_data: "cmd:a",
                style: "primary",
              },
            ],
          ],
        },
      },
      {
        name: "keeps url buttons",
        input: [[{ text: "Open", url: "https://example.com" }]],
        expected: {
          inline_keyboard: [[{ text: "Open", url: "https://example.com" }]],
        },
      },
      {
        name: "keeps web app buttons",
        input: [[{ text: "Launch", web_app: { url: "https://example.com/app" } }]],
        expected: {
          inline_keyboard: [[{ text: "Launch", web_app: { url: "https://example.com/app" } }]],
        },
      },
      {
        name: "prefers url over callback data when both are present",
        input: [[{ text: "Open", callback_data: "cmd:open", url: "https://example.com" }]],
        expected: {
          inline_keyboard: [[{ text: "Open", url: "https://example.com" }]],
        },
      },
      {
        name: "filters invalid buttons and empty rows",
        input: [
          [
            { text: "", callback_data: "cmd:skip" },
            { text: "Ok", callback_data: "cmd:ok" },
          ],
          [{ text: "Missing data", callback_data: "" }],
          [{ text: "Missing action" }],
          [],
        ],
        expected: {
          inline_keyboard: [[{ text: "Ok", callback_data: "cmd:ok" }]],
        },
      },
    ];
    for (const testCase of cases) {
      const input = testCase.input?.map((row) => row.map((button) => ({ ...button })));
      expect(buildInlineKeyboard(input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("sendMessageTelegram", () => {
  it("sends typing to the resolved chat and topic", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.sendChatAction.mockResolvedValue(true);

    await sendTypingTelegram("telegram:group:-1001234567890:topic:271", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
    });

    expect(botApi.sendChatAction).toHaveBeenCalledWith("-1001234567890", "typing", {
      message_thread_id: 271,
    });
  });

  it("retries snippet-only network errors when sending typing", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.sendChatAction
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(true);

    await sendTypingTelegram("telegram:group:-1001234567890", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(botApi.sendChatAction).toHaveBeenCalledTimes(2);
  });

  it("pins and unpins Telegram messages", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.pinChatMessage.mockResolvedValue(true);
    botApi.unpinChatMessage.mockResolvedValue(true);

    await pinMessageTelegram("-1001234567890", 101, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
    });
    await unpinMessageTelegram("-1001234567890", 101, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
    });

    expect(botApi.pinChatMessage).toHaveBeenCalledWith("-1001234567890", 101, {
      disable_notification: true,
    });
    expect(botApi.unpinChatMessage).toHaveBeenCalledWith("-1001234567890", 101);
  });

  it("honors Telegram pin notification requests", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.pinChatMessage.mockResolvedValue(true);

    await pinMessageTelegram("-1001234567890", 101, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
      notify: true,
    });

    expect(botApi.pinChatMessage).toHaveBeenCalledWith("-1001234567890", 101, {
      disable_notification: false,
    });
  });

  it("renames a Telegram forum topic", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await renameForumTopicTelegram("-1001234567890", 271, "Codex Thread", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, {
      name: "Codex Thread",
    });
  });

  it("edits a Telegram forum topic name and icon via the shared helper", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await editForumTopicTelegram("-1001234567890", 271, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
      name: "Codex Thread",
      iconCustomEmojiId: "emoji-123",
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, {
      name: "Codex Thread",
      icon_custom_emoji_id: "emoji-123",
    });
  });

  it.each([
    ["65 emoji", "😀".repeat(65)],
    ["128 emoji", "😀".repeat(128)],
    ["128 mixed emoji and ASCII characters", "😀".repeat(64) + "a".repeat(64)],
    ["128 CJK characters", "界".repeat(128)],
  ])("accepts %s forum topic names by Unicode code points", async (_label, name) => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await editForumTopicTelegram("-1001234567890", 271, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
      name,
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, { name });
  });

  it("strips topic suffixes before editing a Telegram forum topic", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await editForumTopicTelegram("telegram:group:-1001234567890:topic:271", 271, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
      name: "Codex Thread",
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, {
      name: "Codex Thread",
    });
  });

  it("rejects empty topic edits before creating a Telegram client", async () => {
    botCtorSpy.mockClear();

    await expect(
      editForumTopicTelegram("-1001234567890", 271, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        accountId: "default",
      }),
    ).rejects.toThrow("Telegram forum topic update requires a name or iconCustomEmojiId");
    await expect(
      editForumTopicTelegram("-1001234567890", 271, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        accountId: "default",
        iconCustomEmojiId: "   ",
      }),
    ).rejects.toThrow("Telegram forum topic icon custom emoji ID is required");
    expect(botCtorSpy).not.toHaveBeenCalled();
  });

  it("ignores removed timeoutSeconds config", async () => {
    const cases = [
      {
        name: "global telegram timeout",
        cfg: { channels: { telegram: { timeoutSeconds: 60 } } },
        opts: { cfg: TELEGRAM_TEST_CFG, token: "tok" },
        expectedTimeout: undefined,
      },
      {
        name: "per-account timeout override",
        cfg: {
          channels: {
            telegram: {
              timeoutSeconds: 60,
              accounts: { foo: { timeoutSeconds: 61 } },
            },
          },
        },
        opts: { cfg: TELEGRAM_TEST_CFG, token: "tok", accountId: "foo" },
        expectedTimeout: undefined,
      },
    ] as const;
    for (const testCase of cases) {
      botCtorSpy.mockClear();
      loadConfig.mockReturnValue(testCase.cfg);
      botApi.sendMessage.mockResolvedValue({
        message_id: 1,
        chat: { id: "123" },
      });
      await sendMessageTelegram("123", "hi", { ...testCase.opts, cfg: testCase.cfg });
      const [token, options] = firstMockCall(botCtorSpy, "bot constructor call");
      expect(token, testCase.name).toBe("tok");
      const client = requireRecord(requireRecord(options, "bot options").client, "bot client");
      expect(client.timeoutSeconds, testCase.name).toBe(testCase.expectedTimeout);
    }
  });

  it("normalizes full Telegram bot endpoint apiRoot before send clients reach grammY", async () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            foo: {
              apiRoot: "https://api.telegram.org/bot123456:ABC/",
            },
          },
        },
      },
    };
    loadConfig.mockReturnValue(cfg);
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await sendMessageTelegram("123", "hi", { cfg, token: "tok", accountId: "foo" });

    const [token, options] = firstMockCall(botCtorSpy, "bot constructor call");
    expect(token).toBe("tok");
    const client = requireRecord(requireRecord(options, "bot options").client, "bot client");
    expect(client.apiRoot).toBe("https://api.telegram.org");
  });

  it("installs the shared grammY throttler on send clients", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await sendMessageTelegram("123", "hi", { cfg: TELEGRAM_TEST_CFG, token: "tok" });

    const [middleware] = firstMockCall(botConfigUseSpy, "bot config use call");
    expect(middleware).toBeTypeOf("function");
  });

  it("records sent text messages into the Telegram prompt context cache", async () => {
    const storePath = `/tmp/openclaw-telegram-send-context-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    botApi.sendMessage.mockResolvedValueOnce({
      message_id: 1497,
      date: 1_779_394_740,
      chat: {
        id: "-1003966283270",
        type: "supergroup",
        title: "Keshav and Kelaw - Keshav's Bot",
      },
      from: { id: 42, is_bot: true, first_name: "Kelaw", username: "keshavbotagent" },
      text: "Done already: timeoutSeconds is now 7200s.",
      message_thread_id: 1154,
    });

    await sendMessageTelegram("-1003966283270", "Done already: timeoutSeconds is now 7200s.", {
      cfg,
      token: "tok",
      messageThreadId: 1154,
    });

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: "-1003966283270",
      threadId: 1154,
      msg: {
        chat: {
          id: -1003966283270,
          type: "supergroup",
          title: "Keshav and Kelaw - Keshav's Bot",
        },
        message_thread_id: 1154,
        message_id: 1521,
        date: 1_779_425_460,
        text: "Did all Amazon crons run fine",
        from: { id: 5185575566, is_bot: false, first_name: "Keshav" },
      },
    });

    const context = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: "-1003966283270",
      threadId: 1154,
      messageId: "1521",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    expect(context.map((entry) => entry.node.messageId)).toContain("1497");
    expect(context.map((entry) => entry.node.body)).toContain(
      "Done already: timeoutSeconds is now 7200s.",
    );
  });

  it("records a successful General-topic send when the response omits the thread id", async () => {
    const storePath = `/tmp/openclaw-telegram-general-context-${process.pid}-${Date.now()}.json`;
    const chatId = "-1003966283270";
    botApi.sendMessage.mockResolvedValueOnce({
      message_id: 1498,
      date: 1_779_394_741,
      chat: { id: chatId, type: "supergroup", title: "QA forum" },
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      text: "Reply in General",
    });

    await sendMessageTelegram(`${chatId}:topic:1`, "Reply in General", {
      cfg: { session: { store: storePath } },
      token: "tok",
    });

    expect(firstMockCall(botApi.sendMessage, "General-topic send")[2]).not.toHaveProperty(
      "message_thread_id",
    );
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({
      accountId: "default",
      chatId,
      messageId: "1498",
    });
    expect(hasProviderObservedTelegramThreadBinding(cached, 1)).toBe(true);
  });

  it("records transcript projection metadata without replacing Telegram time", async () => {
    const storePath = `/tmp/openclaw-telegram-send-context-override-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-final",
    });
    botApi.sendMessage.mockResolvedValueOnce({
      message_id: 1497,
      date: 1_779_394_745,
      chat: { id: "123", type: "private" },
      from: { id: 42, is_bot: true, first_name: "Kelaw" },
      text: "Final answer",
    });

    await sendMessageTelegram("123", "Final answer", {
      cfg,
      token: "tok",
      promptContextProjectionPlan: { cursor, finalPart: true },
    });

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const node = await cache.get({
      accountId: "default",
      chatId: "123",
      messageId: "1497",
    });

    expect(node?.timestamp).toBe(1_779_394_745_000);
    expect(node?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: { ...cursor.source, partIndex: 0, finalPart: true },
    });
    expect(cursor.nextPartIndex).toBe(1);
  });

  it("invalidates the projection cursor when a later chunk fails terminally", async () => {
    const storePath = `/tmp/openclaw-telegram-projection-terminal-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-final",
    });
    const invalidate = vi.spyOn(cursor, "invalidate");
    botApi.sendMessage
      .mockResolvedValueOnce({
        message_id: 1601,
        date: 1_779_394_745,
        chat: { id: "123", type: "private" },
        from: { id: 42, is_bot: true, first_name: "Kelaw" },
        text: "page one",
      })
      .mockRejectedValueOnce(new Error("400: Bad Request: chat not found"));

    await expect(
      sendMessageTelegram("123", "A".repeat(4200), {
        cfg,
        token: "tok",
        promptContextProjectionPlan: { cursor, finalPart: true },
      }),
    ).rejects.toThrow();

    expect(invalidate).toHaveBeenCalled();
  });

  it("records transcript projection metadata for native locations", async () => {
    const storePath = `/tmp/openclaw-telegram-location-context-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-location",
    });
    const sendLocation = vi.fn().mockResolvedValue({
      message_id: 1498,
      date: 1_779_394_746,
      chat: { id: "123", type: "private" },
      from: { id: 42, is_bot: true, first_name: "Kelaw" },
      location: { latitude: 48.858844, longitude: 2.294351 },
    });

    await sendLocationTelegram(
      "123",
      { latitude: 48.858844, longitude: 2.294351 },
      {
        cfg,
        token: "tok",
        api: { sendLocation } as unknown as TelegramApiOverride,
        promptContextProjectionPlan: { cursor, finalPart: true },
      },
    );

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const node = await cache.get({
      accountId: "default",
      chatId: "123",
      messageId: "1498",
    });

    expect(node?.timestamp).toBe(1_779_394_746_000);
    expect(node?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: { ...cursor.source, partIndex: 0, finalPart: true },
    });
    expect(cursor.nextPartIndex).toBe(1);
  });

  it("normalizes raw code language HTML before sending", async () => {
    const chatId = "123";
    const text = [
      "Yep. Send these in order:",
      "",
      '<code class="language-text">/queue followup debounce:0',
      "</code>",
    ].join("\n");
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 44, chat: { id: chatId } });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const res = await sendMessageTelegram(chatId, text, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      chatId,
      ["Yep. Send these in order:", "", "<code>/queue followup debounce:0", "</code>"].join("\n"),
      { parse_mode: "HTML" },
    );
    expect(res.chatId).toBe(chatId);
    expect(res.messageId).toBe("44");
  });

  it("disables link previews on the text send path", async () => {
    const cases = [
      {
        name: "html send succeeds",
        text: "hi",
        sendMessage: vi.fn().mockResolvedValue({ message_id: 7, chat: { id: "123" } }),
        expectedCalls: [
          ["123", "hi", { parse_mode: "HTML", link_preview_options: { is_disabled: true } }],
        ],
      },
    ] as const;
    for (const testCase of cases) {
      const cfg = {
        channels: { telegram: { linkPreview: false } },
      };
      loadConfig.mockReturnValue(cfg);
      const api = { sendMessage: testCase.sendMessage } as unknown as {
        sendMessage: typeof testCase.sendMessage;
      };
      await sendMessageTelegram("123", testCase.text, {
        cfg,
        token: "tok",
        api,
      });
      expect(testCase.sendMessage.mock.calls, testCase.name).toEqual(testCase.expectedCalls);
    }
  });

  it("sends formatted HTML for durable text", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 45, chat: { id: "123" } });

    await sendMessageTelegram("123", "**hi**", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage).toHaveBeenCalledWith("123", "<b>hi</b>", {
      parse_mode: "HTML",
    });
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("sends native rich tables when explicitly enabled", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 45, chat: { id: "123" } });
    const markdown = markdownTable(3);

    await sendMessageTelegram("123", markdown, {
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            markdown: { tables: "block" },
          },
        },
      },
      token: "tok",
    });

    expect(botRawApi.sendRichMessage).toHaveBeenCalledTimes(1);
    const richMessage = botRawApi.sendRichMessage.mock.calls[0]?.[0]?.rich_message;
    expect(richMessage?.blocks?.some((block: InputRichBlock) => block.type === "table")).toBe(true);
  });

  it("degrades wide markdown tables to ASCII pre blocks on rich sends", async () => {
    const logFile = captureInfoLogs();
    botApi.sendMessage.mockResolvedValue({ message_id: 45, chat: { id: "123" } });

    await sendMessageTelegram("123", markdownTable(21), {
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
            markdown: { tables: "block" },
          },
        },
      },
      token: "tok",
    });

    const richMessage = botRawApi.sendRichMessage.mock.calls[0]?.[0]?.rich_message;
    expect(richMessage?.blocks?.some((block: InputRichBlock) => block.type === "pre")).toBe(true);
    expect(await capturedLogText(logFile)).toContain("rich-degrade=table-ascii");
  });

  it("skips rich entity detection for provider-prefixed email text", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 45, chat: { id: "123" } });
    const oauthProfileText =
      "OAuth profile: openai:keshavbotagent@gmail.com (keshavbotagent@gmail.com)";

    await sendMessageTelegram("123", oauthProfileText, {
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
          },
        },
      },
      token: "tok",
    });

    expect(botRawApi.sendRichMessage).toHaveBeenCalledTimes(1);
    const richMessage = botRawApi.sendRichMessage.mock.calls[0]?.[0]?.rich_message;
    expect(richMessage).toEqual({
      blocks: [{ type: "paragraph", text: oauthProfileText }],
      skip_entity_detection: true,
    });
  });

  it("falls back to plain text when durable rich sends reject an invalid entity", async () => {
    const text = "Status includes openai:owner@example.com";
    botRawApi.sendRichMessage.mockRejectedValueOnce(createRichEntityInvalidError("EMAIL"));
    botApi.sendMessage.mockResolvedValueOnce({ message_id: 46, chat: { id: "123" } });

    const result = await sendMessageTelegram("123", text, {
      cfg: { channels: { telegram: { richMessages: true } } },
      token: "tok",
    });

    expect(botRawApi.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(botApi.sendMessage).toHaveBeenCalledWith("123", text);
    expect(result).toEqual({ messageId: "46", chatId: "123" });
  });

  it("falls back to plain text when durable rich sends require nonempty content", async () => {
    const text = "still visible after rich content rejection";
    botRawApi.sendRichMessage.mockRejectedValueOnce(createRichContentRequiredError());
    botApi.sendMessage.mockResolvedValueOnce({ message_id: 55, chat: { id: "123" } });

    const result = await sendMessageTelegram("123", text, {
      cfg: { channels: { telegram: { richMessages: true } } },
      token: "tok",
    });

    expect(botRawApi.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(botApi.sendMessage).toHaveBeenCalledWith("123", text);
    expect(result).toEqual({ messageId: "55", chatId: "123" });
  });

  it("routes caller HTML through the legacy HTML transport on rich accounts", async () => {
    // Rich HTML treats literal newlines as insignificant; parse_mode HTML keeps
    // them, so caller-authored HTML must stay on the legacy transport.
    const html = "<b>one</b>\ntwo";
    botApi.sendMessage.mockResolvedValueOnce({ message_id: 46, chat: { id: "123" } });

    await sendMessageTelegram("123", html, {
      cfg: { channels: { telegram: { richMessages: true } } },
      token: "tok",
      textMode: "html",
    });

    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
    expect(botApi.sendMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("<b>one</b>\ntwo"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
  });

  it("continues rich plain-fallback chunks after a middle rejection", async () => {
    const text = `Status includes openai:owner@example.com ${"A".repeat(8500)}`;
    const storePath = `/tmp/openclaw-telegram-projection-rich-fallback-${process.pid}-${Date.now()}.json`;
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-rich",
    });
    botRawApi.sendRichMessage.mockRejectedValueOnce(createRichEntityInvalidError("EMAIL"));
    botApi.sendMessage
      .mockResolvedValueOnce({ message_id: 47, chat: { id: "123" } })
      .mockRejectedValueOnce(createChunkRejection())
      .mockResolvedValueOnce({ message_id: 49, chat: { id: "123" } });

    let observed: unknown;
    try {
      await sendMessageTelegram("123", text, {
        cfg: {
          channels: { telegram: { richMessages: true } },
          session: { store: storePath },
        },
        token: "tok",
        replyToMessageId: 100,
        replyToIdSource: "implicit",
        replyToMode: "first",
        promptContextProjectionPlan: { cursor, finalPart: true },
      });
    } catch (error) {
      observed = error;
    }

    expect(botRawApi.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(botApi.sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessageTexts(botApi.sendMessage).every((chunk) => chunk.length <= 4000)).toBe(true);
    for (const call of botApi.sendMessage.mock.calls) {
      expect(call[2]).toBeUndefined();
    }
    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult.messageIds).toEqual(["47", "49"]);
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const first = await cache.get({ accountId: "default", chatId: "123", messageId: "47" });
    const third = await cache.get({ accountId: "default", chatId: "123", messageId: "49" });
    expect([first?.promptContextProjectionMarker, third?.promptContextProjectionMarker]).toEqual([
      {
        kind: "valid",
        projection: { ...cursor.source, partIndex: 0, finalPart: false },
      },
      { kind: "valid", projection: { ...cursor.source, partIndex: 1, finalPart: false } },
    ]);
    expect(cursor.nextPartIndex).toBe(2);
    expect(cursor.complete).toBe(false);
    expect(observed.deliveryResult.receipt?.platformMessageIds).toEqual(["47", "49"]);
  });

  it("chunks rich paragraph output at Telegram's block limit", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 45, chat: { id: "123" } });
    const text = Array.from({ length: 501 }, (_, index) => `paragraph ${index}`).join("\n\n");

    await sendMessageTelegram("123", text, {
      cfg: {
        channels: {
          telegram: {
            richMessages: true,
          },
        },
      },
      token: "tok",
    });

    expect(botRawApi.sendRichMessage.mock.calls.length).toBeGreaterThan(1);
    for (const call of botRawApi.sendRichMessage.mock.calls) {
      expect(countTelegramRichBlocks(call[0]?.rich_message.blocks)).toBeLessThanOrEqual(500);
    }
    const plain = botRawApi.sendRichMessage.mock.calls
      .map((call) => inputRichBlocksToPlainText(call[0]?.rich_message.blocks ?? []))
      .join("\n");
    expect(plain).toContain("paragraph 500");
  });

  it("keeps recursive list and album payloads within Telegram transport limits", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 45, chat: { id: "123" } });
    const list = Array.from({ length: 250 }, (_, index) => `${index + 1}. item ${index + 1}`).join(
      "\n",
    );
    const photos = Array.from(
      { length: 51 },
      (_, index) => `<img src="https://example.com/${index}.jpg"/>`,
    ).join("");

    await sendMessageTelegram(
      "123",
      `${list}\n\n<tg-collage>${photos}<figcaption>Album</figcaption></tg-collage>`,
      {
        cfg: { channels: { telegram: { richMessages: true } } },
        token: "tok",
      },
    );

    const requests: Array<RichMessageTestPayload | undefined> =
      botRawApi.sendRichMessage.mock.calls.map((call) => call[0]?.rich_message);
    const blocks = requests.flatMap((request) => request?.blocks ?? []);
    const items = blocks.flatMap((block) => (block.type === "list" ? block.items : []));
    const albums = blocks.filter((block) => block.type === "collage");

    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((request) => countInputRichBlocks(request?.blocks ?? []) <= 500)).toBe(
      true,
    );
    expect(
      requests.every(
        (request) =>
          (request?.blocks ?? []).reduce(
            (total, block) => total + countInputRichBlockMedia(block),
            0,
          ) <= 50,
      ),
    ).toBe(true);
    expect(items.map((item) => item.value)).toEqual(
      Array.from({ length: 250 }, (_, index) => index + 1),
    );
    expect(albums.flatMap((album) => album.blocks)).toHaveLength(51);
    expect(albums.flatMap((album) => (album.caption ? [album.caption.text] : []))).toEqual([
      "Album",
    ]);
  });

  it("applies rich entity detection skip to every chunk of the document", async () => {
    // The whole document renders with one linkify decision, so a skip trigger
    // anywhere (the email) must set the wire flag on every chunk; a chunk-local
    // flag would let Telegram re-linkify unprotected file refs in other chunks.
    botApi.sendMessage.mockResolvedValue({ message_id: 45, chat: { id: "123" } });
    const firstChunk = Array.from(
      { length: 700 },
      (_, index) => `[link ${index}](https://example.com/${index})`,
    ).join("\n\n");
    const text = `${firstChunk}\n\nOAuth profile: openai:owner@example.com`;

    await sendMessageTelegram("123", text, {
      cfg: { channels: { telegram: { richMessages: true } } },
      token: "tok",
    });

    expect(botRawApi.sendRichMessage.mock.calls.length).toBeGreaterThan(1);
    const richMessages = botRawApi.sendRichMessage.mock.calls.map((call) => call[0]?.rich_message);
    expect(richMessages.every((richMessage) => richMessage?.skip_entity_detection === true)).toBe(
      true,
    );
  });

  it("keeps newlines inside rich paragraph blocks", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 60, chat: { id: "123" } });

    await sendMessageTelegram(
      "123",
      "Start here:\n\n• Florist - Red Bird\n• Tomberlin - Seventeen",
      { cfg: { channels: { telegram: { richMessages: true } } }, token: "tok" },
    );

    expect(botRawApi.sendRichMessage).toHaveBeenCalledTimes(1);
    const blocks = botRawApi.sendRichMessage.mock.calls[0]?.[0]?.rich_message.blocks ?? [];
    expect(inputRichBlocksToPlainText(blocks)).toContain("• Florist - Red Bird");
    expect(inputRichBlocksToPlainText(blocks)).toContain("• Tomberlin - Seventeen");
  });

  it("preserves nonempty Markdown when rich rendering is empty", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 45, chat: { id: "123" } });
    const markdown = "[reference]: https://example.com";

    await sendMessageTelegram("123", markdown, {
      cfg: { channels: { telegram: { richMessages: true } } },
      token: "tok",
    });

    // Link-definition-only markdown may render empty blocks; plain fallback or skip is ok.
    if (botRawApi.sendRichMessage.mock.calls.length > 0) {
      const blocks = botRawApi.sendRichMessage.mock.calls[0]?.[0]?.rich_message.blocks ?? [];
      expect(Array.isArray(blocks)).toBe(true);
    }
  });

  it.each([
    {
      name: "local path",
      markdown:
        "See [scripts/yougile.py](/home/user/.openclaw/workspace/scripts/yougile.py#L41) and [docs](https://example.com/docs)",
    },
    {
      name: "relative path",
      markdown: "Edit [config](./openclaw.json) or see [docs](https://example.com/docs)",
    },
  ])("keeps rich delivery when a markdown link targets a $name", async (testCase) => {
    botApi.sendMessage.mockResolvedValue({ message_id: 48, chat: { id: "123" } });

    await sendMessageTelegram("123", testCase.markdown, {
      cfg: { channels: { telegram: { richMessages: true } } },
      token: "tok",
    });

    expect(botRawApi.sendRichMessage).toHaveBeenCalledTimes(1);
    const blocks = botRawApi.sendRichMessage.mock.calls[0]?.[0]?.rich_message.blocks ?? [];
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain('"/home');
    expect(serialized).not.toContain('"./"');
    expect(serialized).toContain("https://example.com/docs");
  });

  it("renders complex markdown into HTML text", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 46, chat: { id: "123" } });
    const markdown = [
      "# Heading",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| **bold** | _italic_ |",
      "",
      "> quoted `code`",
      "",
      "||spoiler|| and [link](https://example.com)",
    ].join("\n");

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, sentText, sentOptions] = botApi.sendMessage.mock.calls.at(-1) ?? [];
    expect(chatId).toBe("123");
    expect(String(sentText)).toContain("<blockquote>");
    expect(String(sentText)).toContain("<tg-spoiler>spoiler</tg-spoiler>");
    expect(String(sentText)).toContain('<a href="https://example.com">link</a>');
    expect(sentOptions).toEqual({ parse_mode: "HTML" });
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("renders markdown media syntax on the text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 47, chat: { id: "123" } });

    await sendMessageTelegram("123", "See ![diagram](https://example.com/diagram.png)", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage).toHaveBeenCalledWith("123", "See diagram", { parse_mode: "HTML" });
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("escapes literal reasoning-looking tags on the text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 47, chat: { id: "123" } });

    await sendMessageTelegram("123", "Before <think>literal tag text after", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage).toHaveBeenCalledWith(
      "123",
      "Before &lt;think&gt;literal tag text after",
      { parse_mode: "HTML" },
    );
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("escapes HTML media tags on the text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 48, chat: { id: "123" } });

    await sendMessageTelegram("123", '<b>See</b><img src="https://example.com/diagram.png">', {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      textMode: "html",
    });

    expect(botApi.sendMessage).toHaveBeenCalledWith(
      "123",
      '<b>See</b>&lt;img src="https://example.com/diagram.png"&gt;',
      { parse_mode: "HTML" },
    );
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("keeps markdown tables within Telegram's HTML text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 49, chat: { id: "123" } });
    const markdown = markdownTable(20);

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessageTexts(botApi.sendMessage).join("")).toContain("| H1 | H2 |");
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("wraps wide markdown tables for the HTML text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 50, chat: { id: "123" } });
    const markdown = markdownTable(21);

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessageTexts(botApi.sendMessage).join("");
    expect(sent).toContain("<pre><code>");
    expect(sent).toContain("| H21 |");
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("leaves wide fenced tables intact on the HTML text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 51, chat: { id: "123" } });
    const markdown = `~~~\n${markdownTable(25)}\n~~~`;

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessageTexts(botApi.sendMessage).join("")).toContain(markdownTable(25));
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("wraps only wide markdown tables outside fences on the HTML text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 52, chat: { id: "123" } });
    const fencedTable = markdownTable(25);
    const outsideTable = markdownTable(21);
    const markdown = ["Before", "~~~", fencedTable, "~~~", "After", outsideTable].join("\n");

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    const sent = sendMessageTexts(botApi.sendMessage).join("");
    expect(sent).toContain("Before");
    expect(sent).toContain(fencedTable);
    expect(sent).toContain("<pre><code>");
    expect(sent).toContain("| H21 |");
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("sends medium markdown text as one HTML message", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 53, chat: { id: "123" } });
    const markdown = `# Long\n\n${"**section** with _style_ and `code`\n".repeat(800)}`;

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(sendMessageTexts(botApi.sendMessage).join("")).toContain("section");
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("chunks markdown above the Telegram text-message limit", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 54, chat: { id: "123" } });
    const markdown = `# Long\n\n${"**section** with _style_ and `code`\n".repeat(3000)}`;

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage.mock.calls.length).toBeGreaterThan(1);
    const chunks = sendMessageTexts(botApi.sendMessage);
    const joinedChunks = chunks.join("");
    expect(joinedChunks).toContain("Long");
    expect(joinedChunks).toContain("section");
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  });

  it("indexes every successful text chunk and marks only the last one final", async () => {
    const storePath = `/tmp/openclaw-telegram-projection-chunks-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-chunks",
    });
    botApi.sendMessage
      .mockResolvedValueOnce({ message_id: 154, date: 2, chat: { id: "123" } })
      .mockResolvedValueOnce({ message_id: 155, date: 3, chat: { id: "123" } });

    await sendMessageTelegram("123", "A".repeat(5_000), {
      cfg,
      token: "tok",
      promptContextProjectionPlan: { cursor, finalPart: true },
    });

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const first = await cache.get({ accountId: "default", chatId: "123", messageId: "154" });
    const second = await cache.get({ accountId: "default", chatId: "123", messageId: "155" });
    expect([first?.promptContextProjectionMarker, second?.promptContextProjectionMarker]).toEqual([
      {
        kind: "valid",
        projection: { ...cursor.source, partIndex: 0, finalPart: false },
      },
      { kind: "valid", projection: { ...cursor.source, partIndex: 1, finalPart: true } },
    ]);
    expect(cursor.nextPartIndex).toBe(2);
  });

  it("records each HTML chunk using that message's visible text", async () => {
    const storePath = `/tmp/openclaw-telegram-projection-html-chunks-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-html-chunks",
    });
    botApi.sendMessage
      .mockResolvedValueOnce({ message_id: 254, date: 2, chat: { id: "123" } })
      .mockResolvedValueOnce({ message_id: 255, date: 3, chat: { id: "123" } });

    await sendMessageTelegram("123", "<".repeat(1_000) + "y".repeat(3_000), {
      cfg,
      token: "tok",
      textMode: "html",
      promptContextProjectionPlan: { cursor, finalPart: true },
    });

    const visibleChunks = sendMessageTexts(botApi.sendMessage).map((html) =>
      telegramHtmlToPlainTextFallback(html),
    );
    expect(visibleChunks).toHaveLength(2);
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const cached = await Promise.all(
      [254, 255].map((messageId) =>
        cache.get({ accountId: "default", chatId: "123", messageId: String(messageId) }),
      ),
    );
    expect(cached.map((node) => node?.body)).toEqual(visibleChunks);
    expect(cached.map((node) => node?.promptContextProjectionMarker)).toEqual([
      {
        kind: "valid",
        projection: { ...cursor.source, partIndex: 0, finalPart: false },
      },
      {
        kind: "valid",
        projection: { ...cursor.source, partIndex: 1, finalPart: true },
      },
    ]);
  });

  it("does not consume a projection part for a rejected HTML attempt", async () => {
    const storePath = `/tmp/openclaw-telegram-projection-html-fallback-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-html",
    });
    botApi.sendMessage
      .mockRejectedValueOnce(createHtmlParseError())
      .mockResolvedValueOnce({ message_id: 156, date: 2, chat: { id: "123" } });

    await sendMessageTelegram("123", "**hello**", {
      cfg,
      token: "tok",
      promptContextProjectionPlan: { cursor, finalPart: true },
    });

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const node = await cache.get({ accountId: "default", chatId: "123", messageId: "156" });
    expect(botApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(node?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: { ...cursor.source, partIndex: 0, finalPart: true },
    });
    expect(cursor.nextPartIndex).toBe(1);
  });

  it("preserves markdown link targets when Telegram rejects HTML", async () => {
    botApi.sendMessage
      .mockRejectedValueOnce(createHtmlParseError())
      .mockResolvedValueOnce({ message_id: 157, chat: { id: "123" } });

    await sendMessageTelegram("123", "Read [docs](https://example.com/guide)", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage).toHaveBeenNthCalledWith(
      1,
      "123",
      'Read <a href="https://example.com/guide">docs</a>',
      { parse_mode: "HTML" },
    );
    expect(botApi.sendMessage).toHaveBeenNthCalledWith(
      2,
      "123",
      "Read docs (https://example.com/guide)",
    );
  });

  it("continues after a rejected middle chunk and reports incomplete delivery", async () => {
    const storePath = `/tmp/openclaw-telegram-projection-partial-${process.pid}-${Date.now()}.json`;
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-partial",
    });
    botApi.sendMessage
      .mockResolvedValueOnce({ message_id: 54, chat: { id: "123" } })
      .mockRejectedValueOnce(createChunkRejection())
      .mockResolvedValueOnce({ message_id: 56, chat: { id: "123" } });
    const onDeliveryResult = vi.fn();
    const html = "A".repeat(9000);

    let observed: unknown;
    try {
      await sendMessageTelegram("123", html, {
        cfg: { session: { store: storePath } },
        token: "tok",
        textMode: "html",
        onDeliveryResult,
        promptContextProjectionPlan: { cursor, finalPart: true },
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(botApi.sendMessage).toHaveBeenCalledTimes(3);
    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual(["54", "56"]);
    expect(observed.deliveryResult.messageIds).toEqual(["54", "56"]);
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const cached = await Promise.all(
      [54, 56].map((messageId) =>
        cache.get({ accountId: "default", chatId: "123", messageId: String(messageId) }),
      ),
    );
    expect(cached.map((node) => node?.promptContextProjectionMarker)).toEqual([
      {
        kind: "valid",
        projection: { transcriptMessageId: "assistant-partial", partIndex: 0, finalPart: false },
      },
      {
        kind: "valid",
        projection: { transcriptMessageId: "assistant-partial", partIndex: 1, finalPart: false },
      },
    ]);
    expect(cursor.nextPartIndex).toBe(2);
    expect(cursor.complete).toBe(false);
  });

  it("finalizes the visible chunk when Telegram rejects an invisible tail", async () => {
    const storePath = `/tmp/openclaw-telegram-empty-tail-${process.pid}-${Date.now()}.json`;
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-empty-tail",
    });
    const onDeliveryResult = vi.fn();
    botApi.sendMessage
      .mockResolvedValueOnce({ message_id: 71, chat: { id: "123" } })
      .mockRejectedValueOnce(new Error("Bad Request: text must be non-empty"))
      .mockRejectedValueOnce(new Error("Bad Request: text must be non-empty"));
    botApi.editMessageReplyMarkup.mockResolvedValueOnce({ message_id: 71 });

    const result = await sendMessageTelegram("123", `${"A".repeat(4000)}\u200B\u200B`, {
      cfg: { session: { store: storePath } },
      token: "tok",
      textMode: "html",
      buttons: [[{ text: "OK", callback_data: "ok" }]],
      onDeliveryResult,
      promptContextProjectionPlan: { cursor, finalPart: true },
    });

    expect(botApi.sendMessage).toHaveBeenCalledTimes(3);
    expect(botApi.editMessageReplyMarkup).toHaveBeenCalledWith("123", 71, {
      reply_markup: { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] },
    });
    expect(result.messageId).toBe("71");
    expect(result.meta?.telegramHasInlineKeyboard).toBe(true);
    expect(onDeliveryResult).toHaveBeenCalledTimes(1);
    expect(onDeliveryResult.mock.calls[0]?.[0]?.meta?.telegramHasInlineKeyboard).toBe(false);
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({ accountId: "default", chatId: "123", messageId: "71" });
    expect(cached?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: { ...cursor.source, partIndex: 0, finalPart: true },
    });
  });

  it("reports partial delivery when the final keyboard retrofit fails", async () => {
    const storePath = `/tmp/openclaw-telegram-empty-tail-keyboard-failure-${process.pid}-${Date.now()}.json`;
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-empty-tail-keyboard-failure",
    });
    const emptyError = new Error("Bad Request: text must be non-empty");
    const retrofitError = new Error("keyboard retrofit failed");
    const onDeliveryResult = vi.fn();
    botApi.sendMessage
      .mockResolvedValueOnce({ message_id: 72, chat: { id: "123" } })
      .mockRejectedValueOnce(emptyError)
      .mockRejectedValueOnce(emptyError);
    botApi.editMessageReplyMarkup.mockRejectedValueOnce(retrofitError);

    let observed: unknown;
    try {
      await sendMessageTelegram("123", `${"A".repeat(4000)}\u200B\u200B`, {
        cfg: { session: { store: storePath } },
        token: "tok",
        textMode: "html",
        buttons: [[{ text: "OK", callback_data: "ok" }]],
        onDeliveryResult,
        promptContextProjectionPlan: { cursor, finalPart: true },
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult.messageIds).toEqual(["72"]);
    expect(botApi.editMessageReplyMarkup).toHaveBeenCalledWith("123", 72, {
      reply_markup: { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] },
    });
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult.mock.calls[0]?.[0]?.messageId).toBe("72");
    expect(onDeliveryResult.mock.calls[0]?.[0]?.meta?.telegramHasInlineKeyboard).toBe(false);
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({ accountId: "default", chatId: "123", messageId: "72" });
    expect(cached?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: { ...cursor.source, partIndex: 0, finalPart: true },
    });
  });

  it("fails when every Telegram chunk renders empty", async () => {
    const emptyError = new Error("Bad Request: text must be non-empty");
    botApi.sendMessage.mockRejectedValue(emptyError);

    await expect(
      sendMessageTelegram("123", "\u200B\u200B", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        textMode: "html",
      }),
    ).rejects.toBe(emptyError);

    expect(botApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("fails when every Telegram chunk is rejected", async () => {
    const rejection = createChunkRejection();
    botApi.sendMessage.mockRejectedValue(rejection);

    await expect(
      sendMessageTelegram("123", "A".repeat(9000), {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        textMode: "html",
      }),
    ).rejects.toBe(rejection);

    expect(botApi.sendMessage).toHaveBeenCalledTimes(3);
  });

  it("does not continue after accepted-send bookkeeping fails", async () => {
    botApi.sendMessage
      .mockResolvedValueOnce({ message_id: 54, chat: { id: "123" } })
      .mockResolvedValueOnce({ message_id: 55, chat: { id: "123" } });
    const onDeliveryResult = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("delivery observer failed"));

    let observed: unknown;
    try {
      await sendMessageTelegram("123", "A".repeat(9000), {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        textMode: "html",
        onDeliveryResult,
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult.messageIds).toEqual(["54", "55"]);
    expect(observed.deliveryResult.receipt?.platformMessageIds).toEqual(["54", "55"]);
    expect(botApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(onDeliveryResult).toHaveBeenCalledTimes(2);
  });

  it("chunks long inline markdown through the HTML text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 52, chat: { id: "123" } });
    const markdown = `**${"A".repeat(70_000)}**`;

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    const chunks = sendMessageTexts(botApi.sendMessage);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(chunks.join("")).toContain("A");
  });

  it("chunks long markdown paragraphs on the text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 53, chat: { id: "123" } });
    const markdown = Array.from({ length: 900 }, (_, index) => `Paragraph ${index + 1}`).join(
      "\n\n",
    );

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    const chunks = sendMessageTexts(botApi.sendMessage);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  });

  it("preserves word boundaries when rendered markdown exceeds the text limit", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 53, chat: { id: "123" } });
    const visibleText = Array.from({ length: 260 }, () => "alpha beta gamma").join(" ");
    const markdown = `**${visibleText}**`;

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    const chunks = sendMessageTexts(botApi.sendMessage);
    const visibleChunks = chunks.map((chunk) => telegramHtmlToPlainTextFallback(chunk));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(visibleChunks.join("")).toBe(visibleText);
    for (let index = 0; index < visibleChunks.length - 1; index += 1) {
      const left = visibleChunks[index] ?? "";
      const right = visibleChunks[index + 1] ?? "";
      expect(`${left.at(-1) ?? ""}${right.at(0) ?? ""}`).not.toMatch(/^[A-Za-z]{2}$/);
    }
  });

  it("chunks long markdown headings on the text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 54, chat: { id: "123" } });
    const markdown = Array.from({ length: 600 }, (_, index) => `# Heading ${index + 1}`).join("\n");

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    const chunks = sendMessageTexts(botApi.sendMessage);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toContain("Heading 600");
  });

  it("keeps long markdown lists on the text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 55, chat: { id: "123" } });
    const markdown = Array.from({ length: 600 }, (_, index) => `- Item ${index + 1}`).join("\n");

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(sendMessageTexts(botApi.sendMessage).join("")).toContain("Item 600");
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("keeps tall markdown tables on the text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 56, chat: { id: "123" } });
    const markdown = [
      "| Name | Value |",
      "| --- | --- |",
      ...Array.from({ length: 600 }, (_, index) => `| Row ${index + 1} | ${index + 1} |`),
    ].join("\n");

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(sendMessageTexts(botApi.sendMessage).join("")).toContain("Row 600");
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("does not split fenced blocks unnecessarily on the text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 57, chat: { id: "123" } });
    const markdown = `~~~txt\n${Array.from({ length: 900 }, (_, index) => `line ${index + 1}`).join(
      "\n\n",
    )}\n~~~`;

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(sendMessageTexts(botApi.sendMessage).join("")).toContain("line 900");
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("does not split fenced headings unnecessarily on the text path", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 58, chat: { id: "123" } });
    const markdown = `~~~md\n${Array.from(
      { length: 600 },
      (_, index) => `# Literal heading ${index + 1}`,
    ).join("\n")}\n~~~`;

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    expect(botApi.sendMessage.mock.calls.length).toBeGreaterThan(1);
    expect(sendMessageTexts(botApi.sendMessage).join("")).toContain("Literal heading 600");
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it("chunks long fenced markdown into bounded text chunks", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 59, chat: { id: "123" } });
    const markdown = `~~~ts\n${"const value = 1;\n".repeat(5000)}~~~`;

    await sendMessageTelegram("123", markdown, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
    });

    const chunks = sendMessageTexts(botApi.sendMessage);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true);
  });

  it("chunks explicit HTML above the Telegram text-message limit", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 60, chat: { id: "123" } });
    const html = `<b>${"A".repeat(70_000)}</b>`;

    await sendMessageTelegram("123", html, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      textMode: "html",
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });

    expect(botApi.sendMessage.mock.calls.length).toBeGreaterThan(1);
    const lastParams = botApi.sendMessage.mock.calls.at(-1)?.[2];
    expect(sendMessageTexts(botApi.sendMessage).every((chunk) => chunk.length <= 4000)).toBe(true);
    expect(requireRecord(lastParams, "last sendMessage params").reply_markup).toEqual({
      inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
    });
  });

  it("fails when Telegram text send returns no message_id", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram("123", "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow(/returned no message_id/i);
  });

  it("fails when Telegram media send returns no message_id", async () => {
    mockLoadedMedia({ contentType: "image/png", fileName: "photo.png" });
    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: "123" },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    await expect(
      sendMessageTelegram("123", "caption", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/photo.png",
      }),
    ).rejects.toThrow(/returned no message_id/i);
  });

  it("uses native fetch for BAN compatibility when api is omitted", async () => {
    const originalFetch = globalThis.fetch;
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    (globalThis as { Bun?: unknown }).Bun = {};
    botApi.sendMessage.mockResolvedValue({
      message_id: 1,
      chat: { id: "123" },
    });
    try {
      await sendMessageTelegram("123", "hi", { cfg: TELEGRAM_TEST_CFG, token: "tok" });
      const clientFetch = (
        firstMockCall(botCtorSpy, "bot constructor call")[1] as {
          client?: { fetch?: unknown };
        }
      )?.client?.fetch;
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

  it("normalizes chat ids with internal prefixes", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: "123" },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram("telegram:123", "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith("123", "hi", {
      parse_mode: "HTML",
    });
  });

  it("resolves t.me targets to numeric chat ids via getChat", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: "-100123" },
    });
    const getChat = vi.fn().mockResolvedValue({ id: -100123 });
    const api = { sendMessage, getChat } as unknown as {
      sendMessage: typeof sendMessage;
      getChat: typeof getChat;
    };

    await sendMessageTelegram("https://t.me/mychannel", "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      gatewayClientScopes: ["operator.write"],
    });

    expect(getChat).toHaveBeenCalledWith("@mychannel");
    expect(sendMessage).toHaveBeenCalledWith("-100123", "hi", {
      parse_mode: "HTML",
    });
    expectPersistedTarget({
      rawTarget: "https://t.me/mychannel",
      resolvedChatId: "-100123",
      gatewayClientScopes: ["operator.write"],
    });
  });

  it("preserves internal target writeback when gateway scopes are absent", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: "-100123" },
    });
    const getChat = vi.fn().mockResolvedValue({ id: -100123 });
    const api = { sendMessage, getChat } as unknown as {
      sendMessage: typeof sendMessage;
      getChat: typeof getChat;
    };

    await sendMessageTelegram("https://t.me/mychannel", "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(getChat).toHaveBeenCalledWith("@mychannel");
    expectPersistedTarget({
      rawTarget: "https://t.me/mychannel",
      resolvedChatId: "-100123",
      gatewayClientScopes: undefined,
      trustedInternalWriteback: true,
    });
  });

  it("fails clearly when a legacy target cannot be resolved", async () => {
    const getChat = vi.fn().mockRejectedValue(new Error("400: Bad Request: chat not found"));
    const api = { getChat } as unknown as {
      getChat: typeof getChat;
    };

    await expect(
      sendMessageTelegram("@missingchannel", "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow(/could not be resolved to a numeric chat ID/i);
  });

  it("includes thread params in media messages", async () => {
    const chatId = "-1001234567890";
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 58,
      message_thread_id: 99,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo in topic", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 99,
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: "photo in topic",
      parse_mode: "HTML",
      message_thread_id: 99,
    });
  });

  it("splits long captions into media + text messages when text exceeds 1024 chars", async () => {
    const chatId = "123";
    const longText = "A".repeat(1100);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 70,
      message_thread_id: 271,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 71,
      message_thread_id: 271,
      chat: { id: chatId },
    });
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, longText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: undefined,
    });
    expect(sendMessage).toHaveBeenCalledWith(chatId, longText, {
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("71");
    expect(res.receipt?.primaryPlatformMessageId).toBe("70");
    expect(res.receipt?.platformMessageIds).toEqual(["70", "71"]);
    expect(
      res.receipt?.parts.map(({ platformMessageId, kind, index }) => ({
        platformMessageId,
        kind,
        index,
      })),
    ).toEqual([
      { platformMessageId: "70", kind: "media", index: 0 },
      { platformMessageId: "71", kind: "text", index: 1 },
    ]);
  });

  it("stops an oversized-caption follow-up when media lands in the wrong topic", async () => {
    const chatId = "-1001234567890";
    const longText = "A".repeat(1100);
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 70,
      message_thread_id: 272,
      chat: { id: chatId, type: "supergroup" },
    });
    const sendMessage = vi.fn();
    const onDeliveryResult = vi.fn();
    const api = { sendPhoto, sendMessage } as unknown as TelegramApiOverride;
    mockLoadedMedia({ contentType: "image/jpeg", fileName: "photo.jpg" });

    let observed: unknown;
    try {
      await sendMessageTelegram(chatId, longText, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/photo.jpg",
        messageThreadId: 271,
        onDeliveryResult,
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: undefined,
      message_thread_id: 271,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(observed.deliveryResult.messageIds).toEqual(["70"]);
    expect(observed.deliveryResult.receipt).toMatchObject({
      primaryPlatformMessageId: "70",
      platformMessageIds: ["70"],
      threadId: "272",
      parts: [expect.objectContaining({ platformMessageId: "70", kind: "media" })],
    });
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult.mock.calls[0]?.[0]?.receipt?.threadId).toBe("272");
  });

  it("sends oversized voice captions as a voice note followed by text", async () => {
    const chatId = "123";
    const longText = "A".repeat(1100);
    botApi.sendVoice.mockResolvedValue({ message_id: 70, chat: { id: chatId } });
    botApi.sendMessage.mockResolvedValue({ message_id: 71, chat: { id: chatId } });
    mockLoadedMedia({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "voice.ogg",
    });

    const result = await sendMessageTelegram(chatId, longText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      mediaUrl: "https://example.com/voice.ogg",
      asVoice: true,
    });

    expectMediaSendCall(
      firstMockCall(botApi.sendVoice, "send voice call"),
      "send voice call",
      chatId,
      { caption: undefined },
    );
    expect(botApi.sendMessage).toHaveBeenCalledWith(chatId, longText, { parse_mode: "HTML" });
    expect(result.receipt?.platformMessageIds).toEqual(["70", "71"]);
  });

  it("finalizes media when its separate text renders empty", async () => {
    const storePath = `/tmp/openclaw-telegram-empty-media-follow-up-${process.pid}-${Date.now()}.json`;
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-empty-media-follow-up",
    });
    const emptyError = new Error("Bad Request: text must be non-empty");
    const onDeliveryResult = vi.fn();
    botApi.sendPhoto.mockResolvedValueOnce({ message_id: 70, chat: { id: "123" } });
    botApi.sendMessage.mockRejectedValue(emptyError);
    botApi.editMessageReplyMarkup.mockResolvedValueOnce({ message_id: 70 });
    mockLoadedMedia({ contentType: "image/jpeg", fileName: "photo.jpg" });

    const result = await sendMessageTelegram("123", "\u200B".repeat(1025), {
      cfg: { session: { store: storePath } },
      token: "tok",
      textMode: "html",
      mediaUrl: "https://example.com/photo.jpg",
      buttons: [[{ text: "OK", callback_data: "ok" }]],
      onDeliveryResult,
      promptContextProjectionPlan: { cursor, finalPart: true },
    });

    expect(result).toEqual({
      messageId: "70",
      chatId: "123",
      meta: { telegramHasInlineKeyboard: true },
    });
    expect(botApi.sendMessage).toHaveBeenCalledTimes(2);
    expect(botApi.editMessageReplyMarkup).toHaveBeenCalledWith("123", 70, {
      reply_markup: { inline_keyboard: [[{ text: "OK", callback_data: "ok" }]] },
    });
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult.mock.calls[0]?.[0]?.meta?.telegramHasInlineKeyboard).toBe(false);
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({ accountId: "default", chatId: "123", messageId: "70" });
    expect(cached?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: { ...cursor.source, partIndex: 0, finalPart: true },
    });
  });

  it("reports delivered media before a caption follow-up fails", async () => {
    botApi.sendPhoto.mockResolvedValueOnce({ message_id: 70, chat: { id: "123" } });
    botApi.sendMessage.mockRejectedValueOnce(new Error("caption follow-up failed"));
    const onDeliveryResult = vi.fn();
    mockLoadedMedia({ contentType: "image/jpeg", fileName: "photo.jpg" });

    await expect(
      sendMessageTelegram("123", "A".repeat(1100), {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        mediaUrl: "https://example.com/photo.jpg",
        onDeliveryResult,
      }),
    ).rejects.toThrow("caption follow-up failed");

    expect(onDeliveryResult.mock.calls.map((call) => call[0]?.messageId)).toEqual(["70"]);
  });

  it("preserves explicit replies on a single media caption follow-up", async () => {
    botApi.sendPhoto.mockResolvedValueOnce({ message_id: 70, chat: { id: "123" } });
    botApi.sendMessage.mockResolvedValueOnce({ message_id: 71, chat: { id: "123" } });
    mockLoadedMedia({ contentType: "image/jpeg", fileName: "photo.jpg" });

    const result = await sendMessageTelegram("123", "A".repeat(1100), {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      mediaUrl: "https://example.com/photo.jpg",
      replyToMessageId: 500,
      replyToIdSource: "explicit",
      replyToMode: "all",
    });

    expect(botApi.sendMessage).toHaveBeenCalledWith("123", "A".repeat(1100), {
      parse_mode: "HTML",
      reply_to_message_id: 500,
      allow_sending_without_reply: true,
    });
    expect(result.receipt?.parts.map((part) => part.replyToId)).toEqual(["500", "500"]);
  });

  it("does not reuse first-mode reply-to on media caption follow-up text", async () => {
    const chatId = "-1001234567890";
    const longText = "A".repeat(1100);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 70,
      message_thread_id: 271,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 71,
      message_thread_id: 271,
      chat: { id: chatId },
    });
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const result = await sendMessageTelegram(chatId, longText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 271,
      replyToMessageId: 500,
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: undefined,
      message_thread_id: 271,
      reply_to_message_id: 500,
      allow_sending_without_reply: true,
    });
    expect(sendMessage).toHaveBeenCalledWith(chatId, longText, {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
    expect(result.receipt?.threadId).toBe("271");
    expect(result.receipt?.replyToId).toBe("500");
    expect(
      result.receipt?.parts.map(({ kind, index, threadId, replyToId }) => ({
        kind,
        index,
        threadId,
        replyToId,
      })),
    ).toEqual([
      { kind: "media", index: 0, threadId: "271", replyToId: "500" },
      { kind: "text", index: 1, threadId: "271", replyToId: undefined },
    ]);
  });

  it("chunks long default markdown media follow-up text", async () => {
    const chatId = "123";
    const longText = `**${"A".repeat(5000)}**`;
    const storePath = `/tmp/openclaw-telegram-projection-media-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-media",
    });

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 72,
      chat: { id: chatId },
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 73, chat: { id: chatId } })
      .mockResolvedValueOnce({ message_id: 74, chat: { id: chatId } })
      .mockResolvedValueOnce({ message_id: 75, chat: { id: chatId } });
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, longText, {
      cfg,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      promptContextProjectionPlan: { cursor, finalPart: true },
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: undefined,
    });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls.every((call) => call[2]?.parse_mode === "HTML")).toBe(true);
    expect(sendMessage.mock.calls.map((call) => String(call[1] ?? "")).join("")).toContain("A");
    expect(res.messageId).toBe("75");
    expect(res.receipt?.primaryPlatformMessageId).toBe("72");
    expect(res.receipt?.platformMessageIds).toEqual(["72", "73", "74", "75"]);
    expect(res.receipt?.parts.map((part) => part.kind)).toEqual(["media", "text", "text", "text"]);
    expect(res.receipt?.parts.map((part) => part.index)).toEqual([0, 1, 2, 3]);
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    const projections = await Promise.all(
      ["72", "73", "74", "75"].map(
        async (messageId) =>
          (await cache.get({ accountId: "default", chatId, messageId }))
            ?.promptContextProjectionMarker,
      ),
    );
    expect(projections).toEqual([
      {
        kind: "valid",
        projection: { ...cursor.source, partIndex: 0, finalPart: false },
      },
      {
        kind: "valid",
        projection: { ...cursor.source, partIndex: 1, finalPart: false },
      },
      {
        kind: "valid",
        projection: { ...cursor.source, partIndex: 2, finalPart: false },
      },
      { kind: "valid", projection: { ...cursor.source, partIndex: 3, finalPart: true } },
    ]);
    expect(cursor.nextPartIndex).toBe(4);
  });

  it("uses caption when text is within 1024 char limit", async () => {
    const chatId = "123";
    const shortText = "B".repeat(1024);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 72,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn();
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, shortText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: shortText,
      parse_mode: "HTML",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.messageId).toBe("72");
  });

  it("keeps formatted media captions within Telegram's parsed-character limit", async () => {
    const chatId = "123";
    const visibleCaption = "B".repeat(1022);
    const formattedCaption = `**${visibleCaption}**`;
    const sendPhoto = vi.fn().mockResolvedValue({ message_id: 72, chat: { id: chatId } });
    const sendMessage = vi.fn();
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, formattedCaption, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: `<b>${visibleCaption}</b>`,
      parse_mode: "HTML",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("renders markdown in media captions", async () => {
    const chatId = "123";
    const caption = "hi **boss**";

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 90,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, caption, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: "hi <b>boss</b>",
      parse_mode: "HTML",
    });
  });

  it.each([
    {
      kind: "ordinary Markdown",
      caption: "hi **boss**",
      htmlCaption: "hi <b>boss</b>",
      plainCaption: "hi **boss**",
    },
    {
      kind: "markup-heavy Markdown",
      caption: `**${"x".repeat(1022)}**`,
      htmlCaption: `<b>${"x".repeat(1022)}</b>`,
      plainCaption: "x".repeat(1022),
    },
  ])(
    "falls back to a valid $kind media caption when Telegram rejects HTML",
    async ({ caption, htmlCaption, plainCaption }) => {
      const chatId = "123";
      const sendPhoto = vi
        .fn()
        .mockRejectedValueOnce(createHtmlParseError("sendPhoto"))
        .mockResolvedValueOnce({
          message_id: 91,
          chat: { id: chatId },
        });
      const api = { sendPhoto } as unknown as {
        sendPhoto: typeof sendPhoto;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-image"),
        contentType: "image/jpeg",
        fileName: "photo.jpg",
      });

      const result = await sendMessageTelegram(chatId, caption, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/photo.jpg",
      });

      expectMediaSendCall(
        firstMockCall(sendPhoto, "first send photo call"),
        "send photo call",
        chatId,
        {
          caption: htmlCaption,
          parse_mode: "HTML",
        },
      );
      expectMediaSendCall(
        mockCall(sendPhoto, 1, "second send photo call"),
        "send photo retry call",
        chatId,
        {
          caption: plainCaption,
        },
      );
      expect(result).toEqual({ messageId: "91", chatId });
    },
  );

  it("sends video notes when requested and regular videos otherwise", async () => {
    const chatId = "123";

    {
      const text = "ignored caption context";
      const sendVideoNote = vi.fn().mockResolvedValue({
        message_id: 101,
        chat: { id: chatId },
      });
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: 102,
        chat: { id: chatId },
      });
      const api = { sendVideoNote, sendMessage } as unknown as {
        sendVideoNote: typeof sendVideoNote;
        sendMessage: typeof sendMessage;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const res = await sendMessageTelegram(chatId, text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/video.mp4",
        asVideoNote: true,
      });

      expectMediaSendCall(
        firstMockCall(sendVideoNote, "send video note call"),
        "send video note call",
        chatId,
        {},
      );
      expect(sendMessage).toHaveBeenCalledWith(chatId, text, {
        parse_mode: "HTML",
      });
      expect(res.messageId).toBe("102");
    }

    {
      const text = "my caption";
      const sendVideo = vi.fn().mockResolvedValue({
        message_id: 201,
        chat: { id: chatId },
      });
      const api = { sendVideo } as unknown as {
        sendVideo: typeof sendVideo;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const res = await sendMessageTelegram(chatId, text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/video.mp4",
        asVideoNote: false,
      });

      const [actualChatId, media, videoParams] = firstMockCall(sendVideo, "send video call");
      expect(actualChatId).toBe(chatId);
      if (media === undefined) {
        throw new Error("expected send video media");
      }
      const params = requireRecord(videoParams, "send video params");
      expect(typeof params.caption).toBe("string");
      expect(params.parse_mode).toBe("HTML");
      expect(Object.keys(params).toSorted()).toEqual(["caption", "parse_mode"]);
      expect(res.messageId).toBe("201");
    }
  });

  it.each([
    {
      name: "non-video media",
      contentType: "image/png",
      fileName: "photo.png",
      forceDocument: false,
    },
    {
      name: "forced documents",
      contentType: "video/mp4",
      fileName: "video.mp4",
      forceDocument: true,
    },
  ])("rejects video notes backed by $name", async (testCase) => {
    mockLoadedMedia({
      buffer: Buffer.from("fake-media"),
      contentType: testCase.contentType,
      fileName: testCase.fileName,
    });

    await expect(
      sendMessageTelegram("123", "", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api: {},
        mediaUrl: `https://example.com/${testCase.fileName}`,
        asVideoNote: true,
        forceDocument: testCase.forceDocument,
      }),
    ).rejects.toThrow("Telegram video notes require video media.");
  });

  it("sends native locations and venues with bounded accuracy", async () => {
    const chatId = "123";
    const sendLocation = vi.fn().mockResolvedValue({ message_id: 301, chat: { id: chatId } });
    const sendVenue = vi.fn().mockResolvedValue({ message_id: 302, chat: { id: chatId } });
    const api = { sendLocation, sendVenue } as unknown as TelegramApiOverride;

    await sendLocationTelegram(
      chatId,
      { latitude: 48.858844, longitude: 2.294351, accuracy: 12 },
      {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        replyToMessageId: 77,
        quoteText: "quoted location",
      },
    );
    await sendLocationTelegram(
      chatId,
      {
        latitude: 48.858844,
        longitude: 2.294351,
        name: "Eiffel Tower",
        address: "Champ de Mars",
      },
      { cfg: TELEGRAM_TEST_CFG, token: "tok", api },
    );

    expect(sendLocation).toHaveBeenCalledWith(
      chatId,
      48.858844,
      2.294351,
      expect.objectContaining({
        horizontal_accuracy: 12,
        reply_parameters: expect.objectContaining({
          message_id: 77,
          quote: "quoted location",
        }),
      }),
    );
    expect(sendVenue).toHaveBeenCalledWith(
      chatId,
      48.858844,
      2.294351,
      "Eiffel Tower",
      "Champ de Mars",
      expect.any(Object),
    );
    expect(wasSentByBot(chatId, 301)).toBe(true);
    expect(wasSentByBot(chatId, 302)).toBe(true);
  });

  it.each([
    {
      name: "location",
      location: { latitude: 48.858844, longitude: 2.294351 },
    },
    {
      name: "venue",
      location: {
        latitude: 48.858844,
        longitude: 2.294351,
        name: "Eiffel Tower",
        address: "Champ de Mars",
      },
    },
  ])("rejects a provider topic mismatch for a native $name", async ({ location }) => {
    const chatId = "-1001234567890";
    const providerResult = {
      message_id: 303,
      message_thread_id: 100,
      chat: { id: chatId, type: "supergroup" },
    };
    const sendLocation = vi.fn().mockResolvedValue(providerResult);
    const sendVenue = vi.fn().mockResolvedValue(providerResult);

    let observed: unknown;
    try {
      await sendLocationTelegram(`${chatId}:topic:99`, location, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api: { sendLocation, sendVenue } as unknown as TelegramApiOverride,
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult.messageIds).toEqual(["303"]);
    expect(observed.deliveryResult.receipt?.threadId).toBe("100");
    expect(observed).toHaveProperty("message", expect.stringContaining("expected topic 99"));
  });

  it("rejects incomplete Telegram venues", async () => {
    await expect(
      sendLocationTelegram(
        "123",
        { latitude: 1, longitude: 2, name: "Unnamed address" },
        { cfg: TELEGRAM_TEST_CFG, token: "tok", api: {} },
      ),
    ).rejects.toThrow(/require both/i);
  });

  it("passes probed dimensions to regular video sends", async () => {
    const chatId = "123";
    const videoBuffer = Buffer.from("fake-video");
    const sendVideo = vi.fn().mockResolvedValue({
      message_id: 201,
      chat: { id: chatId },
    });
    const api = { sendVideo } as unknown as {
      sendVideo: typeof sendVideo;
    };
    probeVideoDimensions.mockResolvedValueOnce({ width: 720, height: 1280 });

    mockLoadedMedia({
      buffer: videoBuffer,
      contentType: "video/mp4",
      fileName: "video.mp4",
    });

    await sendMessageTelegram(chatId, "my caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/video.mp4",
    });

    expect(probeVideoDimensions).toHaveBeenCalledWith(videoBuffer);
    expectMediaSendCall(firstMockCall(sendVideo, "send video call"), "send video call", chatId, {
      caption: "my caption",
      parse_mode: "HTML",
      width: 720,
      height: 1280,
    });
  });

  it("does not probe video dimensions for video notes", async () => {
    const chatId = "123";
    const sendVideoNote = vi.fn().mockResolvedValue({
      message_id: 101,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 102,
      chat: { id: chatId },
    });
    const api = { sendVideoNote, sendMessage } as unknown as {
      sendVideoNote: typeof sendVideoNote;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-video"),
      contentType: "video/mp4",
      fileName: "video.mp4",
    });

    await sendMessageTelegram(chatId, "ignored caption context", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/video.mp4",
      asVideoNote: true,
    });

    expect(probeVideoDimensions).not.toHaveBeenCalled();
    expectMediaSendCall(
      firstMockCall(sendVideoNote, "send video note call"),
      "send video note call",
      chatId,
      {},
    );
  });

  it("applies reply markup and thread options to split video-note sends", async () => {
    const chatId = "123";
    const cases: Array<{
      text: string;
      options: Partial<NonNullable<Parameters<typeof sendMessageTelegram>[2]>>;
      expectedVideoNote: Record<string, unknown>;
      expectedMessage: Record<string, unknown>;
    }> = [
      {
        text: "Check this out",
        options: {
          buttons: [[{ text: "Btn", callback_data: "dat" }]],
        },
        expectedVideoNote: {},
        expectedMessage: {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "Btn", callback_data: "dat" }]],
          },
        },
      },
      {
        text: "Threaded reply",
        options: {
          replyToMessageId: 999,
        },
        expectedVideoNote: { reply_to_message_id: 999, allow_sending_without_reply: true },
        expectedMessage: {
          parse_mode: "HTML",
          reply_parameters: {
            message_id: 999,
            allow_sending_without_reply: true,
          },
        },
      },
    ];

    for (const testCase of cases) {
      const sendVideoNote = vi.fn().mockResolvedValue({
        message_id: 301,
        chat: { id: chatId },
      });
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: 302,
        chat: { id: chatId },
      });
      const api = { sendVideoNote, sendMessage } as unknown as {
        sendVideoNote: typeof sendVideoNote;
        sendMessage: typeof sendMessage;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const sendOptions: NonNullable<Parameters<typeof sendMessageTelegram>[2]> = {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/video.mp4",
        asVideoNote: true,
      };
      if (
        "replyToMessageId" in testCase.options &&
        testCase.options.replyToMessageId !== undefined
      ) {
        sendOptions.replyToMessageId = testCase.options.replyToMessageId;
      }
      if ("buttons" in testCase.options && testCase.options.buttons) {
        sendOptions.buttons = testCase.options.buttons;
      }
      await sendMessageTelegram(chatId, testCase.text, sendOptions);

      expectMediaSendCall(
        firstMockCall(sendVideoNote, "send video note call"),
        "send video note call",
        chatId,
        testCase.expectedVideoNote,
      );
      expect(sendMessage).toHaveBeenCalledWith(chatId, testCase.text, {
        ...testCase.expectedMessage,
        ...(testCase.expectedMessage?.reply_parameters
          ? {
              reply_to_message_id: 999,
              allow_sending_without_reply: true,
              reply_parameters: undefined,
            }
          : {}),
      });
    }
  });

  it("retries pre-connect send errors and honors retry_after when present", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), {
      code: "ENOTFOUND",
      parameters: { retry_after: 0.5 },
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        message_id: 1,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = sendMessageTelegram(chatId, "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ messageId: "1", chatId });
    expect(firstMockCall(setTimeoutSpy, "setTimeout call")[1]).toBe(500);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("honors long Telegram retry_after hints above the default send retry cap", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce({
        message: "429 Too Many Requests",
        response: { parameters: { retry_after: 45 } },
      })
      .mockResolvedValueOnce({
        message_id: 2,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = sendMessageTelegram(chatId, "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 30_000, jitter: 0 },
    });

    await vi.advanceTimersByTimeAsync(44_999);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ messageId: "2", chatId });
    expect(firstMockCall(setTimeoutSpy, "setTimeout call")[1]).toBe(45_000);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("retries wrapped Undici connect timeout sends", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const root = Object.assign(new Error("Connect Timeout Error"), {
      name: "ConnectTimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause: root });
    const err = Object.assign(new Error("Network request for 'sendMessage' failed!"), {
      name: "HttpError",
      error: fetchError,
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        message_id: 1,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const promise = sendMessageTelegram(chatId, "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ messageId: "1", chatId });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("maps an exhausted request-not-started marker to durable no-dispatch custody", async () => {
    const chatId = "123";
    const terminal = Object.assign(new Error("Network request for 'sendMessage' failed!"), {
      name: "HttpError",
      error: new TelegramRequestNotStartedError(),
    });
    const sendMessage = vi.fn().mockRejectedValue(terminal);
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    let observed: unknown;
    try {
      await sendMessageTelegram(chatId, "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(PlatformMessageNotDispatchedError);
    expect(observed).toHaveProperty("cause", terminal);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps broad 421-shaped durable send errors ambiguous", async () => {
    const chatId = "123";
    const edgeError = Object.assign(new Error("421 Misdirected Request"), { status: 421 });
    const sendMessage = vi.fn().mockRejectedValue(edgeError);
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    await expect(
      sendMessageTelegram(chatId, "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toBe(edgeError);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not retry on non-transient errors", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockRejectedValue(new Error("400: Bad Request"));
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/Bad Request/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not retry generic grammY failed-after envelopes for non-idempotent sends", async () => {
    const chatId = "123";
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Network request for 'sendMessage' failed after 1 attempts."),
      );
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/failed after 1 attempts/i);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends GIF media as animation", async () => {
    const chatId = "123";
    const sendAnimation = vi.fn().mockResolvedValue({
      message_id: 9,
      chat: { id: chatId },
    });
    const api = { sendAnimation } as unknown as {
      sendAnimation: typeof sendAnimation;
    };

    mockLoadedMedia({
      buffer: Buffer.from("GIF89a"),
      fileName: "fun.gif",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/fun",
    });

    expect(sendAnimation).toHaveBeenCalledTimes(1);
    expectMediaSendCall(
      firstMockCall(sendAnimation, "send animation call"),
      "send animation call",
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
      },
    );
    expect(probeVideoDimensions).not.toHaveBeenCalled();
    expect(res.messageId).toBe("9");
  });

  it.each([
    { contentType: "image/png", filename: "image.png", method: "sendPhoto" },
    { contentType: "video/quicktime", filename: "video.mov", method: "sendVideo" },
    { contentType: "audio/mpeg", filename: "audio.mp3", method: "sendAudio" },
    { contentType: "application/pdf", filename: "file.pdf", method: "sendDocument" },
    { contentType: "image/gif", filename: "animation.gif", method: "sendAnimation" },
    { contentType: "application/x-custom", filename: "file.bin", method: "sendDocument" },
  ])("preserves MIME-derived filenames for durable $contentType", async (testCase) => {
    const sendMedia = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: "123" },
    });
    const api = { [testCase.method]: sendMedia } as TelegramApiOverride;
    mockLoadedMedia({ contentType: testCase.contentType });

    await sendMessageTelegram("123", "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/media",
    });

    expect(firstMockCall(sendMedia, testCase.method)[1]).toMatchObject({
      filename: testCase.filename,
    });
  });

  it.each(["PHOTO_INVALID_DIMENSIONS", "PHOTO_TOO_BIG"])(
    "falls back to a document when Telegram rejects a durable photo with %s",
    async (reason) => {
      const sendPhoto = vi.fn().mockRejectedValueOnce(new Error(`400: Bad Request: ${reason}`));
      const sendDocument = vi.fn().mockResolvedValue({
        message_id: 10,
        message_thread_id: 42,
        chat: { id: "123" },
      });
      mockLoadedMedia({ contentType: "image/png", fileName: "photo.png" });

      const result = await sendMessageTelegram("123", "caption", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api: { sendPhoto, sendDocument },
        mediaUrl: "https://example.com/photo.png",
        messageThreadId: 42,
        replyToMessageId: 512,
      });

      expect(sendPhoto).toHaveBeenCalledOnce();
      expectMediaSendCall(
        firstMockCall(sendDocument, "fallback document"),
        "fallback document",
        "123",
        {
          caption: "caption",
          parse_mode: "HTML",
          message_thread_id: 42,
          reply_to_message_id: 512,
          allow_sending_without_reply: true,
        },
      );
      expect(result.messageId).toBe("10");
    },
  );

  it("does not retry unrelated durable photo failures as documents", async () => {
    const sendPhoto = vi.fn().mockRejectedValueOnce(new Error("400: Bad Request: chat migrated"));
    const sendDocument = vi.fn();
    mockLoadedMedia({ contentType: "image/png", fileName: "photo.png" });

    await expect(
      sendMessageTelegram("123", "caption", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api: { sendPhoto, sendDocument },
        mediaUrl: "https://example.com/photo.png",
      }),
    ).rejects.toThrow("chat migrated");

    expect(sendDocument).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "preserves delivery context for voice privacy fallback with rich messages %s",
    async (richMessages) => {
      const chatId = "-1001234567890";
      const storePath = `/tmp/openclaw-telegram-voice-fallback-${process.pid}-${richMessages}.json`;
      const onDeliveryResult = vi.fn();
      const cursor = createTelegramPromptContextProjectionCursor({
        transcriptMessageId: "assistant-voice-fallback",
      });
      const buttons = [[{ text: "Open", callback_data: "open" }]];
      botApi.sendVoice.mockRejectedValueOnce({
        description: "Bad Request: VOICE_MESSAGES_FORBIDDEN",
      });
      const deliveredFallback = {
        message_id: 77,
        message_thread_id: 271,
        chat: { id: chatId },
      };
      botApi.sendMessage.mockResolvedValueOnce(deliveredFallback);
      botRawApi.sendRichMessage.mockResolvedValueOnce(deliveredFallback);
      mockLoadedMedia({
        buffer: Buffer.from("voice"),
        contentType: "audio/ogg",
        fileName: "note.ogg",
      });

      const result = await sendMessageTelegram(chatId, "Hello **there**", {
        cfg: {
          channels: { telegram: { richMessages } },
          session: { store: storePath },
        },
        token: "tok",
        mediaUrl: "https://example.com/note.ogg",
        asVoice: true,
        messageThreadId: 271,
        replyToMessageId: 500,
        buttons,
        silent: true,
        onDeliveryResult,
        promptContextProjectionPlan: { cursor, finalPart: true },
      });

      expect(botApi.sendVoice).toHaveBeenCalledOnce();
      const fallback = richMessages ? botRawApi.sendRichMessage : botApi.sendMessage;
      const unusedFallback = richMessages ? botApi.sendMessage : botRawApi.sendRichMessage;
      expect(fallback).toHaveBeenCalledOnce();
      expect(unusedFallback).not.toHaveBeenCalled();
      const fallbackOptions = richMessages
        ? botRawApi.sendRichMessage.mock.calls[0]?.[0]
        : botApi.sendMessage.mock.calls[0]?.[2];
      expect(fallbackOptions).toEqual(
        expect.objectContaining({
          message_thread_id: 271,
          disable_notification: true,
          ...(richMessages
            ? { reply_parameters: { message_id: 500, allow_sending_without_reply: true } }
            : { reply_to_message_id: 500, allow_sending_without_reply: true }),
          reply_markup: { inline_keyboard: buttons },
        }),
      );
      expect(onDeliveryResult).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: "77",
          chatId,
          meta: { telegramDeliveredText: "Hello there", telegramHasInlineKeyboard: true },
          receipt: expect.objectContaining({
            primaryPlatformMessageId: "77",
            platformMessageIds: ["77"],
            threadId: "271",
          }),
        }),
      );
      const cached = await createTelegramMessageCache({
        scope: resolveTelegramMessageCacheScope(storePath),
      }).get({ accountId: "default", chatId, messageId: "77" });
      expect(cached?.promptContextProjectionMarker).toEqual({
        kind: "valid",
        projection: { ...cursor.source, partIndex: 0, finalPart: true },
      });
      expect(result).toMatchObject({
        messageId: "77",
        chatId,
        receipt: { primaryPlatformMessageId: "77", platformMessageIds: ["77"], threadId: "271" },
      });
    },
  );

  it.each([
    { name: "without visible text", text: "   ", reason: "VOICE_MESSAGES_FORBIDDEN" },
    { name: "for unrelated errors", text: "Visible", reason: "VOICE_MESSAGE_INVALID" },
  ])("rethrows voice failure $name", async ({ text, reason }) => {
    const voiceError = new Error(`Bad Request: ${reason}`);
    botApi.sendVoice.mockRejectedValueOnce(voiceError);
    mockLoadedMedia({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    await expect(
      sendMessageTelegram("123", text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        mediaUrl: "https://example.com/note.ogg",
        asVoice: true,
      }),
    ).rejects.toBe(voiceError);
    expect(botApi.sendMessage).not.toHaveBeenCalled();
    expect(botRawApi.sendRichMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "images",
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      fileName: "photo.png",
      mediaUrl: "https://example.com/photo.png",
    },
    {
      name: "GIFs",
      buffer: Buffer.from("GIF89a"),
      contentType: "image/gif",
      fileName: "fun.gif",
      mediaUrl: "https://example.com/fun.gif",
    },
    {
      name: "videos",
      buffer: Buffer.from("fake-video"),
      contentType: "video/mp4",
      fileName: "clip.mp4",
      mediaUrl: "https://example.com/clip.mp4",
    },
  ])("sends $name as documents when forceDocument is true", async (testCase) => {
    const chatId = "123";
    const sendAnimation = vi.fn();
    const sendDocument = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: chatId },
    });
    const sendPhoto = vi.fn();
    const sendVideo = vi.fn();
    const api = { sendAnimation, sendDocument, sendPhoto, sendVideo } as unknown as {
      sendAnimation: typeof sendAnimation;
      sendDocument: typeof sendDocument;
      sendPhoto: typeof sendPhoto;
      sendVideo: typeof sendVideo;
    };

    mockLoadedMedia({
      buffer: testCase.buffer,
      contentType: testCase.contentType,
      fileName: testCase.fileName,
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: testCase.mediaUrl,
      forceDocument: true,
    });

    expectMediaSendCall(
      firstMockCall(sendDocument, "send document call"),
      `send document call ${testCase.name}`,
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
        disable_content_type_detection: true,
      },
    );
    expect(sendPhoto, testCase.name).not.toHaveBeenCalled();
    expect(sendAnimation, testCase.name).not.toHaveBeenCalled();
    expect(sendVideo, testCase.name).not.toHaveBeenCalled();
    expect(probeVideoDimensions, testCase.name).not.toHaveBeenCalled();
    expect(res.messageId).toBe("10");
  });

  it.each([
    { name: "oversized dimensions", width: 6000, height: 5001 },
    { name: "oversized aspect ratio", width: 4000, height: 100 },
  ])("sends images as documents when Telegram rejects $name", async ({ width, height }) => {
    const chatId = "123";
    const sendDocument = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: chatId },
    });
    const sendPhoto = vi.fn();
    const api = { sendDocument, sendPhoto } as unknown as {
      sendDocument: typeof sendDocument;
      sendPhoto: typeof sendPhoto;
    };

    imageMetadata.width = width;
    imageMetadata.height = height;
    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      fileName: "photo.png",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.png",
    });

    expectMediaSendCall(
      firstMockCall(sendDocument, "send document call"),
      "send document call",
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
      },
    );
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(res.messageId).toBe("10");
  });

  it("sends images as documents when metadata dimensions are unavailable", async () => {
    const chatId = "123";
    const sendDocument = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: chatId },
    });
    const sendPhoto = vi.fn();
    const api = { sendDocument, sendPhoto } as unknown as {
      sendDocument: typeof sendDocument;
      sendPhoto: typeof sendPhoto;
    };

    imageMetadata.width = undefined;
    imageMetadata.height = undefined;
    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      fileName: "photo.png",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.png",
    });

    expectMediaSendCall(
      firstMockCall(sendDocument, "send document call"),
      "send document call",
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
      },
    );
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(res.messageId).toBe("10");
  });

  it("keeps regular document sends on the default Telegram params", async () => {
    const chatId = "123";
    const sendDocument = vi.fn().mockResolvedValue({
      message_id: 11,
      chat: { id: chatId },
    });
    const api = { sendDocument } as unknown as {
      sendDocument: typeof sendDocument;
    };

    mockLoadedMedia({
      buffer: Buffer.from("%PDF-1.7"),
      contentType: "application/pdf",
      fileName: "report.pdf",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/report.pdf",
    });

    expectMediaSendCall(
      firstMockCall(sendDocument, "send document call"),
      "send document call",
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
      },
    );
    expect(res.messageId).toBe("11");
  });

  it("routes audio media to sendAudio/sendVoice based on voice compatibility", async () => {
    const cases: Array<{
      name: string;
      chatId: string;
      text: string;
      mediaUrl: string;
      contentType: string;
      fileName: string;
      asVoice?: boolean;
      messageThreadId?: number;
      replyToMessageId?: number;
      expectedMethod: "sendAudio" | "sendVoice";
      expectedOptions: Record<string, unknown>;
    }> = [
      {
        name: "default audio send",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/clip.mp3",
        contentType: "audio/mpeg",
        fileName: "clip.mp3",
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
      {
        name: "voice-compatible media with thread params",
        chatId: "-1001234567890",
        text: "voice note",
        mediaUrl: "https://example.com/note.ogg",
        contentType: "audio/ogg",
        fileName: "note.ogg",
        asVoice: true,
        messageThreadId: 271,
        replyToMessageId: 500,
        expectedMethod: "sendVoice" as const,
        expectedOptions: {
          caption: "voice note",
          parse_mode: "HTML",
          message_thread_id: 271,
          reply_to_message_id: 500,
          allow_sending_without_reply: true,
        },
      },
      {
        name: "asVoice fallback for non-voice media",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/clip.wav",
        contentType: "audio/wav",
        fileName: "clip.wav",
        asVoice: true,
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
      {
        name: "asVoice accepts mp3",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/clip.mp3",
        contentType: "audio/mpeg",
        fileName: "clip.mp3",
        asVoice: true,
        expectedMethod: "sendVoice" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
      {
        name: "normalizes parameterized audio MIME with mixed casing",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/note",
        contentType: " Audio/Ogg; codecs=opus ",
        fileName: "note.ogg",
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
    ];

    for (const testCase of cases) {
      const sendAudio = vi.fn().mockResolvedValue({
        message_id: 10,
        ...("messageThreadId" in testCase && testCase.messageThreadId !== undefined
          ? { message_thread_id: testCase.messageThreadId }
          : {}),
        chat: { id: testCase.chatId },
      });
      const sendVoice = vi.fn().mockResolvedValue({
        message_id: 11,
        ...("messageThreadId" in testCase && testCase.messageThreadId !== undefined
          ? { message_thread_id: testCase.messageThreadId }
          : {}),
        chat: { id: testCase.chatId },
      });
      const api = { sendAudio, sendVoice } as unknown as {
        sendAudio: typeof sendAudio;
        sendVoice: typeof sendVoice;
      };

      mockLoadedMedia({
        buffer: Buffer.from("audio"),
        contentType: testCase.contentType,
        fileName: testCase.fileName,
      });

      await sendMessageTelegram(testCase.chatId, testCase.text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: testCase.mediaUrl,
        ...("asVoice" in testCase && testCase.asVoice ? { asVoice: true } : {}),
        ...("messageThreadId" in testCase && testCase.messageThreadId !== undefined
          ? { messageThreadId: testCase.messageThreadId }
          : {}),
        ...("replyToMessageId" in testCase && testCase.replyToMessageId !== undefined
          ? { replyToMessageId: testCase.replyToMessageId }
          : {}),
      });

      const called = testCase.expectedMethod === "sendVoice" ? sendVoice : sendAudio;
      const notCalled = testCase.expectedMethod === "sendVoice" ? sendAudio : sendVoice;
      expectMediaSendCall(
        firstMockCall(called, "called mock call"),
        `${testCase.expectedMethod} call ${testCase.name}`,
        testCase.chatId,
        testCase.expectedOptions,
      );
      expect(notCalled, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("keeps message_thread_id for forum/private/group sends", async () => {
    const cases = [
      {
        name: "forum topic",
        chatId: "-1001234567890",
        text: "hello forum",
        messageId: 55,
      },
      {
        name: "private chat topic (#18974)",
        chatId: "123456789",
        text: "hello private",
        messageId: 56,
      },
      {
        // Group/supergroup chats have negative IDs.
        name: "group chat (#17242)",
        chatId: "-1001234567890",
        text: "hello group",
        messageId: 57,
      },
    ] as const;

    for (const testCase of cases) {
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: testCase.messageId,
        message_thread_id: 271,
        chat: { id: testCase.chatId },
      });
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      const result = await sendMessageTelegram(testCase.chatId, testCase.text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        messageThreadId: 271,
      });

      expect(sendMessage, testCase.name).toHaveBeenCalledWith(testCase.chatId, testCase.text, {
        parse_mode: "HTML",
        message_thread_id: 271,
      });
      expect(result.receipt?.threadId, testCase.name).toBe("271");
    }
  });

  it("records the accepted message before rejecting a mismatched topic", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 55,
      message_thread_id: 272,
      chat: { id: chatId, type: "supergroup" },
    });
    const onDeliveryResult = vi.fn();

    let observed: unknown;
    try {
      await sendMessageTelegram(chatId, "hello forum", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api: { sendMessage } as unknown as TelegramApiOverride,
        messageThreadId: 271,
        onDeliveryResult,
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(observed.deliveryResult.messageIds).toEqual(["55"]);
    expect(observed.deliveryResult.receipt?.threadId).toBe("272");
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "55",
        receipt: expect.objectContaining({ threadId: "272" }),
      }),
    );
  });

  it("stops multipart text after the first provider topic mismatch", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 55,
      message_thread_id: 272,
      chat: { id: chatId, type: "supergroup" },
    });
    const onDeliveryResult = vi.fn();

    let observed: unknown;
    try {
      await sendMessageTelegram(chatId, "A".repeat(9000), {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api: { sendMessage } as unknown as TelegramApiOverride,
        textMode: "html",
        messageThreadId: 271,
        buttons: [[{ text: "OK", callback_data: "ok" }]],
        onDeliveryResult,
      });
    } catch (error) {
      observed = error;
    }

    expect(isChannelPartialDeliveryError(observed)).toBe(true);
    if (!isChannelPartialDeliveryError(observed)) {
      throw observed;
    }
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(observed.deliveryResult.messageIds).toEqual(["55"]);
    expect(observed.deliveryResult.receipt?.threadId).toBe("272");
    expect(onDeliveryResult).toHaveBeenCalledOnce();
  });

  it("does not infer a missing private-chat topic as the General forum topic", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 56,
      chat: { id: "123456789", type: "private" },
    });

    await expect(
      sendMessageTelegram("123456789", "hello private topic", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api: { sendMessage } as unknown as TelegramApiOverride,
        messageThreadId: 1,
      }),
    ).rejects.toThrow("topic unknown; expected topic 1");
  });

  it("returns a multipart receipt and avoids native replies for chunked first-mode text", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        message_id: 101,
        message_thread_id: 271,
        chat: { id: "-1001234567890" },
      })
      .mockResolvedValueOnce({
        message_id: 102,
        message_thread_id: 271,
        chat: { id: "-1001234567890" },
      })
      .mockResolvedValueOnce({
        message_id: 103,
        message_thread_id: 271,
        chat: { id: "-1001234567890" },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const result = await sendMessageTelegram("-1001234567890", `BEGIN ${"A".repeat(4100)} END`, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      messageThreadId: 271,
      replyToMessageId: 500,
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls.every((call) => call[2]?.parse_mode === "HTML")).toBe(true);
    expect(sendMessage.mock.calls.every((call) => call[2]?.message_thread_id === 271)).toBe(true);
    expect(result.messageId).toBe("103");
    expect(result.receipt?.primaryPlatformMessageId).toBe("101");
    expect(result.receipt?.platformMessageIds).toEqual(["101", "102", "103"]);
    expect(result.receipt?.threadId).toBe("271");
    expect(result.receipt?.replyToId).toBeUndefined();
    expect(
      result.receipt?.parts.map(({ platformMessageId, kind, index, threadId, replyToId }) => ({
        platformMessageId,
        kind,
        index,
        threadId,
        replyToId,
      })),
    ).toEqual([
      {
        platformMessageId: "101",
        kind: "text",
        index: 0,
        threadId: "271",
        replyToId: undefined,
      },
      {
        platformMessageId: "102",
        kind: "text",
        index: 1,
        threadId: "271",
        replyToId: undefined,
      },
      {
        platformMessageId: "103",
        kind: "text",
        index: 2,
        threadId: "271",
        replyToId: undefined,
      },
    ]);
  });

  it("keeps explicit native replies for chunked first-mode text", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 101, chat: { id: "-1001234567890" } })
      .mockResolvedValueOnce({ message_id: 102, chat: { id: "-1001234567890" } })
      .mockResolvedValueOnce({ message_id: 103, chat: { id: "-1001234567890" } });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram("-1001234567890", `BEGIN ${"A".repeat(4100)} END`, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      replyToMessageId: 500,
      replyToIdSource: "explicit",
      replyToMode: "first",
    });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    for (const call of sendMessage.mock.calls) {
      expect(call[2]).toMatchObject({
        reply_to_message_id: 500,
        allow_sending_without_reply: true,
      });
    }
  });

  it("fails topic sends instead of retrying without message_thread_id", async () => {
    const cases = [{ name: "forum", chatId: "-100123", text: "hello forum" }] as const;
    const threadErr = new Error("400: Bad Request: message thread not found");

    for (const testCase of cases) {
      const sendMessage = vi.fn().mockRejectedValueOnce(threadErr);
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      await expect(
        sendMessageTelegram(testCase.chatId, testCase.text, {
          cfg: TELEGRAM_TEST_CFG,
          token: "tok",
          api,
          messageThreadId: 271,
        }),
      ).rejects.toThrow("message thread not found");

      expect(sendMessage, testCase.name).toHaveBeenCalledTimes(1);
      expect(sendMessage, testCase.name).toHaveBeenCalledWith(testCase.chatId, testCase.text, {
        parse_mode: "HTML",
        message_thread_id: 271,
      });
    }
  });

  it("does not retry private DM topic sends without the topic id", async () => {
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendMessage = vi.fn().mockRejectedValueOnce(threadErr);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram("123456789", "hello private", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        messageThreadId: 271,
      }),
    ).rejects.toThrow("message thread not found");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("123456789", "hello private", {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
  });

  it("does not retry on non-retriable thread/chat errors", async () => {
    const cases: Array<{
      chatId: string;
      text: string;
      error: Error;
      opts?: { messageThreadId?: number };
      expectedError: RegExp | string;
      expectedCallArgs: [string, string, { parse_mode: "HTML"; message_thread_id?: number }];
    }> = [
      {
        chatId: "123",
        text: "hello forum",
        error: new Error("400: Bad Request: message thread not found"),
        expectedError: "message thread not found",
        expectedCallArgs: ["123", "hello forum", { parse_mode: "HTML" }],
      },
      {
        chatId: "123456789",
        text: "hello private",
        error: new Error("400: Bad Request: chat not found"),
        opts: { messageThreadId: 271 },
        expectedError: /chat not found/i,
        expectedCallArgs: [
          "123456789",
          "hello private",
          { parse_mode: "HTML", message_thread_id: 271 },
        ],
      },
    ];

    for (const testCase of cases) {
      const sendMessage = vi.fn().mockRejectedValueOnce(testCase.error);
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      await expect(
        sendMessageTelegram(testCase.chatId, testCase.text, {
          cfg: TELEGRAM_TEST_CFG,
          token: "tok",
          api,
          ...testCase.opts,
        }),
      ).rejects.toThrow(testCase.expectedError);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(...testCase.expectedCallArgs);
    }
  });

  it("sets disable_notification when silent is true", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      silent: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hi", {
      parse_mode: "HTML",
      disable_notification: true,
    });
  });

  it("parses message_thread_id from recipient string (telegram:group:...:topic:...)", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 55,
      message_thread_id: 271,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(`telegram:group:${chatId}:topic:271`, "hello forum", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hello forum", {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
  });

  it("logs successful outbound text delivery without the message body", async () => {
    const logFile = captureInfoLogs();
    const chatId = "-1001234567890";
    const body = "incident reply body should stay private";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 321,
      message_thread_id: 271,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(`telegram:group:${chatId}:topic:271`, body, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "ops",
      api,
      replyToMessageId: 123,
      silent: true,
    });

    const logs = await capturedLogText(logFile);
    expect(logs).toContain("outbound send ok");
    expect(logs).toContain("accountId=ops");
    expect(logs).toContain(`chatId=${chatId}`);
    expect(logs).toContain("messageId=321");
    expect(logs).toContain("operation=sendMessage");
    expect(logs).toContain("threadId=271");
    expect(logs).toContain("replyToMessageId=123");
    expect(logs).toContain("silent=true");
    expect(logs).toContain("chunkCount=1");
    expect(logs).not.toContain(body);
  });

  it("does not log outbound success when topic text send fails thread lookup", async () => {
    const logFile = captureInfoLogs();
    const chatId = "-1001234567890";
    const body = "topic reply body should stay private";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendMessage = vi.fn().mockRejectedValueOnce(threadErr);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(`telegram:group:${chatId}:topic:271`, body, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        accountId: "ops",
        api,
      }),
    ).rejects.toThrow("message thread not found");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(chatId, body, {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
    const logs = await capturedLogText(logFile);
    expect(logs).not.toContain("outbound send ok");
    expect(logs).not.toContain(body);
  });

  it("logs successful outbound media delivery without caption or media location", async () => {
    const logFile = captureInfoLogs();
    const chatId = "123";
    const caption = "private media caption";
    const mediaUrl = "https://example.com/private-photo.jpg";
    const fileName = "private-photo.jpg";
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 654,
      message_thread_id: 45,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName,
    });

    await sendMessageTelegram(chatId, caption, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "ops",
      api,
      mediaUrl,
      messageThreadId: 45,
    });

    const logs = await capturedLogText(logFile);
    expect(logs).toContain("outbound send ok");
    expect(logs).toContain("accountId=ops");
    expect(logs).toContain(`chatId=${chatId}`);
    expect(logs).toContain("messageId=654");
    expect(logs).toContain("operation=sendPhoto");
    expect(logs).toContain("deliveryKind=photo");
    expect(logs).toContain("threadId=45");
    expect(logs).not.toContain(caption);
    expect(logs).not.toContain(mediaUrl);
    expect(logs).not.toContain(fileName);
  });

  it("fails media sends instead of retrying without message_thread_id", async () => {
    const logFile = captureInfoLogs();
    const chatId = "-100123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendPhoto = vi.fn().mockRejectedValueOnce(threadErr);
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await expect(
      sendMessageTelegram(chatId, "photo", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/photo.jpg",
        messageThreadId: 271,
      }),
    ).rejects.toThrow("message thread not found");

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expectMediaSendCall(
      firstMockCall(sendPhoto, "first send photo call"),
      "first send photo call",
      chatId,
      {
        caption: "photo",
        parse_mode: "HTML",
        message_thread_id: 271,
      },
    );
    const logs = await capturedLogText(logFile);
    expect(logs).not.toContain("outbound send ok");
  });

  it("defaults outbound media uploads to 100MB", async () => {
    const chatId = "123";
    const mediaAccess = {
      localRoots: ["/tmp/agent-root"],
      workspaceDir: "/tmp/agent-root",
    };
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 60,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "chart.png",
      mediaAccess,
    });

    const [mediaUrl, options] = requireMockCall(
      firstMockCall(loadWebMedia, "loadWebMedia call"),
      "load web media call",
    );
    expect(mediaUrl).toBe("chart.png");
    const loadOptions = requireRecord(options, "load web media options");
    expect(loadOptions.maxBytes).toBe(100 * 1024 * 1024);
    expect(loadOptions.localRoots).toEqual(mediaAccess.localRoots);
    expect(loadOptions.workspaceDir).toBe(mediaAccess.workspaceDir);
  });

  it("uses configured telegram mediaMaxMb for outbound uploads", async () => {
    const chatId = "123";
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 61,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };
    const cfg = {
      channels: {
        telegram: {
          mediaMaxMb: 42,
        },
      },
    };
    loadConfig.mockReturnValue(cfg);

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo", {
      cfg,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    const [mediaUrl, options] = requireMockCall(
      firstMockCall(loadWebMedia, "loadWebMedia call"),
      "load web media call",
    );
    expect(mediaUrl).toBe("https://example.com/photo.jpg");
    expect(requireRecord(options, "load web media options").maxBytes).toBe(42 * 1024 * 1024);
  });

  it("sends long html-mode rich text with buttons", async () => {
    const chatId = "123";
    const htmlText = `<b>${"A".repeat(5000)}</b>`;

    const sendMessage = vi.fn().mockResolvedValue({ message_id: 91, chat: { id: chatId } });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, htmlText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      textMode: "html",
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    const lastCall = sendMessage.mock.calls.at(-1);
    const lastParams = requireRecord(lastCall?.[2], "last sendMessage params");
    expect(lastParams.reply_markup).toEqual({
      inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
    });
    expect(res.messageId).toBe("91");
  });

  it("sends long default markdown rich text with buttons", async () => {
    const chatId = "123";
    const markdownText = `**${"A".repeat(5000)}**`;

    const sendMessage = vi.fn().mockResolvedValue({ message_id: 91, chat: { id: chatId } });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, markdownText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });

    expect(sendMessage.mock.calls.length).toBeGreaterThan(1);
    const firstCall = firstMockCall(sendMessage, "first sendMessage call");
    const firstParams = requireRecord(firstCall[2], "first sendMessage params");
    const firstText = requireString(firstCall[1], "first sendMessage text");
    expect(firstParams.parse_mode).toBe("HTML");
    expect(firstText).toContain("A");
    const lastCall = sendMessage.mock.calls.at(-1);
    const lastParams = requireRecord(lastCall?.[2], "last sendMessage params");
    expect(lastParams.reply_markup).toEqual({
      inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
    });
    expect(res.messageId).toBe("91");
  });
});

describe("reactMessageTelegram", () => {
  it.each([
    {
      testName: "sends emoji reactions",
      target: "telegram:123",
      messageId: "456",
      emoji: "✅",
      remove: false,
      expected: [{ type: "emoji", emoji: "✅" }],
    },
    {
      testName: "removes reactions when emoji is empty",
      target: "123",
      messageId: 456,
      emoji: "",
      remove: false,
      expected: [],
    },
    {
      testName: "removes reactions when remove flag is set",
      target: "123",
      messageId: 456,
      emoji: "✅",
      remove: true,
      expected: [],
    },
  ] as const)("$testName", async (testCase) => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram(testCase.target, testCase.messageId, testCase.emoji, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      ...(testCase.remove ? { remove: true } : {}),
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, testCase.expected);
  });

  it("resolves legacy telegram targets before reacting", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const getChat = vi.fn().mockResolvedValue({ id: -100123 });
    const api = { setMessageReaction, getChat } as unknown as {
      setMessageReaction: typeof setMessageReaction;
      getChat: typeof getChat;
    };

    await reactMessageTelegram("@mychannel", 456, "✅", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(getChat).toHaveBeenCalledWith("@mychannel");
    expect(setMessageReaction).toHaveBeenCalledWith("-100123", 456, [
      { type: "emoji", emoji: "✅" },
    ]);
    expectPersistedTarget({
      rawTarget: "@mychannel",
      resolvedChatId: "-100123",
    });
  });
});

describe("deleteMessageTelegram", () => {
  it.each([
    "400: Bad Request: message to delete not found",
    "400: Bad Request: message can't be deleted",
    "MESSAGE_ID_INVALID",
    "MESSAGE_DELETE_FORBIDDEN",
  ] as const)("returns a warning for benign delete no-op error: %s", async (message) => {
    const deleteMessage = vi.fn().mockRejectedValue(new Error(message));
    const api = { deleteMessage } as unknown as { deleteMessage: typeof deleteMessage };

    const result = await deleteMessageTelegram("123", 456, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(deleteMessage).toHaveBeenCalledWith("123", 456);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected delete warning result");
    }
    expect(result.warning).toContain(message);
  });

  it("throws non-benign delete errors", async () => {
    const deleteMessage = vi.fn().mockRejectedValue(new Error("500: Internal Server Error"));
    const api = { deleteMessage } as unknown as { deleteMessage: typeof deleteMessage };

    await expect(
      deleteMessageTelegram("123", 456, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow(/Internal Server Error/);
  });

  it("rejects partial message id strings", async () => {
    const deleteMessage = vi.fn();
    const api = { deleteMessage } as unknown as { deleteMessage: typeof deleteMessage };

    await expect(
      deleteMessageTelegram("123", "456abc", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow(/Message id is required/);
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});

describe("sendStickerTelegram", () => {
  const positiveSendCases = [
    {
      name: "sends a sticker by file_id",
      fileId: "CAACAgIAAxkBAAI...sticker_file_id",
      expectedFileId: "CAACAgIAAxkBAAI...sticker_file_id",
      expectedMessageId: 100,
    },
    {
      name: "trims whitespace from fileId",
      fileId: "  fileId123  ",
      expectedFileId: "fileId123",
      expectedMessageId: 106,
    },
  ] as const;

  for (const testCase of positiveSendCases) {
    it(testCase.name, async () => {
      const chatId = "123";
      const sendSticker = vi.fn().mockResolvedValue({
        message_id: testCase.expectedMessageId,
        chat: { id: chatId },
      });
      const api = { sendSticker } as unknown as {
        sendSticker: typeof sendSticker;
      };

      const res = await sendStickerTelegram(chatId, testCase.fileId, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      });

      expect(sendSticker).toHaveBeenCalledWith(chatId, testCase.expectedFileId, undefined);
      expect(res.messageId).toBe(String(testCase.expectedMessageId));
      expect(res.chatId).toBe(chatId);
      expect(wasSentByBot(chatId, testCase.expectedMessageId)).toBe(true);
    });
  }

  it("records a successful topic sticker for later message mutations", async () => {
    const storePath = `/tmp/openclaw-telegram-sticker-context-${process.pid}-${Date.now()}.json`;
    const chatId = "-100123";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 107,
      chat: { id: chatId, type: "supergroup" },
      message_thread_id: 77,
      sticker: { file_id: "fileId123", file_unique_id: "unique", type: "regular" },
    });
    const api = { sendSticker } as unknown as { sendSticker: typeof sendSticker };

    await sendStickerTelegram(`${chatId}:topic:77`, "fileId123", {
      cfg: { session: { store: storePath } },
      token: "tok",
      api,
    });

    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({
      accountId: "default",
      chatId,
      messageId: "107",
    });
    expect(hasProviderObservedTelegramThreadBinding(cached, 77)).toBe(true);
  });

  it("rejects a blank fileId before creating a Telegram client", async () => {
    botCtorSpy.mockClear();

    for (const fileId of ["", "   "]) {
      await expect(
        sendStickerTelegram("123", fileId, { cfg: TELEGRAM_TEST_CFG, token: "tok" }),
      ).rejects.toThrow(/file_id is required/i);
    }
    expect(botCtorSpy).not.toHaveBeenCalled();
  });

  it("fails sticker sends instead of retrying without message_thread_id", async () => {
    const chatId = "-100123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendSticker = vi.fn().mockRejectedValueOnce(threadErr);
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await expect(
      sendStickerTelegram(chatId, "fileId123", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        messageThreadId: 271,
      }),
    ).rejects.toThrow("message thread not found");

    expect(sendSticker).toHaveBeenCalledTimes(1);
    expect(sendSticker).toHaveBeenCalledWith(chatId, "fileId123", {
      message_thread_id: 271,
    });
  });

  it("fails when sticker send returns no message_id", async () => {
    const chatId = "123";
    const sendSticker = vi.fn().mockResolvedValue({
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await expect(
      sendStickerTelegram(chatId, "fileId123", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow(/returned no message_id/i);
  });

  it("does not retry generic grammY failed envelopes for sticker sends", async () => {
    const chatId = "123";
    const sendSticker = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network request for 'sendSticker' failed!"));
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await expect(
      sendStickerTelegram(chatId, "fileId123", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/Network request for 'sendSticker' failed!/i);
    expect(sendSticker).toHaveBeenCalledTimes(1);
  });

  it("retries rate-limited sticker sends and honors retry_after", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const sendSticker = vi
      .fn()
      .mockRejectedValueOnce({
        message: "429 Too Many Requests",
        response: { parameters: { retry_after: 1 } },
      })
      .mockResolvedValueOnce({
        message_id: 109,
        chat: { id: chatId },
      });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = sendStickerTelegram(chatId, "fileId123", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ messageId: "109", chatId });
    expect(firstMockCall(setTimeoutSpy, "setTimeout call")[1]).toBe(1000);
    expect(sendSticker).toHaveBeenCalledTimes(2);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("shared send behaviors", () => {
  it("includes reply_to_message_id for threaded replies", async () => {
    const cases = [
      {
        name: "message send",
        run: async () => {
          const chatId = "123";
          const sendMessage = vi.fn().mockResolvedValue({
            message_id: 56,
            chat: { id: chatId },
          });
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await sendMessageTelegram(chatId, "reply text", {
            cfg: TELEGRAM_TEST_CFG,
            token: "tok",
            api,
            replyToMessageId: 100,
          });
          expect(sendMessage).toHaveBeenCalledWith(chatId, "reply text", {
            parse_mode: "HTML",
            reply_to_message_id: 100,
            allow_sending_without_reply: true,
          });
        },
      },
      {
        name: "sticker send",
        run: async () => {
          const chatId = "123";
          const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
          const sendSticker = vi.fn().mockResolvedValue({
            message_id: 102,
            chat: { id: chatId },
          });
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await sendStickerTelegram(chatId, fileId, {
            cfg: TELEGRAM_TEST_CFG,
            token: "tok",
            api,
            replyToMessageId: 500,
          });
          expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, {
            reply_to_message_id: 500,
            allow_sending_without_reply: true,
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("uses native reply parameters for direct quote sends without trimming the quote", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 56,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "reply text", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      replyToMessageId: 100,
      quoteText: " quoted text\n",
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "reply text", {
      parse_mode: "HTML",
      reply_parameters: {
        message_id: 100,
        quote: " quoted text\n",
        allow_sending_without_reply: true,
      },
    });
  });

  it("retries durable text sends with legacy reply id when native quotes are rejected", async () => {
    const chatId = "123";
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(createQuoteNotFoundError())
      .mockResolvedValueOnce({
        message_id: 57,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "reply text", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      replyToMessageId: 100,
      quoteText: "model paraphrase",
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "reply text", {
      parse_mode: "HTML",
      reply_parameters: {
        message_id: 100,
        quote: "model paraphrase",
        allow_sending_without_reply: true,
      },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "reply text", {
      parse_mode: "HTML",
      reply_to_message_id: 100,
      allow_sending_without_reply: true,
    });
  });

  it("retries media native quotes with a legacy reply before recording projection", async () => {
    const chatId = "123";
    const storePath = `/tmp/openclaw-telegram-media-quote-${process.pid}-${Date.now()}.json`;
    const cursor = createTelegramPromptContextProjectionCursor({
      transcriptMessageId: "assistant-media-quote",
    });
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(createQuoteNotFoundError())
      .mockResolvedValueOnce({
        message_id: 58,
        date: 1_779_425_460,
        chat: { id: chatId, type: "private" },
        photo: [{ file_id: "photo-file", file_unique_id: "photo-unique", width: 10, height: 10 }],
      });
    const api = { sendPhoto } as unknown as { sendPhoto: typeof sendPhoto };
    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "caption", {
      cfg: { session: { store: storePath } },
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      replyToMessageId: 100,
      quoteText: "model paraphrase",
      promptContextProjectionPlan: { cursor, finalPart: true },
    });

    expect(sendPhoto).toHaveBeenCalledTimes(2);
    expectMediaSendCall(sendPhoto.mock.calls[0]!, "native quote photo", chatId, {
      caption: "caption",
      parse_mode: "HTML",
      reply_parameters: {
        message_id: 100,
        quote: "model paraphrase",
        allow_sending_without_reply: true,
      },
    });
    expectMediaSendCall(sendPhoto.mock.calls[1]!, "legacy quote photo", chatId, {
      caption: "caption",
      parse_mode: "HTML",
      reply_to_message_id: 100,
      allow_sending_without_reply: true,
    });
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({ accountId: "default", chatId, messageId: "58" });
    expect(cached?.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: {
        transcriptMessageId: "assistant-media-quote",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("omits invalid reply_to_message_id values before calling Telegram", async () => {
    const invalidReplyToMessageIds = ["session-meta-id", "123abc", Number.NaN] as const;

    for (const invalidReplyToMessageId of invalidReplyToMessageIds) {
      const chatId = "123";
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: 56,
        chat: { id: chatId },
      });
      const sendSticker = vi.fn().mockResolvedValue({
        message_id: 102,
        chat: { id: chatId },
      });
      const api = { sendMessage, sendSticker } as unknown as {
        sendMessage: typeof sendMessage;
        sendSticker: typeof sendSticker;
      };

      await sendMessageTelegram(chatId, "reply text", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        replyToMessageId: invalidReplyToMessageId as unknown as number,
      });
      await sendStickerTelegram(chatId, "CAACAgIAAxkBAAI...sticker_file_id", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        replyToMessageId: invalidReplyToMessageId as unknown as number,
      });

      expect(sendMessage, String(invalidReplyToMessageId)).toHaveBeenCalledWith(
        chatId,
        "reply text",
        {
          parse_mode: "HTML",
        },
      );
      expect(sendSticker, String(invalidReplyToMessageId)).toHaveBeenCalledWith(
        chatId,
        "CAACAgIAAxkBAAI...sticker_file_id",
        undefined,
      );
    }
  });

  it("wraps chat-not-found with actionable context", async () => {
    const cases = [
      {
        name: "message send",
        run: async () => {
          const chatId = "123";
          const err = new Error("400: Bad Request: chat not found");
          const sendMessage = vi.fn().mockRejectedValue(err);
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await expectChatNotFoundWithChatId(
            sendMessageTelegram(chatId, "hi", { cfg: TELEGRAM_TEST_CFG, token: "tok", api }),
            chatId,
          );
        },
      },
      {
        name: "sticker send",
        run: async () => {
          const chatId = "123";
          const err = new Error("400: Bad Request: chat not found");
          const sendSticker = vi.fn().mockRejectedValue(err);
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await expectChatNotFoundWithChatId(
            sendStickerTelegram(chatId, "fileId123", { cfg: TELEGRAM_TEST_CFG, token: "tok", api }),
            chatId,
          );
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("wraps membership-related 403 errors with actionable context and original detail", async () => {
    const cases = [
      {
        name: "message send",
        errorText: "403: Forbidden: bot is not a member of the channel chat",
        run: async (chatId: string, err: Error) => {
          const sendMessage = vi.fn().mockRejectedValue(err);
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await expectTelegramMembershipErrorWithChatId(
            sendMessageTelegram(chatId, "hi", { cfg: TELEGRAM_TEST_CFG, token: "tok", api }),
            chatId,
            /bot is not a member of the channel chat/i,
          );
        },
      },
      {
        name: "sticker send",
        errorText: "403: Forbidden: bot was kicked from the group chat",
        run: async (chatId: string, err: Error) => {
          const sendSticker = vi.fn().mockRejectedValue(err);
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await expectTelegramMembershipErrorWithChatId(
            sendStickerTelegram(chatId, "fileId123", { cfg: TELEGRAM_TEST_CFG, token: "tok", api }),
            chatId,
            /bot was kicked from the group chat/i,
          );
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run("123", new Error(testCase.errorText));
    }
  });
});

describe("editMessageTelegram", () => {
  it.each([
    {
      name: "buttons undefined keeps existing keyboard",
      text: "hi",
      buttons: undefined as Parameters<typeof buildInlineKeyboard>[0],
      expectedCalls: 1,
      firstExpectNoReplyMarkup: true,
      parseFallback: false,
    },
    {
      name: "buttons empty clears keyboard",
      text: "hi",
      buttons: [] as Parameters<typeof buildInlineKeyboard>[0],
      expectedCalls: 1,
      firstExpectReplyMarkup: { inline_keyboard: [] } as Record<string, unknown>,
      parseFallback: false,
    },
    {
      name: "rich edit preserves cleared keyboard",
      text: "<bad> html",
      buttons: [] as Parameters<typeof buildInlineKeyboard>[0],
      expectedCalls: 1,
      firstExpectReplyMarkup: { inline_keyboard: [] } as Record<string, unknown>,
      parseFallback: false,
    },
  ])("$name", async (testCase) => {
    if (testCase.parseFallback) {
      botApi.editMessageText
        .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities"))
        .mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });
    } else {
      botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    }

    await editMessageTelegram("123", 1, testCase.text, {
      token: "tok",
      cfg: {},
      buttons: testCase.buttons ? testCase.buttons.map((row) => [...row]) : testCase.buttons,
    });

    expect(botCtorSpy, testCase.name).toHaveBeenCalledTimes(1);
    expect(firstMockCall(botCtorSpy, "bot constructor call")[0], testCase.name).toBe("tok");
    expect(botApi.editMessageText, testCase.name).toHaveBeenCalledTimes(testCase.expectedCalls);

    const firstParams = requireRecord(
      firstMockCall(botApi.editMessageText, "editMessageText call")[3],
      "first edit params",
    );
    expect(firstParams.parse_mode, testCase.name).toBe("HTML");
    if ("firstExpectNoReplyMarkup" in testCase && testCase.firstExpectNoReplyMarkup) {
      expect(firstParams, testCase.name).not.toHaveProperty("reply_markup");
    }
    if ("firstExpectReplyMarkup" in testCase && testCase.firstExpectReplyMarkup) {
      expect(firstParams.reply_markup, testCase.name).toEqual(testCase.firstExpectReplyMarkup);
    }

    if ("secondExpectReplyMarkup" in testCase && testCase.secondExpectReplyMarkup) {
      const secondParams = requireRecord(
        mockCall(botApi.editMessageText, 1, "second editMessageText call")[3],
        "second edit params",
      );
      expect(secondParams.reply_markup, testCase.name).toEqual(testCase.secondExpectReplyMarkup);
    }
  });

  it("treats 'message is not modified' as success", async () => {
    botApi.editMessageText.mockRejectedValueOnce(
      new Error(
        "400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      ),
    );

    await expect(
      editMessageTelegram("123", 1, "hi", {
        token: "tok",
        cfg: {},
      }),
    ).resolves.toEqual({ ok: true, messageId: "1", chatId: "123" });
    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
  });

  it("falls back to plain text when an HTML edit renders empty", async () => {
    botApi.editMessageText
      .mockRejectedValueOnce(new Error("400: Bad Request: message text is empty"))
      .mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "<b>visible</b>", {
      token: "tok",
      cfg: {},
      textMode: "html",
    });

    expect(botApi.editMessageText).toHaveBeenNthCalledWith(1, "123", 1, "<b>visible</b>", {
      parse_mode: "HTML",
    });
    expect(botApi.editMessageText).toHaveBeenNthCalledWith(2, "123", 1, "visible");
  });

  it("uses editMessageCaption when requested for media captions", async () => {
    botApi.editMessageCaption.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "Media **caption**", {
      token: "tok",
      cfg: {},
      editMode: "caption",
      buttons: [[{ text: "Open", url: "https://example.com" }]],
    });

    expect(botApi.editMessageText).not.toHaveBeenCalled();
    expect(botApi.editMessageCaption).toHaveBeenCalledTimes(1);
    const captionParams = requireRecord(
      firstMockCall(botApi.editMessageCaption, "editMessageCaption call")[2],
      "caption edit params",
    );
    expect(captionParams.caption).toBe("Media <b>caption</b>");
    expect(captionParams.parse_mode).toBe("HTML");
    expect(captionParams.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Open", url: "https://example.com" }]],
    });
  });

  it("falls back to editMessageCaption when Telegram reports a media message has no text", async () => {
    botApi.editMessageText.mockRejectedValueOnce(
      new Error("400: Bad Request: there is no text in the message to edit"),
    );
    botApi.editMessageCaption.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "New caption", {
      token: "tok",
      cfg: {},
      editMode: "auto",
    });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    expect(botApi.editMessageCaption).toHaveBeenCalledTimes(1);
    const captionParams = requireRecord(
      firstMockCall(botApi.editMessageCaption, "fallback editMessageCaption call")[2],
      "fallback caption edit params",
    );
    expect(captionParams.caption).toBe("New caption");
    expect(captionParams.parse_mode).toBe("HTML");
  });

  it("falls back to plain text when rich edits reject an invalid entity", async () => {
    const text = "Status includes openai:owner@example.com";
    botRawApi.editMessageText.mockRejectedValueOnce(
      createRichEntityInvalidError("EMAIL", "editMessageText"),
    );
    botApi.editMessageText.mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, text, {
      token: "tok",
      cfg: { channels: { telegram: { richMessages: true } } },
    });

    expect(botRawApi.editMessageText).toHaveBeenCalledTimes(1);
    expect(botApi.editMessageText).toHaveBeenCalledWith("123", 1, text);
  });

  it("retries editMessageTelegram on Telegram 5xx errors", async () => {
    botApi.editMessageText
      .mockRejectedValueOnce(Object.assign(new Error("502: Bad Gateway"), { error_code: 502 }))
      .mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });

    await expect(
      editMessageTelegram("123", 1, "hi", {
        token: "tok",
        cfg: {},
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).resolves.toEqual({ ok: true, messageId: "1", chatId: "123" });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(2);
  });

  it("edits text with formatted HTML", async () => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "**edited**", {
      token: "tok",
      cfg: {},
    });

    expect(botApi.editMessageText).toHaveBeenCalledWith("123", 1, "<b>edited</b>", {
      parse_mode: "HTML",
    });
    expect(botRawApi.editMessageText).not.toHaveBeenCalled();
  });

  it("edits complex text as formatted HTML", async () => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    const markdown = ["## Updated", "", "- **bold**", "- _italic_", "", "`code`"].join("\n");

    await editMessageTelegram("123", 1, markdown, {
      token: "tok",
      cfg: {},
    });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const [chatId, messageId, sentText, sentOptions] =
      botApi.editMessageText.mock.calls.at(-1) ?? [];
    expect(chatId).toBe("123");
    expect(messageId).toBe(1);
    expect(String(sentText)).toContain("Updated");
    expect(String(sentText)).toContain("<b>bold</b>");
    expect(String(sentText)).toContain("<i>italic</i>");
    expect(sentOptions).toEqual({ parse_mode: "HTML" });
    expect(botRawApi.editMessageText).not.toHaveBeenCalled();
  });

  it("disables link previews for text edits", async () => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "https://example.com", {
      token: "tok",
      cfg: {},
      linkPreview: false,
    });

    expect(botApi.editMessageText).toHaveBeenCalledWith(
      "123",
      1,
      '<a href="https://example.com">https://example.com</a>',
      {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
    );
    expect(botRawApi.editMessageText).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "inherits the disabled account default",
      accountLinkPreview: false,
      linkPreview: undefined,
      expectedDisabled: true,
    },
    {
      name: "lets an explicit enabled value override the account default",
      accountLinkPreview: false,
      linkPreview: true,
      expectedDisabled: false,
    },
    {
      name: "lets an explicit disabled value override the account default",
      accountLinkPreview: true,
      linkPreview: false,
      expectedDisabled: true,
    },
  ])("$name for edited Telegram messages", async (testCase) => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "https://example.com", {
      token: "tok",
      cfg: { channels: { telegram: { linkPreview: testCase.accountLinkPreview } } },
      ...(testCase.linkPreview !== undefined ? { linkPreview: testCase.linkPreview } : {}),
    });

    const params = requireRecord(
      firstMockCall(botApi.editMessageText, "editMessageText preview call")[3],
      "edited Telegram preview params",
    );
    if (testCase.expectedDisabled) {
      expect(params.link_preview_options).toEqual({ is_disabled: true });
    } else {
      expect(params).not.toHaveProperty("link_preview_options");
    }
  });

  it("preserves disabled previews when editing rich Telegram messages", async () => {
    botRawApi.editMessageText.mockResolvedValue({
      message_id: 1,
      chat: { id: "123", type: "private" },
      text: "https://example.com",
    });

    await editMessageTelegram("123", 1, "https://example.com", {
      token: "tok",
      cfg: { channels: { telegram: { richMessages: true } } },
      linkPreview: false,
    });

    expect(botRawApi.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: "123",
        message_id: 1,
        link_preview_options: { is_disabled: true },
      }),
    );
  });

  it.each([
    { name: "text", editMode: "text" as const, field: "text" as const },
    { name: "caption", editMode: "caption" as const, field: "caption" as const },
  ])("refreshes cached $name from Telegram's authoritative edit response", async (testCase) => {
    const storePath = `/tmp/openclaw-telegram-edited-context-${process.pid}-${Date.now()}-${testCase.name}.json`;
    const cfg = { session: { store: storePath } };
    const chat = {
      id: -100123,
      type: "supergroup" as const,
      title: "Ops",
      is_forum: true as const,
    };
    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: chat.id,
      threadId: 77,
      msg: {
        chat,
        message_id: 902,
        message_thread_id: 77,
        date: 1_779_394_740,
        from: { id: 42, is_bot: true, first_name: "OpenClaw" },
        [testCase.field]: "outdated content",
      },
    });
    const editedMessage = {
      chat,
      message_id: 902,
      message_thread_id: 77,
      date: 1_779_394_740,
      edit_date: 1_779_394_750,
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      [testCase.field]: "authoritative edited content",
    };
    if (testCase.editMode === "caption") {
      botApi.editMessageCaption.mockResolvedValue(editedMessage);
    } else {
      botApi.editMessageText.mockResolvedValue(editedMessage);
    }

    await editMessageTelegram(chat.id, 902, "authoritative edited content", {
      token: "42:test-token",
      cfg,
      editMode: testCase.editMode,
    });

    const cached = await cache.get({
      accountId: "default",
      chatId: chat.id,
      messageId: "902",
    });
    expect(cached?.body).toBe("authoritative edited content");
    expect(hasProviderObservedTelegramThreadBinding(cached, 77)).toBe(true);
  });

  it("refreshes edited group messages without duplicating self history or hiding later replies", async () => {
    const storePath = `/tmp/openclaw-telegram-edit-history-${process.pid}-${Date.now()}.json`;
    const cfg = { session: { store: storePath } };
    const chat = { id: -100123, type: "supergroup" as const, title: "Ops" };
    const historyKey = `${chat.id}:topic:77`;
    const groupHistory = new Map<
      string,
      Array<{ sender: string; body: string; messageId: string; timestamp: number }>
    >();
    recordTelegramGroupHistoryEntry({
      historyMap: groupHistory,
      historyKey,
      limit: 50,
      entry: {
        sender: "OpenClaw (you)",
        body: "original response",
        messageId: "902",
        timestamp: 1_779_394_740_000,
      },
    });
    recordTelegramGroupHistoryEntry({
      historyMap: groupHistory,
      historyKey,
      limit: 50,
      entry: {
        sender: "Teammate",
        body: "context that must remain visible",
        messageId: "903",
        timestamp: 1_779_394_741_000,
      },
    });
    const unregister = registerTelegramOutboundGroupHistoryRecorder({
      accountId: "default",
      recorder: (record) =>
        recordTelegramGroupHistoryEntry({
          historyMap: groupHistory,
          historyKey,
          limit: 50,
          entry: {
            sender: "OpenClaw (you)",
            body: record.text ?? "<media>",
            messageId: String(record.messageId),
            timestamp: record.timestamp ?? 0,
          },
        }),
    });
    botApi.editMessageText.mockResolvedValue({
      chat,
      message_id: 902,
      message_thread_id: 77,
      date: 1_779_394_740,
      from: { id: 42, is_bot: true, first_name: "OpenClaw" },
      text: "authoritative edited response",
    });

    try {
      await editMessageTelegram(chat.id, 902, "authoritative edited response", {
        token: "42:test-token",
        cfg,
      });
    } finally {
      unregister();
    }

    const entries = groupHistory.get(historyKey) ?? [];
    expect(entries.map((entry) => entry.messageId)).toEqual(["902", "903"]);
    expect(selectTelegramGroupHistoryAfterLastSelf(entries)).toEqual([
      expect.objectContaining({
        sender: "Teammate",
        body: "context that must remain visible",
      }),
    ]);
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({ accountId: "default", chatId: chat.id, messageId: "902" });
    expect(cached?.body).toBe("authoritative edited response");
  });
});

describe("sendPollTelegram", () => {
  async function installPollRegistryStore() {
    const store = createPluginStateKeyedStoreForTests<TelegramPollRegistryEntry>("telegram", {
      namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
      maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    await store.clear();
    return store;
  }

  it("sends polls with 12 options", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ message_id: 123, chat: { id: 555 }, poll: { id: "p1" } })),
    };
    const options = Array.from({ length: 12 }, (_, index) => `Option ${index + 1}`);

    await sendPollTelegram(
      "123",
      { question: "Q", options },
      { cfg: TELEGRAM_TEST_CFG, token: "t", api: api as unknown as Bot["api"] },
    );

    expect(firstMockCall(api.sendPoll, "send poll call")[2]).toEqual(options);
  });

  it("records a successful General-topic poll for later message mutations", async () => {
    const storePath = `/tmp/openclaw-telegram-poll-context-${process.pid}-${Date.now()}.json`;
    const chatId = "-100123";
    const sendPoll = vi.fn().mockResolvedValue({
      message_id: 124,
      chat: { id: chatId, type: "supergroup" },
      poll: { id: "p2", question: "Q", options: [] },
    });
    const api = { sendPoll } as unknown as Bot["api"];

    await sendPollTelegram(
      `${chatId}:topic:1`,
      { question: "Q", options: ["A", "B"] },
      { cfg: { session: { store: storePath } }, token: "t", api },
    );

    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({
      accountId: "default",
      chatId,
      messageId: "124",
    });
    expect(hasProviderObservedTelegramThreadBinding(cached, 1)).toBe(true);
  });

  it("propagates gateway client scopes when resolving legacy poll targets", async () => {
    const api = {
      getChat: vi.fn(async () => ({ id: -100321 })),
      sendPoll: vi.fn(async () => ({ message_id: 123, chat: { id: 555 }, poll: { id: "p1" } })),
    };

    await sendPollTelegram(
      "https://t.me/mychannel",
      { question: " Q ", options: [" A ", "B "] },
      {
        cfg: TELEGRAM_TEST_CFG,
        token: "t",
        api: api as unknown as Bot["api"],
        gatewayClientScopes: ["operator.admin"],
      },
    );

    expect(api.getChat).toHaveBeenCalledWith("@mychannel");
    expectPersistedTarget({
      rawTarget: "https://t.me/mychannel",
      resolvedChatId: "-100321",
      gatewayClientScopes: ["operator.admin"],
    });
  });

  it("maps durationSeconds to open_period", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ message_id: 123, chat: { id: 555 }, poll: { id: "p1" } })),
    };

    const res = await sendPollTelegram(
      "123",
      { question: " Q ", options: [" A ", "B "], durationSeconds: 60 },
      { cfg: TELEGRAM_TEST_CFG, token: "t", api: api as unknown as Bot["api"] },
    );

    expect(res).toMatchObject({
      messageId: "123",
      chatId: "555",
      pollId: "p1",
      pollAnswerRouting: "unavailable",
    });
    expect(api.sendPoll).toHaveBeenCalledTimes(1);
    const sendPollMock = api.sendPoll as ReturnType<typeof vi.fn>;
    const sendPollCall = firstMockCall(sendPollMock, "send poll call");
    expect(sendPollCall[0]).toBe("123");
    expect(sendPollCall[1]).toBe("Q");
    expect(sendPollCall[2]).toEqual(["A", "B"]);
    expect(requireRecord(sendPollCall[3], "send poll params").open_period).toBe(60);
    expect(wasSentByBot("123", 123)).toBe(true);
  });

  it("records a public poll origin with its resolved topic", async () => {
    const store = await installPollRegistryStore();
    botApi.getChatMember.mockResolvedValue({ status: "administrator" });
    botApi.sendPoll.mockResolvedValue({
      message_id: 123,
      message_thread_id: 99,
      chat: {
        id: -1001234567890,
        type: "supergroup",
        title: "Reviewers",
        is_forum: true,
      },
      poll: { id: "poll-public" },
    });

    const result = await sendPollTelegram(
      "-1001234567890:topic:99",
      { question: " Ready? ", options: [" Yes ", "No "] },
      {
        cfg: TELEGRAM_TEST_CFG,
        token: "999:token",
        isAnonymous: false,
      },
    );

    expect(result.pollAnswerRouting).toBe("enabled");
    expect(botApi.getChatMember).toHaveBeenCalledWith(-1001234567890, 999);
    expect(await store.entries()).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({
          pollId: "poll-public",
          chat: {
            id: -1001234567890,
            type: "supergroup",
            title: "Reviewers",
            is_forum: true,
          },
          messageId: 123,
          threadSpec: { scope: "forum", id: 99 },
          question: "Ready?",
          options: ["Yes", "No"],
        }),
      }),
    ]);
  });

  it.each([
    {
      name: "base private chat",
      to: "555",
      chat: { id: 555, type: "private" as const, first_name: "Ada" },
      expected: { scope: "dm" as const },
    },
    {
      name: "bot-private topic",
      to: "555:topic:42",
      chat: { id: 555, type: "private" as const, first_name: "Ada" },
      messageThreadId: 42,
      expected: { scope: "dm" as const, id: 42 },
    },
    {
      name: "regular group",
      to: "-100555",
      chat: { id: -100555, type: "supergroup" as const, title: "Reviewers" },
      expected: { scope: "none" as const },
    },
  ])("records the canonical $name poll scope", async (testCase) => {
    const store = await installPollRegistryStore();
    botApi.getChatMember.mockResolvedValue({ status: "administrator" });
    botApi.sendPoll.mockResolvedValue({
      message_id: 126,
      ...(testCase.messageThreadId === undefined
        ? {}
        : { message_thread_id: testCase.messageThreadId }),
      chat: testCase.chat,
      poll: { id: `poll-${testCase.expected.scope}` },
    });

    await expect(
      sendPollTelegram(
        testCase.to,
        { question: "Ready?", options: ["Yes", "No"] },
        { cfg: TELEGRAM_TEST_CFG, token: "999:token", isAnonymous: false },
      ),
    ).resolves.toMatchObject({ pollAnswerRouting: "enabled" });
    expect(await store.entries()).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ threadSpec: testCase.expected }),
      }),
    ]);
  });

  it("preserves the accepted General forum scope when Telegram omits its thread id", async () => {
    const store = await installPollRegistryStore();
    botApi.getChatMember.mockResolvedValue({ status: "administrator" });
    botApi.sendPoll.mockResolvedValue({
      message_id: 127,
      chat: { id: -100556, type: "supergroup", title: "Forum", is_forum: true },
      poll: { id: "poll-general" },
    });

    await expect(
      sendPollTelegram(
        "-100556:topic:1",
        { question: "Ready?", options: ["Yes", "No"] },
        { cfg: TELEGRAM_TEST_CFG, token: "999:token", isAnonymous: false },
      ),
    ).resolves.toMatchObject({ pollAnswerRouting: "enabled" });
    expect(await store.entries()).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ threadSpec: { scope: "forum", id: 1 } }),
      }),
    ]);
  });

  it("reports unavailable routing when the bot cannot verify group voters", async () => {
    const store = await installPollRegistryStore();
    botApi.getChatMember.mockResolvedValue({ status: "member" });
    botApi.sendPoll.mockResolvedValue({
      message_id: 124,
      chat: { id: -1001234567890, type: "supergroup", title: "Reviewers" },
      poll: { id: "poll-non-admin" },
    });

    await expect(
      sendPollTelegram(
        "-1001234567890",
        { question: "Ready?", options: ["Yes", "No"] },
        {
          cfg: TELEGRAM_TEST_CFG,
          token: "999:token",
          isAnonymous: false,
        },
      ),
    ).resolves.toMatchObject({
      pollAnswerRouting: "unavailable",
      warning: expect.stringContaining("not an administrator"),
    });
    expect(await store.entries()).toHaveLength(0);
  });

  const disabledPollRouteCases: Array<{
    name: string;
    cfg: Parameters<typeof sendPollTelegram>[2]["cfg"];
    messageThreadId?: number;
    omitResultThreadId?: boolean;
  }> = [
    {
      name: "account policy",
      cfg: { channels: { telegram: { groupPolicy: "disabled" as const } } },
      messageThreadId: undefined,
    },
    {
      name: "group scope",
      cfg: {
        channels: {
          telegram: {
            groups: { "-1001234567890": { enabled: false } },
          },
        },
      },
      messageThreadId: undefined,
    },
    {
      name: "topic policy",
      cfg: {
        channels: {
          telegram: {
            groupPolicy: "open" as const,
            groups: {
              "-1001234567890": {
                topics: { "99": { groupPolicy: "disabled" as const } },
              },
            },
          },
        },
      },
      messageThreadId: 99,
    },
    {
      name: "General topic policy without a returned thread id",
      cfg: {
        channels: {
          telegram: {
            groupPolicy: "open" as const,
            groups: {
              "-1001234567890": {
                topics: { "1": { groupPolicy: "disabled" as const } },
              },
            },
          },
        },
      },
      messageThreadId: 1,
      omitResultThreadId: true,
    },
    {
      name: "topic scope",
      cfg: {
        channels: {
          telegram: {
            groups: {
              "-1001234567890": { topics: { "99": { enabled: false } } },
            },
          },
        },
      },
      messageThreadId: 99,
    },
  ];

  it.each(disabledPollRouteCases)(
    "reports unavailable routing for disabled $name",
    async ({ cfg, messageThreadId, omitResultThreadId }) => {
      const store = await installPollRegistryStore();
      botApi.sendPoll.mockResolvedValue({
        message_id: 125,
        ...(messageThreadId === undefined || omitResultThreadId
          ? {}
          : { message_thread_id: messageThreadId }),
        chat: { id: -1001234567890, type: "supergroup", title: "Reviewers" },
        poll: { id: "poll-disabled" },
      });

      await expect(
        sendPollTelegram(
          "-1001234567890",
          { question: "Ready?", options: ["Yes", "No"] },
          {
            cfg,
            token: "999:token",
            isAnonymous: false,
            ...(messageThreadId === undefined ? {} : { messageThreadId }),
          },
        ),
      ).resolves.toMatchObject({
        pollAnswerRouting: "unavailable",
        warning: expect.stringContaining("inbound messages are disabled"),
      });
      expect(botApi.getChatMember).not.toHaveBeenCalled();
      expect(await store.entries()).toHaveLength(0);
    },
  );

  it("reports unavailable routing for channel polls", async () => {
    const store = await installPollRegistryStore();
    botApi.sendPoll.mockResolvedValue({
      message_id: 125,
      chat: { id: -1001234567890, type: "channel", title: "Announcements" },
      poll: { id: "poll-channel" },
    });

    await expect(
      sendPollTelegram(
        "-1001234567890",
        { question: "Ready?", options: ["Yes", "No"] },
        {
          cfg: TELEGRAM_TEST_CFG,
          token: "999:token",
          isAnonymous: false,
        },
      ),
    ).resolves.toMatchObject({
      pollAnswerRouting: "unavailable",
      warning: expect.stringContaining("not supported for Telegram channels"),
    });
    expect(botApi.getChatMember).not.toHaveBeenCalled();
    expect(await store.entries()).toHaveLength(0);
  });

  it("prepares a fast poll route without waiting for registration", async () => {
    const entry = {
      pollId: "poll-fast-answer",
      chat: { id: -1001234567890, type: "supergroup" as const, title: "Reviewers" },
      messageId: 125,
      threadSpec: { scope: "none" as const },
      question: "Ready?",
      options: ["Yes", "No"],
    };
    const registration = beginTelegramPollRegistration({ entry });
    const update = {
      poll_answer: {
        poll_id: "poll-fast-answer",
        option_ids: [0],
        user: { id: 9, first_name: "Ada", is_bot: false },
      },
    };
    prepareTelegramPollAnswerContext({ update });
    expect(getPreparedTelegramPollAnswer(update)).toMatchObject({
      entry: { pollId: "poll-fast-answer", chat: { id: -1001234567890 } },
      registrationPending: true,
    });

    let settlementFinished = false;
    const settlement = settleTelegramPollAnswerContext({ update }).then(() => {
      settlementFinished = true;
    });
    await Promise.resolve();
    expect(settlementFinished).toBe(false);
    registration.complete(entry);
    await settlement;
    expect(getPreparedTelegramPollAnswer(update)).toEqual({ entry });
  });

  it("does not reread or delay unknown poll answers", async () => {
    const store = await installPollRegistryStore();
    const syncStore = createPluginStateSyncKeyedStoreForTests<TelegramPollRegistryEntry>(
      "telegram",
      {
        namespace: TELEGRAM_POLL_REGISTRY_NAMESPACE,
        maxEntries: TELEGRAM_POLL_REGISTRY_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      },
    );
    const lookup = vi.spyOn(syncStore, "lookup");
    setTelegramRuntime({
      state: {
        openKeyedStore: (() => store) as TelegramRuntime["state"]["openKeyedStore"],
        openSyncKeyedStore: (() => syncStore) as TelegramRuntime["state"]["openSyncKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
    const update = {
      update_id: 13,
      poll_answer: {
        poll_id: "poll-unknown",
        user: { id: 10, is_bot: false, first_name: "Ada" },
        option_ids: [0],
      },
    };

    prepareTelegramPollAnswerContext({ update });

    expect(getPreparedTelegramPollAnswer(update)?.entry).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("reports default anonymous polls as unavailable without registering them", async () => {
    const store = await installPollRegistryStore();
    const api = {
      sendPoll: vi.fn(async () => ({
        message_id: 123,
        chat: { id: 555, type: "private", first_name: "Ada" },
        poll: { id: "poll-anonymous" },
      })),
    };

    await expect(
      sendPollTelegram(
        "555",
        { question: "Ready?", options: ["Yes", "No"] },
        {
          cfg: TELEGRAM_TEST_CFG,
          token: "t",
          api: api as unknown as Bot["api"],
        },
      ),
    ).resolves.toMatchObject({
      pollAnswerRouting: "unavailable",
      warning: expect.stringContaining("Send a public poll"),
    });

    expect(await store.entries()).toHaveLength(0);
  });

  it("does not retry an already-sent poll when origin storage fails", async () => {
    const pollRegistryKey = "default:poll-write-error";
    const register = vi.fn(async (key: string) => {
      if (key === pollRegistryKey) {
        throw new Error("registry db unavailable");
      }
    });
    setTelegramRuntime({
      state: {
        openKeyedStore: (() => ({
          register,
        })) as unknown as TelegramRuntime["state"]["openKeyedStore"],
        openSyncKeyedStore: (() =>
          sentMessageStore) as TelegramRuntime["state"]["openSyncKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
    const api = {
      sendPoll: vi.fn(async () => ({
        message_id: 123,
        chat: { id: 555, type: "private", first_name: "Ada" },
        poll: { id: "poll-write-error" },
      })),
    };

    await expect(
      sendPollTelegram(
        "555",
        { question: "Ready?", options: ["Yes", "No"] },
        {
          cfg: TELEGRAM_TEST_CFG,
          token: "t",
          api: api as unknown as Bot["api"],
          isAnonymous: false,
        },
      ),
    ).resolves.toEqual({
      messageId: "123",
      chatId: "555",
      pollId: "poll-write-error",
      pollAnswerRouting: "unavailable",
      warning:
        "Poll sent, but answers cannot reach the agent because routing state could not be saved. Ask the user to reply in text.",
    });
    expect(api.sendPoll).toHaveBeenCalledTimes(1);
    expect(register.mock.calls.filter(([key]) => key === pollRegistryKey)).toHaveLength(1);
  });

  it("fails poll sends instead of retrying without message_thread_id", async () => {
    const api = {
      sendPoll: vi
        .fn()
        .mockRejectedValueOnce(new Error("400: Bad Request: message thread not found")),
    };

    await expect(
      sendPollTelegram(
        "-100123",
        { question: "Q", options: ["A", "B"] },
        {
          cfg: TELEGRAM_TEST_CFG,
          token: "t",
          api: api as unknown as Bot["api"],
          messageThreadId: 99,
        },
      ),
    ).rejects.toThrow("message thread not found");

    expect(api.sendPoll).toHaveBeenCalledTimes(1);
    expect(
      requireRecord(firstMockCall(api.sendPoll, "send poll call")[3], "send poll params")
        .message_thread_id,
    ).toBe(99);
  });

  it("rejects durationHours for Telegram polls", async () => {
    const api = { sendPoll: vi.fn() };

    await expect(
      sendPollTelegram(
        "123",
        { question: "Q", options: ["A", "B"], durationHours: 1 },
        { cfg: TELEGRAM_TEST_CFG, token: "t", api: api as unknown as Bot["api"] },
      ),
    ).rejects.toThrow(/durationHours is not supported/i);

    expect(api.sendPoll).not.toHaveBeenCalled();
  });

  it("fails when poll send returns no message_id", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ chat: { id: 555 }, poll: { id: "p1" } })),
    };

    await expect(
      sendPollTelegram(
        "123",
        { question: "Q", options: ["A", "B"] },
        { cfg: TELEGRAM_TEST_CFG, token: "t", api: api as unknown as Bot["api"] },
      ),
    ).rejects.toThrow(/returned no message_id/i);
  });
});

describe("createForumTopicTelegram", () => {
  const cases = [
    {
      name: "uses base chat id when target includes topic suffix",
      target: "telegram:group:-1001234567890:topic:271",
      title: "x",
      response: { message_thread_id: 272, name: "Build Updates" },
      expectedCall: ["-1001234567890", "x", undefined] as const,
      expectedResult: {
        topicId: 272,
        name: "Build Updates",
        chatId: "-1001234567890",
      },
    },
    {
      name: "forwards optional icon fields",
      target: "-1001234567890",
      title: "Roadmap",
      response: { message_thread_id: 300, name: "Roadmap" },
      options: {
        iconColor: 0x6fb9f0,
        iconCustomEmojiId: "  1234567890  ",
      },
      expectedCall: [
        "-1001234567890",
        "Roadmap",
        { icon_color: 0x6fb9f0, icon_custom_emoji_id: "1234567890" },
      ] as const,
      expectedResult: {
        topicId: 300,
        name: "Roadmap",
        chatId: "-1001234567890",
      },
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const createForumTopic = vi.fn().mockResolvedValue(testCase.response);
      const api = { createForumTopic } as unknown as Bot["api"];

      const result = await createForumTopicTelegram(testCase.target, testCase.title, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        ...("options" in testCase ? testCase.options : {}),
      });

      expect(createForumTopic).toHaveBeenCalledWith(...testCase.expectedCall);
      expect(result).toEqual(testCase.expectedResult);
    });
  }

  it.each([
    ["65 emoji", "🎃".repeat(65)],
    ["128 emoji", "🎃".repeat(128)],
    ["128 mixed emoji and ASCII characters", "🎃".repeat(64) + "a".repeat(64)],
    ["128 CJK characters", "界".repeat(128)],
  ])("accepts %s forum topic names by Unicode code points", async (_label, name) => {
    const createForumTopic = vi.fn().mockResolvedValue({ message_thread_id: 400, name });
    const api = { createForumTopic } as unknown as Bot["api"];

    await createForumTopicTelegram("-1001234567890", name, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(createForumTopic).toHaveBeenCalledWith("-1001234567890", name, undefined);
  });

  it("rejects an invalid topic name before creating a Telegram client", async () => {
    botCtorSpy.mockClear();

    await expect(
      createForumTopicTelegram("-1001234567890", "   ", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
      }),
    ).rejects.toThrow("Forum topic name is required");
    expect(botCtorSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["129 ASCII characters", "a".repeat(129)],
    ["129 emoji", "🎃".repeat(129)],
    ["19 multi-code-point emoji graphemes", "👨‍👩‍👧‍👦".repeat(19)],
  ])("rejects %s exceeding 128 Unicode code points on create and edit", async (_label, name) => {
    const createForumTopic = vi.fn();
    const editForumTopic = vi.fn();
    const api = { createForumTopic, editForumTopic } as unknown as Bot["api"];

    await expect(
      createForumTopicTelegram("-1001234567890", name, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow("128 characters or fewer");
    await expect(
      editForumTopicTelegram("-1001234567890", 271, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        name,
      }),
    ).rejects.toThrow("128 characters or fewer");

    expect(createForumTopic).not.toHaveBeenCalled();
    expect(editForumTopic).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
