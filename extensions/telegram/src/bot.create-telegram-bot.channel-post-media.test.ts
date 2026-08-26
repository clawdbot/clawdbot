// Telegram tests cover bot.create telegram bot.channel post media plugin behavior.
import { setTimeout as delay } from "node:timers/promises";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  telegramBotInfoForTest,
  telegramIngestGroupForTest,
  waitForTelegramMockCalls,
  type TelegramIngestGroupForTest,
  type TelegramMentionCaseForTest,
  type TelegramMentionPolicyForTest,
} from "./bot.create-telegram-bot.test-support.js";
import { setTelegramRuntime } from "./runtime.js";
import type { TelegramRuntime } from "./runtime.types.js";

const saveRemoteMedia = vi.fn();
const rootRead = vi.fn();
const { triggerInternalHookMock } = vi.hoisted(() => ({
  triggerInternalHookMock: vi.fn<(event: unknown) => Promise<void>>(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/hook-runtime")>(
    "openclaw/plugin-sdk/hook-runtime",
  );
  return {
    ...actual,
    triggerInternalHook: triggerInternalHookMock,
  };
});

vi.mock("openclaw/plugin-sdk/file-access-runtime", () => ({
  root: async (rootDir: string) => ({
    read: async (relativePath: string, options?: { maxBytes?: number }) =>
      await rootRead({ rootDir, relativePath, maxBytes: options?.maxBytes }),
  }),
}));

vi.mock("./telegram-media.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram-media.runtime.js")>();
  return {
    ...actual,
    saveRemoteMedia: (...args: unknown[]) => saveRemoteMedia(...args),
  };
});

vi.mock("./sticker-cache.js", () => ({
  cacheSticker: () => {},
  getCachedSticker: () => null,
  getCacheStats: () => ({ count: 0 }),
  searchStickers: () => [],
  getAllCachedStickers: () => [],
  describeStickerImage: async () => null,
}));

const harness = await import("./bot.create-telegram-bot.test-harness.js");
const { getLoadConfigMock, getOnHandler, replySpy, sendMessageSpy, telegramBotDepsForTest } =
  harness;
const { createTelegramBotCore: createTelegramBotBase } = await import("./bot-core.js");
const { runWithTelegramSpooledReplayUpdate, runWithTelegramUpdateProcessingFrame } =
  await import("./bot-processing-outcome.js");
const { MediaFetchError } = await import("./telegram-media.runtime.js");

let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();

const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;
const TEXT_FRAGMENT_COALESCE_TEST_GAP_MS = 5_000;
const TELEGRAM_TEST_TOPIC = "-100456:topic:42";

async function withTelegramSpooledReplayUpdate<T>(
  update: object,
  fn: () => Promise<T>,
): Promise<T> {
  return (await runWithTelegramSpooledReplayUpdate(update, fn)).value;
}

function setOpenChannelPostConfig() {
  loadConfig.mockReturnValue({
    channels: {
      telegram: {
        groupPolicy: "open",
        groups: { "-100777111222": { enabled: true, requireMention: false } },
      },
    },
  });
}

function getChannelPostHandler(
  testTimings: { mediaGroupFlushMs: number; textFragmentGapMs: number } = TELEGRAM_TEST_TIMINGS,
) {
  createTelegramBot({ token: "tok", testTimings });
  return getOnHandler("channel_post") as (ctx: Record<string, unknown>) => Promise<void>;
}

function resolveFlushTimerForDelay(setTimeoutSpy: ReturnType<typeof vi.spyOn>, delayMs: number) {
  const flushTimerCallIndex = setTimeoutSpy.mock.calls.findLastIndex(
    (call: Parameters<typeof setTimeout>) => call[1] === delayMs,
  );
  const flushTimer =
    flushTimerCallIndex >= 0
      ? (setTimeoutSpy.mock.calls[flushTimerCallIndex]?.[0] as (() => unknown) | undefined)
      : undefined;
  if (flushTimerCallIndex >= 0) {
    clearTimeout(
      setTimeoutSpy.mock.results[flushTimerCallIndex]?.value as ReturnType<typeof setTimeout>,
    );
  }
  return flushTimer;
}

function createImageFetchSpy(params?: { body?: Uint8Array; contentType?: string }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(Buffer.from(params?.body ?? [0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": params?.contentType ?? "image/png" },
      }),
  );
}

