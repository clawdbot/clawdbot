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
const {
  getLoadConfigMock,
  getOnHandler,
  replySpy,
  sendMessageSpy,
  telegramBotDepsForTest,
  telegramBotRuntimeForTest,
} = harness;
const { createTelegramBotCore: createTelegramBotBase, setTelegramBotRuntimeForTest } =
  await import("./bot-core.js");

let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();

const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

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

function getChannelPostHandlerWithRuntimeTimings() {
  createTelegramBot({ token: "tok" });
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

describe("createTelegramBot channel_post media", () => {
  beforeAll(() => {
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
  });

  beforeEach(() => {
    setTelegramBotRuntimeForTest(
      telegramBotRuntimeForTest as unknown as Parameters<typeof setTelegramBotRuntimeForTest>[0],
    );
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

  it("honors configured mediaGroupFlushMs for channel_post albums", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          groupPolicy: "open",
          mediaGroupFlushMs: 75,
          groups: {
            "-100777111222": {
              enabled: true,
              requireMention: false,
            },
          },
        },
      },
    });

    const fetchSpy = createImageFetchSpy();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandlerWithRuntimeTimings();
      await queueChannelPostAlbum(handler, {
        caption: "configured album",
        mediaGroupId: "channel-album-configured",
        firstMessageId: 211,
        secondMessageId: 212,
      });
      expect(replySpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroupForDelay(setTimeoutSpy, 75);
      await waitForMockCalls(replySpy, 1);

      await vi.waitFor(() => expect(replySpy).toHaveBeenCalledTimes(1));
      const payload = replyPayload() as { Body?: string };
      expect(payload.Body).toContain("configured album");
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

  it("drops oversized channel_post media instead of dispatching a placeholder message", async () => {
    setOpenChannelPostConfig();

    const fetchSpy = createImageFetchSpy({
      body: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
      contentType: "image/jpeg",
    });

    createTelegramBot({ token: "tok", mediaMaxMb: 0 });
    const handler = getOnHandler("channel_post") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler(
      createChannelPostContext({
        messageId: 401,
        date: 1736380800,
        photoFileId: "oversized",
      }),
    );

    expect(replySpy).not.toHaveBeenCalled();
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
      expect(replySpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
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
      expect(replySpy).not.toHaveBeenCalled();
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
      expect(replySpy).not.toHaveBeenCalled();
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
      expect(replySpy).not.toHaveBeenCalled();
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
