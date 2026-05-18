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
  const actual = await vi.importActual<typeof import("../src/telegram-media.runtime.js")>(
    "./telegram-media.runtime.js",
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
    saveRemoteMedia: (...args: unknown[]) => saveRemoteMedia(...args),
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
const { MediaFetchError } = await import("./telegram-media.runtime.js");

let createTelegramBot: (
  opts: import("./bot.types.js").TelegramBotOptions,
) => ReturnType<typeof import("./bot-core.js").createTelegramBotCore>;

const loadConfig = getLoadConfigMock();

const TELEGRAM_TEST_TIMINGS = {
  mediaGroupFlushMs: 20,
  textFragmentGapMs: 30,
} as const;

const CHANNEL_ID = -100777111222;

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
  const delayMs = TELEGRAM_TEST_TIMINGS.mediaGroupFlushMs;
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

async function flushChannelPostMediaGroup(setTimeoutSpy: ReturnType<typeof vi.spyOn>) {
  const flushTimer = resolveFlushTimer(setTimeoutSpy);
  expect(flushTimer).toBeTypeOf("function");
  await flushTimer?.();
}

function createChannelPostContext(params: {
  messageId: number;
  date: number;
  caption?: string;
  mediaGroupId: string;
  photoFileId: string;
}) {
  return {
    channelPost: {
      chat: { id: CHANNEL_ID, type: "channel", title: "Wake Channel" },
      message_id: params.messageId,
      date: params.date,
      ...(params.caption ? { caption: params.caption } : {}),
      media_group_id: params.mediaGroupId,
      photo: [{ file_id: params.photoFileId }],
    },
    me: { username: "openclaw_bot" },
    getFile: async () => ({ file_path: `photos/${params.photoFileId}.jpg` }),
  };
}

async function queueChannelPostAlbum(
  handler: (ctx: Record<string, unknown>) => Promise<void>,
  params: { caption: string; mediaGroupId: string; photoFileIds: string[] },
) {
  const baseMessageId = 600;
  const calls = params.photoFileIds.map((fileId, index) =>
    handler(
      createChannelPostContext({
        messageId: baseMessageId + index,
        date: 1736380800 + index,
        ...(index === 0 ? { caption: params.caption } : {}),
        mediaGroupId: params.mediaGroupId,
        photoFileId: fileId,
      }),
    ),
  );
  await Promise.all(calls);
  return baseMessageId;
}

function urlOf(args: unknown[]): string {
  const opts = args[0];
  if (opts && typeof opts === "object" && "url" in opts) {
    return String((opts as { url: unknown }).url);
  }
  return "";
}

describe("createTelegramBot media-group skip warning (#55216)", () => {
  beforeAll(() => {
    createTelegramBot = (opts) =>
      createTelegramBotBase({
        ...opts,
        telegramDeps: telegramBotDepsForTest,
      });
    setTelegramBotRuntimeForTest(telegramBotRuntimeForTest);
  });

  beforeEach(() => {
    setTelegramBotRuntimeForTest(telegramBotRuntimeForTest);
    saveRemoteMedia.mockReset();
    saveMediaBuffer.mockReset();
    readRemoteMediaBuffer.mockReset();
    rootRead.mockReset();
    sendMessageSpy.mockClear();
    replySpy.mockClear();
  });

  it("warns the user once when an album drops some images", async () => {
    setOpenChannelPostConfig();
    saveRemoteMedia.mockImplementation(async (...args: unknown[]) => {
      const url = urlOf(args);
      if (url.includes("photos/p1.jpg")) {
        return { path: "/tmp/p1.jpg", contentType: "image/png" };
      }
      throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${url}`);
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();
      const baseMessageId = await queueChannelPostAlbum(handler, {
        caption: "album caption",
        mediaGroupId: "skip-warn-album-1",
        photoFileIds: ["p1", "p2"],
      });
      expect(sendMessageSpy).not.toHaveBeenCalled();
      await flushChannelPostMediaGroup(setTimeoutSpy);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      expect(sendMessageSpy).toHaveBeenCalledWith(
        CHANNEL_ID,
        expect.stringContaining("1 of 2 images"),
        expect.objectContaining({
          reply_parameters: expect.objectContaining({
            message_id: baseMessageId,
            allow_sending_without_reply: true,
          }),
        }),
      );
      const warningText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(warningText).toContain("1 could not be fetched and was skipped");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("warns the user when every album image fails", async () => {
    setOpenChannelPostConfig();
    saveRemoteMedia.mockImplementation(async (...args: unknown[]) => {
      throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${urlOf(args)}`);
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();
      await queueChannelPostAlbum(handler, {
        caption: "all-fail album",
        mediaGroupId: "skip-warn-album-2",
        photoFileIds: ["p1", "p2"],
      });
      await flushChannelPostMediaGroup(setTimeoutSpy);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const warningText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(warningText).toContain("0 of 2 images");
      expect(warningText).toContain("2 could not be fetched and were skipped");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("pluralizes correctly for 2+ skipped", async () => {
    setOpenChannelPostConfig();
    saveRemoteMedia.mockImplementation(async (...args: unknown[]) => {
      const url = urlOf(args);
      if (url.includes("photos/p1.jpg")) {
        return { path: "/tmp/p1.jpg", contentType: "image/png" };
      }
      throw new MediaFetchError("fetch_failed", `Failed to fetch media from ${url}`);
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const handler = getChannelPostHandler();
      await queueChannelPostAlbum(handler, {
        caption: "plural album",
        mediaGroupId: "skip-warn-album-3",
        photoFileIds: ["p1", "p2", "p3"],
      });
      await flushChannelPostMediaGroup(setTimeoutSpy);

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const warningText = String(sendMessageSpy.mock.calls[0]?.[1]);
      expect(warningText).toContain("1 of 3 images");
      expect(warningText).toContain("2 could not be fetched and were skipped");
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