function createChannelPostContext(params: {
  messageId: number;
  date: number;
  title?: string;
  caption?: string;
  text?: string;
  mediaGroupId?: string;
  photoFileId?: string;
  getFileResult?: Record<string, unknown>;
}) {
  const photoFileId = params.photoFileId;
  return {
    channelPost: {
      chat: { id: -100777111222, type: "channel", title: params.title ?? "Wake Channel" },
      message_id: params.messageId,
      date: params.date,
      ...(params.caption ? { caption: params.caption } : {}),
      ...(params.text ? { text: params.text } : {}),
      ...(params.mediaGroupId ? { media_group_id: params.mediaGroupId } : {}),
      ...(photoFileId ? { photo: [{ file_id: photoFileId }] } : {}),
    },
    me: { username: "openclaw_bot" },
    getFile: async () =>
      params.getFileResult ?? (photoFileId ? { file_path: `photos/${photoFileId}.jpg` } : {}),
  };
}

async function flushChannelPostMediaGroup(setTimeoutSpy: ReturnType<typeof vi.spyOn>) {
  const flushTimer = resolveFlushTimerForDelay(
    setTimeoutSpy,
    TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs,
  );
  expect(flushTimer).toBeTypeOf("function");
  await flushTimer?.();
  await delay(75);
}

async function flushChannelPostMediaGroupForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
) {
  const flushTimer = resolveFlushTimerForDelay(setTimeoutSpy, delayMs);
  expect(flushTimer).toBeTypeOf("function");
  await flushTimer?.();
  await delay(75);
}

async function queueChannelPostAlbum(
  handler: ReturnType<typeof getChannelPostHandler>,
  params: {
    caption: string;
    mediaGroupId: string;
    firstMessageId: number;
    secondMessageId: number;
    firstPhotoFileId?: string;
    secondPhotoFileId?: string;
    secondGetFileResult?: Record<string, unknown>;
  },
) {
  await Promise.all(
    [
      {
        messageId: params.firstMessageId,
        caption: params.caption,
        date: 1736380800,
        photoFileId: params.firstPhotoFileId ?? "p1",
      },
      {
        messageId: params.secondMessageId,
        date: 1736380801,
        photoFileId: params.secondPhotoFileId ?? "p2",
        getFileResult: params.secondGetFileResult,
      },
    ].map((message) =>
      handler(createChannelPostContext({ ...message, mediaGroupId: params.mediaGroupId })),
    ),
  );
}

function replyPayload(): Record<string, unknown> {
  const call = replySpy.mock.calls.at(0);
  if (!call || !call[0] || typeof call[0] !== "object") {
    throw new Error("Expected reply payload");
  }
  return call[0] as Record<string, unknown>;
}

function expectTypeOnlyMediaPayload(kind: string, rawBody = "") {
  const payload = replyPayload();
  expect(payload).toMatchObject({
    BodyForAgent: rawBody,
    media: [expect.objectContaining({ kind })],
    RawBody: rawBody,
  });
  const media = payload.media as Array<{ path?: string; fileName?: string }>;
  expect(media).toHaveLength(1);
  expect(media[0]?.path).toBeUndefined();
  expect(media[0]?.fileName).toBeUndefined();
}

function setTelegramIngestGroupConfig(
  params: {
    groups?: Record<string, TelegramIngestGroupForTest>;
    groupAllowFrom?: string[];
    providerPolicy?: TelegramMentionPolicyForTest;
    accountPolicy?: TelegramMentionPolicyForTest;
    customMentionPatterns?: boolean;
  } = {},
) {
  loadConfig.mockReturnValue({
    ...(params.customMentionPatterns
      ? { messages: { groupChat: { mentionPatterns: ["\\bbert\\b"] } } }
      : {}),
    channels: {
      telegram: {
        groupPolicy: "open",
        ...(params.groupAllowFrom ? { groupAllowFrom: params.groupAllowFrom } : {}),
        ...(params.providerPolicy ? { mentionPatterns: params.providerPolicy } : {}),
        groups: params.groups ?? { "-100456": { requireMention: true, ingest: true } },
        ...(params.accountPolicy
          ? { accounts: { work: { mentionPatterns: params.accountPolicy } } }
          : {}),
      },
    },
  });
}

