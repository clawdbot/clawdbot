// Telegram tests cover bot.create telegram bot.channel post media plugin behavior.
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const saveRemoteMedia = vi.fn();
const saveMediaBuffer = vi.fn();
const readRemoteMediaBuffer = vi.fn();
const rootRead = vi.fn();

vi.mock("openclaw/plugin-sdk/file-access-runtime", () => ({
  root: async (rootDir: string) => ({
    read: async (relativePath: string, options?: { maxBytes?: number }) =>
      await rootRead({ rootDir, relativePath, maxBytes: options?.maxBytes }),
  }),
}));

vi.mock("./bot/delivery.resolve-media.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-runtime")>(
    "openclaw/plugin-sdk/media-runtime",
  );
  return {
    readRemoteMediaBuffer: (...args: unknown[]) => readRemoteMediaBuffer(...args),
    formatErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    logVerbose: () => {},
    MediaFetchError: actual.MediaFetchError,
    resolveTelegramApiBase: (apiRoot?: string) =>
      apiRoot?.trim() ? apiRoot.replace(/\/+$/u, "") : "https://api.telegram.org",
    retryAsync: async (fn: () => unknown) => await fn(),
    saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
    saveRemoteMedia: async (...args: unknown[]) => {
      try {
        return await saveRemoteMedia(...args);
      } catch (err) {
        if (err instanceof actual.MediaFetchError) {
          throw err;
        }
        throw new actual.MediaFetchError(
          "fetch_failed",
          err instanceof Error ? err.message : String(err),
          { cause: err },
        );
      }
    },
    shouldRetryTelegramTransportFallback: vi.fn(() => false),
    warn: (s: string) => s,
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
        groups: {
          "-100777111222": {
            enabled: true,
            requireMention: false,
          },
        },
      },
    },
  });
}

function getChannelPostHandler() {
  createTelegramBot({ token: "tok", testTimings: TELEGRAM_TEST_TIMINGS });
  return getOnHandler("channel_post") as (ctx: Record<string, unknown>) => Promise<void>;
}