async function dispatchTelegramGroupPhoto(params: {
  messageId: number;
  topicId?: number;
  albumId?: string;
  caption?: string;
  extraMessage?: Record<string, unknown>;
  getFile?: () => Promise<{ file_path: string }>;
}) {
  const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
  await handler({
    message: {
      chat: {
        id: -100456,
        type: "supergroup",
        title: "Ops Chat",
        is_forum: params.topicId !== undefined,
      },
      message_id: params.messageId,
      date: 1736380800,
      ...(params.topicId ? { message_thread_id: params.topicId, is_topic_message: true } : {}),
      ...(params.albumId ? { media_group_id: params.albumId } : {}),
      ...(params.caption ? { caption: params.caption } : {}),
      ...params.extraMessage,
      photo: [{ file_id: `photo-${params.messageId}` }],
      from: { id: 55, is_bot: false, first_name: "u" },
    },
    me: { id: 999, username: "openclaw_bot" },
    getFile: params.getFile ?? (async () => ({ file_path: `photos/${params.messageId}.jpg` })),
  });
}

function expectTelegramIngestHook(
  messageIds: number[],
  params: { content?: string; expectedCalls?: number } = {},
) {
  const expectedCalls = params.expectedCalls ?? 1;
  const event = triggerInternalHookMock.mock.calls[0]?.[0] as
    | { type: string; action: string; context: { content: string; media?: unknown[] } }
    | undefined;
  expect(triggerInternalHookMock).toHaveBeenCalledTimes(expectedCalls);
  expect(event?.type).toEqual(expectedCalls ? "message" : undefined);
  expect(event?.action).toEqual(expectedCalls ? "received" : undefined);
  expect(event?.context.content).toEqual(
    expectedCalls ? (params.content ?? expect.stringMatching(/\S/u)) : undefined,
  );
  expect(event?.context.media).toEqual(
    expectedCalls && messageIds.length
      ? messageIds.map((messageId) =>
          expect.objectContaining({
            path: "/tmp/telegram-media.bin",
            contentType: "image/png",
            kind: "image",
            messageId: String(messageId),
          }),
        )
      : undefined,
  );
}

function setOpenTelegramDirectConfig(mediaMaxMb?: number) {
  loadConfig.mockReturnValue({
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        ...(mediaMaxMb === undefined ? {} : { mediaMaxMb }),
      },
    },
  });
}

function createTelegramPrivateMediaContext(params: {
  messageId: number;
  fileId: string;
  fileName?: string;
  update?: { update_id: number };
  getFile?: () => Promise<{ file_path: string }>;
}) {
  return {
    ...(params.update ? { update: params.update } : {}),
    message: {
      chat: { id: 1234, type: "private" },
      message_id: params.messageId,
      date: 1736380800,
      ...(params.fileName
        ? { document: { file_id: params.fileId, file_name: params.fileName } }
        : { photo: [{ file_id: params.fileId }] }),
      from: { id: 55, is_bot: false, first_name: "u" },
    },
    me: { username: "openclaw_bot" },
    getFile: params.getFile ?? (async () => ({ file_path: `documents/${params.fileId}` })),
  };
}

function expectTelegramDownloadWarning(messageId: number, warning?: string) {
  expect(sendMessageSpy).toHaveBeenCalledWith(
    1234,
    warning ?? "⚠️ Failed to download media. Please try again.",
    expect.objectContaining({
      reply_parameters: expect.objectContaining({
        message_id: messageId,
        allow_sending_without_reply: true,
      }),
    }),
  );
}

function rejectFirstTelegramAlbumDownloadWhen(partial: boolean) {
  if (partial) {
    saveRemoteMedia.mockRejectedValueOnce(
      new MediaFetchError("fetch_failed", "Failed to fetch media"),
    );
  }
}

async function rejectTelegramAlbumDownload(shutdown: AbortController, abort: boolean) {
  if (abort) {
    shutdown.abort();
  }
  const cause = abort
    ? Object.assign(new Error("aborted"), { name: "AbortError" })
    : new Error("Failed to fetch media");
  throw new MediaFetchError("fetch_failed", cause.message, { cause });
}

describe("createTelegramBot channel_post media", () => {
  beforeAll(() => {
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        botInfo: telegramBotInfoForTest,
        telegramTransport: {
          fetch: globalThis.fetch,
          sourceFetch: globalThis.fetch,
          close: async () => {},
        },
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  beforeEach(() => {
    setTelegramRuntime({
      state: {
        openKeyedStore: ((options) =>
          createPluginStateKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openKeyedStore"],
        openSyncKeyedStore: ((options) =>
          createPluginStateSyncKeyedStoreForTests(
            "telegram",
            options,
          )) as TelegramRuntime["state"]["openSyncKeyedStore"],
      },
      channel: {},
    } as TelegramRuntime);
    triggerInternalHookMock.mockClear();
    saveRemoteMedia.mockReset();
    saveRemoteMedia.mockImplementation(
      async (params: { fetchImpl: typeof fetch; maxBytes: number; url: string }) => {
        const response = await params.fetchImpl(params.url);
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.length > params.maxBytes) {
          throw new MediaFetchError("max_bytes", `payload exceeds maxBytes ${params.maxBytes}`);
        }
        return {
          path: "/tmp/telegram-media.bin",
          contentType: response.headers.get("content-type"),
        };
      },
    );
    rootRead.mockReset();
  });

  it("buffers channel_post media groups and processes them together", async () => {
    setOpenChannelPostConfig();

    const fetchSpy = createImageFetchSpy();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();
      await queueChannelPostAlbum(handler, {
        caption: "album caption",
        mediaGroupId: "channel-album-1",
        firstMessageId: 201,
        secondMessageId: 202,
      });
      expect(replySpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroup(setTimeoutSpy);
      await waitForTelegramMockCalls(replySpy, 1);

      await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
      const payload = replyPayload() as { Body?: string };
      expect(payload.Body).toContain("album caption");
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("coalesces channel_post near-limit text fragments into one message", async () => {
    setOpenChannelPostConfig();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler({
        ...TELEGRAM_TEST_TIMINGS,
        textFragmentGapMs: TEXT_FRAGMENT_COALESCE_TEST_GAP_MS,
      });

      const part1 = "A".repeat(4050);
      const part2 = "B".repeat(50);

      await handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 301,
          date: 1736380800,
          text: part1,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      await handler({
        channelPost: {
          chat: { id: -100777111222, type: "channel", title: "Wake Channel" },
          message_id: 302,
          date: 1736380801,
          text: part2,
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({}),
      });

      expect(replySpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroupForDelay(setTimeoutSpy, TEXT_FRAGMENT_COALESCE_TEST_GAP_MS);

      await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
      const payload = replyPayload() as { RawBody?: string };
      expect(payload.RawBody).toContain(part1.slice(0, 32));
      expect(payload.RawBody).toContain(part2.slice(0, 32));
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("dispatches an oversized channel_post as a type-only media fact", async () => {
    setOpenChannelPostConfig();
    const fetchSpy = createImageFetchSpy({
      body: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      contentType: "image/jpeg",
    });

    createTelegramBot({ token: "tok", mediaMaxMb: 0 });
    const handler = getOnHandler("channel_post") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(
      createChannelPostContext({
        messageId: 4001,
        date: 1736380800,
        photoFileId: "oversized",
      }),
    );

    expect(replySpy).toHaveBeenCalledOnce();
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expectTypeOnlyMediaPayload("image");
    fetchSpy.mockRestore();
  });

  it("notifies users when media download fails for direct messages", async () => {
    setOpenTelegramDirectConfig();
    saveRemoteMedia.mockRejectedValueOnce(
      new MediaFetchError("fetch_failed", "Failed to fetch media"),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch failed"));
    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      await handler(createTelegramPrivateMediaContext({ messageId: 411, fileId: "p1" }));
      await waitForTelegramMockCalls(sendMessageSpy, 1);
      expectTelegramDownloadWarning(411);
      expect(replySpy).toHaveBeenCalledOnce();
      expectTypeOnlyMediaPayload("image");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("warns and dispatches a type-only fact when Telegram getFile fails (#100000)", async () => {
    setOpenTelegramDirectConfig();
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    await handler(
      createTelegramPrivateMediaContext({
        messageId: 100000,
        fileId: "doc-100000",
        fileName: "report.pdf",
        getFile: async () => {
          throw new Error("Network request for 'getFile' failed!");
        },
      }),
    );
    await waitForTelegramMockCalls(sendMessageSpy, 1);
    expectTelegramDownloadWarning(100000);
    expect(replySpy).toHaveBeenCalledOnce();
    expectTypeOnlyMediaPayload("document");
    expect(saveRemoteMedia).not.toHaveBeenCalled();
  });

  it.each([
    { mediaMaxMb: 100, expectedLimitMb: 20 },
    { mediaMaxMb: 10, expectedLimitMb: 10 },
  ])(
    "reports the effective $expectedLimitMb MB limit for Telegram Bot API failures (#100000)",
    async ({ mediaMaxMb, expectedLimitMb }) => {
      setOpenTelegramDirectConfig(mediaMaxMb);
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const messageId = 100001 + expectedLimitMb;
      await handler(
        createTelegramPrivateMediaContext({
          messageId,
          fileId: "doc-100001",
          fileName: "large.bin",
          getFile: async () => {
            throw new Error("Bad Request: file is too big");
          },
        }),
      );
      await waitForTelegramMockCalls(sendMessageSpy, 1);
      expectTelegramDownloadWarning(
        messageId,
        `⚠️ File too large. Maximum size is ${expectedLimitMb}MB.`,
      );
      expect(replySpy).toHaveBeenCalledOnce();
      expectTypeOnlyMediaPayload("document");
      expect(saveRemoteMedia).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "retryable shutdown abort",
      messageId: 98076,
      error: new MediaFetchError("fetch_failed", "aborted", {
        cause: Object.assign(new Error("aborted"), { name: "AbortError" }),
      }),
      result: { kind: "failed-retryable", error: expect.any(MediaFetchError) },
      warning: undefined,
    },
    {
      name: "permanent oversized media",
      messageId: 98077,
      error: new MediaFetchError("max_bytes", "Failed to fetch media: payload exceeds maxBytes 10"),
      result: { kind: "completed" },
      warning: "⚠️ File too large. Maximum size is 100MB.",
    },
    {
      name: "permanent SSRF rejection",
      messageId: 98078,
      error: new MediaFetchError("fetch_failed", "blocked by SSRF guard: private address"),
      result: { kind: "completed" },
      warning: "⚠️ Failed to download media. Please try again.",
    },
  ])("preserves durable replay handling for $name (#98076)", async (testCase) => {
    setOpenTelegramDirectConfig();
    saveRemoteMedia.mockRejectedValue(testCase.error);
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const update = { update_id: testCase.messageId };
    const ctx = createTelegramPrivateMediaContext({
      messageId: testCase.messageId,
      fileId: `doc-${testCase.messageId}`,
      fileName: "document.pdf",
      update,
    });
    const { result } = await runWithTelegramUpdateProcessingFrame(() =>
      withTelegramSpooledReplayUpdate(update, () => handler(ctx)),
    );
    expect(result).toEqual(testCase.result);
    const expectedWarnings = testCase.warning ? 1 : 0;
    expect(sendMessageSpy).toHaveBeenCalledTimes(expectedWarnings);
    expect(replySpy).toHaveBeenCalledTimes(expectedWarnings);
    expect(sendMessageSpy.mock.calls[0]?.[1]).toBe(testCase.warning);
    if (testCase.warning) {
      expectTelegramDownloadWarning(testCase.messageId, testCase.warning);
      expectTypeOnlyMediaPayload("document");
    }
  });

  it.each([
    ["default disabled", undefined, undefined, undefined, false],
    ["enabled group", true, undefined, undefined, true],
    ["wildcard inherited", undefined, true, undefined, true],
    ["group disables wildcard", false, true, undefined, false],
    ["topic enables group", false, undefined, true, true],
    ["topic disables group", true, undefined, false, false],
    ["unauthorized unmentioned command", true, undefined, undefined, false],
    ["unauthorized mentioned command", true, undefined, undefined, false],
    ["unauthorized mention-optional command", true, undefined, undefined, false],
    ["unauthorized prefixed mention-optional command", true, undefined, undefined, false],
  ] as Array<[string, boolean | undefined, boolean | undefined, boolean | undefined, boolean]>)(
    "honors %s before skipping unmentioned group media (#92067)",
    async (_name, groupIngest, wildcardIngest, topicIngest, shouldIngest) => {
      const unauthorizedCommand = _name.startsWith("unauthorized");
      const command = `${_name.includes("prefixed") ? "[Tue 2026-06-02 12:34] " : ""}${
        _name === "unauthorized mentioned command" ? "/reset@openclaw_bot" : "/reset"
      }`;
      const commandOffset = command.indexOf("/");
      const topics = topicIngest === undefined ? undefined : { "42": { ingest: topicIngest } };
      const groups = {
        ...(wildcardIngest === undefined
          ? {}
          : { "*": telegramIngestGroupForTest(wildcardIngest) }),
        "-100456": {
          ...telegramIngestGroupForTest(groupIngest, topics),
          requireMention: !_name.includes("mention-optional"),
        },
      };
      setTelegramIngestGroupConfig({
        groups,
        groupAllowFrom: unauthorizedCommand ? ["999"] : undefined,
      });
      const getFile = vi.fn(async () => ({ file_path: "photos/ingested.jpg" }));
      const fetchSpy = createImageFetchSpy();
      try {
        createTelegramBot({ token: "tok" });
        await dispatchTelegramGroupPhoto({
          messageId: 92067,
          topicId: topicIngest === undefined ? undefined : 42,
          caption: unauthorizedCommand ? command : undefined,
          extraMessage: unauthorizedCommand
            ? {
                caption_entities: [
                  {
                    type: "bot_command",
                    offset: commandOffset,
                    length: command.length - commandOffset,
                  },
                ],
              }
            : undefined,
          getFile,
        });
        const expectedCalls = Number(shouldIngest);
        expect(getFile).toHaveBeenCalledTimes(expectedCalls);
        expect(fetchSpy).toHaveBeenCalledTimes(expectedCalls);
        expectTelegramIngestHook([92067], { expectedCalls });
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(replySpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it.each([
    { failure: "a download error", error: "Network request for 'getFile' failed!" },
    { failure: "an oversized file", error: "Bad Request: file is too big" },
  ])("silently ingests unmentioned group media after $failure (#92067)", async ({ error }) => {
    setTelegramIngestGroupConfig();
    createTelegramBot({ token: "tok" });
    await dispatchTelegramGroupPhoto({
      messageId: 92070,
      getFile: async () => {
        throw new Error(error);
      },
    });
    expect(sendMessageSpy).not.toHaveBeenCalled();
    expect(replySpy).not.toHaveBeenCalled();
    expect(saveRemoteMedia).not.toHaveBeenCalled();
    expectTelegramIngestHook([]);
  });

  it.each([
    { name: "all", messageIds: [92068, 92069], partial: false, deniedMention: false },
    { name: "partial", messageIds: [92071, 92072], partial: true, deniedMention: false },
    { name: "denied mention", messageIds: [92071, 92072], partial: true, deniedMention: true },
    { name: "unauthorized", messageIds: [92079, 92080], partial: false, deniedMention: false },
  ])("applies group media album policy to $name (#92067)", async (testCase) => {
    const unauthorizedCommand = testCase.name === "unauthorized";
    setTelegramIngestGroupConfig({
      customMentionPatterns: testCase.deniedMention,
      groupAllowFrom: unauthorizedCommand ? ["999"] : undefined,
      ...(testCase.deniedMention ? { providerPolicy: { mode: "deny" } } : {}),
    });
    rejectFirstTelegramAlbumDownloadWhen(testCase.partial);
    const fetchSpy = createImageFetchSpy();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const getFile = vi.fn(async () => ({ file_path: "photos/ingested-album.jpg" }));
    try {
      createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
      for (const messageId of testCase.messageIds) {
        const commandCaption = unauthorizedCommand && messageId === testCase.messageIds[1];
        await dispatchTelegramGroupPhoto({
          messageId,
          albumId: "ingested-album",
          caption: commandCaption
            ? "/reset@openclaw_bot"
            : unauthorizedCommand
              ? "ordinary caption"
              : testCase.deniedMention && messageId === testCase.messageIds[0]
                ? "bert, see attachment"
                : undefined,
          extraMessage: commandCaption
            ? { caption_entities: [{ type: "bot_command", offset: 0, length: 19 }] }
            : undefined,
          getFile,
        });
      }
      expect(getFile).not.toHaveBeenCalled();
      await flushChannelPostMediaGroup(setTimeoutSpy);
      expect(getFile).toHaveBeenCalledTimes(unauthorizedCommand ? 0 : 2);
      expect(fetchSpy).toHaveBeenCalledTimes(unauthorizedCommand ? 0 : testCase.partial ? 1 : 2);
      const ingestedIds = testCase.partial ? testCase.messageIds.slice(1) : testCase.messageIds;
      expectTelegramIngestHook(ingestedIds, { expectedCalls: Number(!unauthorizedCommand) });
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it.each([
    ["provider deny", { mode: "deny" }, undefined, undefined, false, 92073],
    [
      "conversation deny",
      { mode: "allow", denyIn: ["-100456"] },
      undefined,
      undefined,
      false,
      92074,
    ],
    ["topic deny", { mode: "allow", denyIn: [TELEGRAM_TEST_TOPIC] }, undefined, 42, false, 92075],
    ["topic allow", { mode: "deny", allowIn: [TELEGRAM_TEST_TOPIC] }, undefined, 42, true, 92076],
    ["account deny", { mode: "allow" }, { mode: "deny" }, undefined, false, 92077],
    [
      "account topic allow",
      { mode: "deny" },
      { mode: "deny", allowIn: [TELEGRAM_TEST_TOPIC] },
      42,
      true,
      92078,
    ],
  ] as TelegramMentionCaseForTest[])(
    "applies %s before classifying group media mentions (#92067)",
    async (_name, providerPolicy, accountPolicy, topicId, shouldWarn, messageId) => {
      setTelegramIngestGroupConfig({
        customMentionPatterns: true,
        providerPolicy,
        accountPolicy,
      });
      createTelegramBot({ token: "tok", ...(accountPolicy ? { accountId: "work" } : {}) });
      await dispatchTelegramGroupPhoto({
        messageId,
        topicId,
        caption: "bert, see attachment",
        getFile: async () => {
          throw new Error("Network request for 'getFile' failed!");
        },
      });
      const expectedWarnings = Number(shouldWarn);
      expect(sendMessageSpy).toHaveBeenCalledTimes(expectedWarnings);
      expect(replySpy).toHaveBeenCalledTimes(expectedWarnings);
      expect(sendMessageSpy.mock.calls[0]?.[1]).toEqual(
        [undefined, "⚠️ Failed to download media. Please try again."][expectedWarnings],
      );
      expectTelegramIngestHook([], {
        content: "bert, see attachment",
        expectedCalls: Number(!shouldWarn),
      });
    },
  );

  it.each([
    {
      name: "a native mention",
      messageId: 81182,
      caption: "@openclaw_bot check this",
      ingest: false,
    },
    {
      name: "a native mention with ingestion",
      messageId: 81186,
      caption: "@openclaw_bot check this",
      ingest: true,
    },
    {
      name: "a native mention with denied patterns",
      messageId: 81185,
      caption: "@openclaw_bot check this",
      ingest: true,
      denyPatterns: true,
    },
    {
      name: "a targeted bot command",
      messageId: 81184,
      caption: "/inspect@openclaw_bot",
      extraMessage: { caption_entities: [{ type: "bot_command", offset: 0, length: 21 }] },
      ingest: false,
    },
    {
      name: "a reply to the bot",
      messageId: 81183,
      extraMessage: {
        reply_to_message: {
          message_id: 99,
          text: "previous bot reply",
          from: { id: 999, is_bot: true, first_name: "OpenClaw" },
        },
      },
      ingest: false,
    },
  ])("preserves visible media failures for $name (#92067)", async (testCase) => {
    setTelegramIngestGroupConfig({
      groups: { "*": { requireMention: true, ...(testCase.ingest ? { ingest: true } : {}) } },
      ...("denyPatterns" in testCase ? { providerPolicy: { mode: "deny" } } : {}),
    });
    saveRemoteMedia.mockRejectedValueOnce(new MediaFetchError("fetch_failed", "ECONNRESET"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));
    try {
      createTelegramBot({ token: "tok" });
      await dispatchTelegramGroupPhoto({
        messageId: testCase.messageId,
        ...("caption" in testCase ? { caption: testCase.caption } : {}),
        ...("extraMessage" in testCase ? { extraMessage: testCase.extraMessage } : {}),
      });
      await waitForTelegramMockCalls(sendMessageSpy, 1);
      expect(sendMessageSpy).toHaveBeenCalledWith(
        -100456,
        "⚠️ Failed to download media. Please try again.",
        expect.objectContaining({
          reply_parameters: expect.objectContaining({
            message_id: testCase.messageId,
            allow_sending_without_reply: true,
          }),
        }),
      );
      expect(replySpy).toHaveBeenCalledOnce();
      expectTypeOnlyMediaPayload("image", "caption" in testCase ? testCase.caption : "");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    { failure: "shutdown aborts a download", shutdownAbort: true },
    { failure: "Telegram temporarily throttles a download", shutdownAbort: false },
  ])("durably retries every spooled album update when $failure", async ({ shutdownAbort }) => {
    setOpenChannelPostConfig();
    const shutdown = new AbortController();
    saveRemoteMedia.mockImplementationOnce(async () => {
      if (shutdownAbort) {
        shutdown.abort();
        const cause = Object.assign(new Error("aborted"), { name: "AbortError" });
        throw new MediaFetchError("fetch_failed", "aborted", { cause });
      }
      throw new MediaFetchError("http_error", "rate limited", { status: 429 });
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        fetchAbortSignal: shutdown.signal,
      });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      const runs = await Promise.all(
        [98079, 98080].map((messageId, index) => {
          const update = { update_id: messageId };
          return runWithTelegramSpooledReplayUpdate(update, () =>
            handler({
              ...createChannelPostContext({
                messageId,
                ...(index === 0 ? { caption: "shutdown album" } : {}),
                date: 1736380800 + index,
                mediaGroupId: "shutdown-album-1",
                photoFileId: `p${index + 1}`,
              }),
              update,
            }),
          );
        }),
      );
      expect(runs.map(({ deferredWork }) => Boolean(deferredWork))).toEqual([true, true]);
      await flushChannelPostMediaGroup(setTimeoutSpy);
      expect(await Promise.all(runs.map(({ deferredWork }) => deferredWork!.task))).toEqual([
        { kind: "failed-retryable", error: expect.any(MediaFetchError) },
        { kind: "failed-retryable", error: expect.any(MediaFetchError) },
      ]);
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each([
    { name: "a photo download fails", firstMessageId: 401, abort: false },
    { name: "classic polling aborts a download", firstMessageId: 98081, abort: true },
  ])("keeps live album delivery when $name", async ({ firstMessageId, abort }) => {
    setOpenChannelPostConfig();
    const shutdown = new AbortController();
    const mediaPath = "/tmp/live-album-first.jpg";
    saveRemoteMedia
      .mockResolvedValueOnce({ path: mediaPath, contentType: "image/jpeg" })
      .mockImplementationOnce(() => rejectTelegramAlbumDownload(shutdown, abort));
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        fetchAbortSignal: shutdown.signal,
      });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      await queueChannelPostAlbum(handler, {
        caption: "live partial album",
        mediaGroupId: `live-album-${firstMessageId}`,
        firstMessageId,
        secondMessageId: firstMessageId + 1,
      });
      await flushChannelPostMediaGroup(setTimeoutSpy);
      await waitForTelegramMockCalls(replySpy, 1);

      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replyPayload()).toMatchObject({
        Body: expect.stringContaining("live partial album"),
        media: [
          expect.objectContaining({ path: mediaPath }),
          expect.objectContaining({ path: undefined }),
        ],
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("drops the media group when a non-recoverable media error occurs", async () => {
    replySpy.mockReset();
    setOpenChannelPostConfig();
    saveRemoteMedia.mockResolvedValueOnce({
      path: "/tmp/fatal-album-first.jpg",
      contentType: "image/jpeg",
    });

    const runtimeError = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      createTelegramBot({
        token: "tok",
        testTimings: TELEGRAM_TEST_TIMINGS,
        runtime: { error: runtimeError } as unknown as RuntimeEnv,
      });
      const handler = getOnHandler("channel_post") as (
        ctx: Record<string, unknown>,
      ) => Promise<void>;
      await queueChannelPostAlbum(handler, {
        caption: "fatal album",
        mediaGroupId: "fatal-album-1",
        firstMessageId: 501,
        secondMessageId: 502,
        secondGetFileResult: {},
      });
      expect(replySpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroup(setTimeoutSpy);

      await vi.waitFor(() =>
        expect(runtimeError).toHaveBeenCalledWith(
          expect.stringContaining("media group handler failed"),
        ),
      );
      expect(runtimeError).toHaveBeenCalledWith(
        expect.stringContaining("Telegram getFile returned no file_path"),
      );
      expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