function resolveFlushTimer(setTimeoutSpy: ReturnType<typeof vi.spyOn>) {
  return resolveFlushTimerForDelay(setTimeoutSpy, TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs);
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

async function waitForBufferedProcessing() {
  await delay(75);
}

async function waitForMockCalls(mock: { mock: { calls: unknown[] } }, count: number) {
  for (let index = 0; index < 80; index++) {
    if (mock.mock.calls.length >= count) {
      return;
    }
    await delay(25);
  }
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
  const flushTimer = resolveFlushTimer(setTimeoutSpy);
  expect(flushTimer).toBeTypeOf("function");
  await flushTimer?.();
  await waitForBufferedProcessing();
}

async function flushChannelPostMediaGroupForDelay(
  setTimeoutSpy: ReturnType<typeof vi.spyOn>,
  delayMs: number,
) {
  const flushTimer = resolveFlushTimerForDelay(setTimeoutSpy, delayMs);
  expect(flushTimer).toBeTypeOf("function");
  await flushTimer?.();
  await waitForBufferedProcessing();
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
  const first = handler(
    createChannelPostContext({
      messageId: params.firstMessageId,
      caption: params.caption,
      date: 1736380800,
      mediaGroupId: params.mediaGroupId,
      photoFileId: params.firstPhotoFileId ?? "p1",
    }),
  );
  const second = handler(
    createChannelPostContext({
      messageId: params.secondMessageId,
      date: 1736380801,
      mediaGroupId: params.mediaGroupId,
      photoFileId: params.secondPhotoFileId ?? "p2",
      getFileResult: params.secondGetFileResult,
    }),
  );
  await Promise.all([first, second]);
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
  const media = payload.media as Array<{ path?: string }>;
  expect(media).toHaveLength(1);
  expect(media[0]?.path).toBeUndefined();
}

describe("createTelegramBot channel_post media", () => {
  beforeAll(() => {
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
  });

  beforeEach(() => {
    saveRemoteMedia.mockReset();
    saveRemoteMedia.mockImplementation(
      async (params: { fetchImpl: typeof fetch; maxBytes: number; url: string }) => {
        const response = await params.fetchImpl(params.url);
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.length > params.maxBytes) {
          throw new Error(`media exceeds ${params.maxBytes} MB limit`);
        }
        return {
          path: "/tmp/telegram-media.bin",
          contentType: response.headers.get("content-type"),
        };
      },
    );
    saveMediaBuffer.mockReset();
    readRemoteMediaBuffer.mockReset();
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
      await waitForMockCalls(replySpy, 1);

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
      const handler = getChannelPostHandler();

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
      await flushChannelPostMediaGroupForDelay(
        setTimeoutSpy,
        TELEGRAM_TEST_TIMINGS.textFragmentGapMs,
      );

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
    expectTypeOnlyMediaPayload("image");
    fetchSpy.mockRestore();
  });

  it("notifies users when media download fails for direct messages", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: { dmPolicy: "open", allowFrom: ["*"] },
      },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    saveRemoteMedia.mockRejectedValueOnce(new Error("MediaFetchError: Failed to fetch media"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("MediaFetchError: Failed to fetch media");
    });

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: 411,
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: 55, is_bot: false, first_name: "u" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });
      await waitForMockCalls(sendMessageSpy, 1);

      expect(sendMessageSpy).toHaveBeenCalledWith(
        1234,
        "⚠️ Failed to download media. Please try again.",
        {
          reply_parameters: {
            message_id: 411,
            allow_sending_without_reply: true,
          },
        },
      );
      expect(replySpy).toHaveBeenCalledOnce();
      expectTypeOnlyMediaPayload("image");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("warns and dispatches a type-only fact when Telegram getFile fails (#100000)", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 100000,
        date: 1736380800,
        document: { file_id: "doc-100000", file_name: "report.pdf" },
        from: { id: 55, is_bot: false, first_name: "u" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => {
        throw new Error("Network request for 'getFile' failed!");
      },
    });

    await waitForMockCalls(sendMessageSpy, 1);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      "⚠️ Failed to download media. Please try again.",
      expect.objectContaining({
        reply_parameters: expect.objectContaining({ message_id: 100000 }),
      }),
    );
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
      loadConfig.mockReturnValue({
        channels: { telegram: { dmPolicy: "open", allowFrom: ["*"], mediaMaxMb } },
      });
      sendMessageSpy.mockClear();
      replySpy.mockClear();

      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      const messageId = 100001 + expectedLimitMb;
      await handler({
        message: {
          chat: { id: 1234, type: "private" },
          message_id: messageId,
          date: 1736380800,
          document: { file_id: "doc-100001", file_name: "large.bin" },
          from: { id: 55, is_bot: false, first_name: "u" },
        },
        me: { username: "openclaw_bot" },
        getFile: async () => {
          throw new Error("Bad Request: file is too big");
        },
      });

      await waitForMockCalls(sendMessageSpy, 1);
      expect(sendMessageSpy).toHaveBeenCalledWith(
        1234,
        `⚠️ File too large. Maximum size is ${expectedLimitMb}MB.`,
        expect.objectContaining({
          reply_parameters: expect.objectContaining({ message_id: messageId }),
        }),
      );
      expect(replySpy).toHaveBeenCalledOnce();
      expectTypeOnlyMediaPayload("document");
      expect(saveRemoteMedia).not.toHaveBeenCalled();
    },
  );

  it("durably retries a spooled-replay shutdown-abort document fetch without warning (#98076)", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    saveRemoteMedia.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const update = { update_id: 98076 };
    const ctx = {
      update,
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 98076,
        date: 1736380800,
        document: { file_id: "doc-1", file_name: "report.pdf" },
        from: { id: 55, is_bot: false, first_name: "u" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ file_path: "documents/doc-1" }),
    };

    const { result } = await runWithTelegramUpdateProcessingFrame(() =>
      withTelegramSpooledReplayUpdate(update, () => handler(ctx)),
    );

    expect(result).toEqual({ kind: "failed-retryable", error: expect.any(MediaFetchError) });
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("acks and warns a permanent media failure even on spooled replay (#98076)", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    saveRemoteMedia.mockRejectedValue(
      new MediaFetchError("max_bytes", "Failed to fetch media: payload exceeds maxBytes 10"),
    );

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const update = { update_id: 98077 };
    const ctx = {
      update,
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 98077,
        date: 1736380800,
        document: { file_id: "doc-2", file_name: "huge.pdf" },
        from: { id: 55, is_bot: false, first_name: "u" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ file_path: "documents/doc-2" }),
    };

    const { result } = await runWithTelegramUpdateProcessingFrame(() =>
      withTelegramSpooledReplayUpdate(update, () => handler(ctx)),
    );

    expect(result).toEqual({ kind: "completed" });
    await waitForMockCalls(sendMessageSpy, 1);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      "⚠️ Failed to download media. Please try again.",
      expect.objectContaining({
        reply_parameters: expect.objectContaining({ message_id: 98077 }),
      }),
    );
    expect(replySpy).toHaveBeenCalledOnce();
    expectTypeOnlyMediaPayload("document");
  });

  it("acks and warns a permanent fetch_failed (guard/SSRF) on spooled replay (#98076)", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    });
    sendMessageSpy.mockClear();
    replySpy.mockClear();
    saveRemoteMedia.mockRejectedValue(new Error("blocked by SSRF guard: private address"));

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
    const update = { update_id: 98078 };
    const ctx = {
      update,
      message: {
        chat: { id: 1234, type: "private" },
        message_id: 98078,
        date: 1736380800,
        document: { file_id: "doc-3", file_name: "blocked.pdf" },
        from: { id: 55, is_bot: false, first_name: "u" },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ file_path: "documents/doc-3" }),
    };

    const { result } = await runWithTelegramUpdateProcessingFrame(() =>
      withTelegramSpooledReplayUpdate(update, () => handler(ctx)),
    );

    expect(result).toEqual({ kind: "completed" });
    await waitForMockCalls(sendMessageSpy, 1);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      1234,
      "⚠️ Failed to download media. Please try again.",
      expect.objectContaining({
        reply_parameters: expect.objectContaining({ message_id: 98078 }),
      }),
    );
    expect(replySpy).toHaveBeenCalledOnce();
    expectTypeOnlyMediaPayload("document");
  });

  it("skips unmentioned requireMention group media before downloading (#81181)", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });
    const getFile = vi.fn(async () => ({ file_path: "photos/p1.jpg" }));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("unexpected media download");
    });

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: -100456, type: "supergroup", title: "Ops Chat" },
          message_id: 81181,
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: 55, is_bot: false, first_name: "u" },
        },
        me: { id: 999, username: "openclaw_bot" },
        getFile,
      });

      expect(getFile).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("notifies mentioned requireMention groups when media download fails", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("MediaFetchError: ECONNRESET"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("MediaFetchError: ECONNRESET");
    });

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: -100456, type: "supergroup", title: "Ops Chat" },
          message_id: 81182,
          date: 1736380800,
          caption: "@openclaw_bot check this",
          photo: [{ file_id: "p1" }],
          from: { id: 55, is_bot: false, first_name: "u" },
        },
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });
      await waitForMockCalls(sendMessageSpy, 1);

      expect(sendMessageSpy).toHaveBeenCalledWith(
        -100456,
        "⚠️ Failed to download media. Please try again.",
        {
          reply_parameters: {
            message_id: 81182,
            allow_sending_without_reply: true,
          },
        },
      );
      expect(replySpy).toHaveBeenCalledOnce();
      expectTypeOnlyMediaPayload("image", "@openclaw_bot check this");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("treats targeted bot command captions as mentions before media download", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("MediaFetchError: ECONNRESET"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("MediaFetchError: ECONNRESET");
    });

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;
      const caption = "/inspect@openclaw_bot";

      await handler({
        message: {
          chat: { id: -100456, type: "supergroup", title: "Ops Chat" },
          message_id: 81184,
          date: 1736380800,
          caption,
          caption_entities: [{ type: "bot_command", offset: 0, length: caption.length }],
          photo: [{ file_id: "p1" }],
          from: { id: 55, is_bot: false, first_name: "u" },
        },
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });
      await waitForMockCalls(sendMessageSpy, 1);

      expect(sendMessageSpy).toHaveBeenCalledWith(
        -100456,
        "⚠️ Failed to download media. Please try again.",
        {
          reply_parameters: {
            message_id: 81184,
            allow_sending_without_reply: true,
          },
        },
      );
      expect(replySpy).toHaveBeenCalledOnce();
      expectTypeOnlyMediaPayload("image", caption);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("notifies requireMention group replies to the bot when media download fails", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
      },
    });
    saveRemoteMedia.mockRejectedValueOnce(new Error("MediaFetchError: ECONNRESET"));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("MediaFetchError: ECONNRESET");
    });

    try {
      createTelegramBot({ token: "tok" });
      const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

      await handler({
        message: {
          chat: { id: -100456, type: "supergroup", title: "Ops Chat" },
          message_id: 81183,
          date: 1736380800,
          photo: [{ file_id: "p1" }],
          from: { id: 55, is_bot: false, first_name: "u" },
          reply_to_message: {
            message_id: 99,
            text: "previous bot reply",
            from: { id: 999, is_bot: true, first_name: "OpenClaw" },
          },
        },
        me: { id: 999, username: "openclaw_bot" },
        getFile: async () => ({ file_path: "photos/p1.jpg" }),
      });
      await waitForMockCalls(sendMessageSpy, 1);

      expect(sendMessageSpy).toHaveBeenCalledWith(
        -100456,
        "⚠️ Failed to download media. Please try again.",
        {
          reply_parameters: {
            message_id: 81183,
            allow_sending_without_reply: true,
          },
        },
      );
      expect(replySpy).toHaveBeenCalledOnce();
      expectTypeOnlyMediaPayload("image");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("processes remaining media group photos when one photo download fails", async () => {
    replySpy.mockReset();
    setOpenChannelPostConfig();

    let fetchCallIndex = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      fetchCallIndex++;
      if (fetchCallIndex === 2) {
        throw new Error("MediaFetchError: Failed to fetch media");
      }
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();
      await queueChannelPostAlbum(handler, {
        caption: "partial album",
        mediaGroupId: "partial-album-1",
        firstMessageId: 401,
        secondMessageId: 402,
      });
      expect(replySpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroup(setTimeoutSpy);
      await waitForMockCalls(replySpy, 1);

      await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
      const payload = replyPayload() as { Body?: string };
      expect(payload.Body).toContain("partial album");
    } finally {
      setTimeoutSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  it("durably retries every spooled album update when shutdown aborts a download", async () => {
    setOpenChannelPostConfig();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    const shutdown = new AbortController();
    saveRemoteMedia.mockImplementationOnce(async () => {
      shutdown.abort();
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
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
      const firstUpdate = { update_id: 98079 };
      const secondUpdate = { update_id: 98080 };
      const first = await runWithTelegramSpooledReplayUpdate(firstUpdate, () =>
        handler({
          ...createChannelPostContext({
            messageId: 98079,
            caption: "shutdown album",
            date: 1736380800,
            mediaGroupId: "shutdown-album-1",
            photoFileId: "p1",
          }),
          update: firstUpdate,
        }),
      );
      const second = await runWithTelegramSpooledReplayUpdate(secondUpdate, () =>
        handler({
          ...createChannelPostContext({
            messageId: 98080,
            date: 1736380801,
            mediaGroupId: "shutdown-album-1",
            photoFileId: "p2",
          }),
          update: secondUpdate,
        }),
      );

      expect(first.deferredWork).toBeDefined();
      expect(second.deferredWork).toBeDefined();
      if (!first.deferredWork || !second.deferredWork) {
        throw new Error("Expected both album updates to register durable replay work");
      }
      await flushChannelPostMediaGroup(setTimeoutSpy);

      const [firstResult, secondResult] = await Promise.all([
        first.deferredWork.task,
        second.deferredWork.task,
      ]);
      expect(firstResult).toEqual({
        kind: "failed-retryable",
        error: expect.any(MediaFetchError),
      });
      expect(secondResult).toEqual({
        kind: "failed-retryable",
        error: expect.any(MediaFetchError),
      });
      expect(sendMessageSpy).not.toHaveBeenCalled();
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("keeps live album delivery when classic polling aborts a download", async () => {
    setOpenChannelPostConfig();
    sendMessageSpy.mockClear();
    replySpy.mockClear();

    const shutdown = new AbortController();
    saveRemoteMedia
      .mockImplementationOnce(async () => ({
        path: "/tmp/classic-restart-first.jpg",
        contentType: "image/jpeg",
      }))
      .mockImplementationOnce(async () => {
        shutdown.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
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
      await queueChannelPostAlbum(handler, {
        caption: "classic restart album",
        mediaGroupId: "classic-restart-album-1",
        firstMessageId: 98081,
        secondMessageId: 98082,
      });
      await flushChannelPostMediaGroup(setTimeoutSpy);
      await waitForMockCalls(replySpy, 1);

      expect(replySpy).toHaveBeenCalledTimes(1);
      expect(replyPayload()).toMatchObject({
        Body: expect.stringContaining("classic restart album"),
        media: [
          expect.objectContaining({ path: "/tmp/classic-restart-first.jpg" }),
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
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
