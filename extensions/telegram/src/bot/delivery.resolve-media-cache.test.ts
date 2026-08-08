import type { Message } from "grammy/types";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
// Telegram tests cover delivery.resolve media plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMedia } from "./delivery.resolve-media.js";
import type { TelegramContext } from "./types.js";

const saveRemoteMedia = vi.fn();

vi.mock("./delivery.resolve-media.runtime.js", () => {
  class MediaFetchError extends Error {
    code: string;
    status?: number;

    constructor(code: string, message: string, options?: { cause?: unknown; status?: number }) {
      super(message, options);
      this.name = "MediaFetchError";
      this.code = code;
      this.status = options?.status;
    }
  }
  return {
    formatErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    logVerbose: () => {},
    MediaFetchError,
    resolveTelegramApiBase: (apiRoot?: string) =>
      apiRoot?.trim() ? apiRoot.replace(/\/+$/u, "") : "https://api.telegram.org",
    sleepWithAbort,
    saveMediaBuffer: vi.fn(),
    saveRemoteMedia: (...args: unknown[]) => saveRemoteMedia(...args),
    shouldRetryTelegramTransportFallback: vi.fn(() => false),
  };
});

vi.mock("../sticker-cache.js", () => ({
  cacheSticker: () => {},
  getCachedSticker: () => null,
  getCacheStats: () => ({ count: 0 }),
  searchStickers: () => [],
  getAllCachedStickers: () => [],
  describeStickerImage: async () => null,
}));

const BOT_TOKEN = "tok123";
const FILE_SIZE = 8;

let downloadCount = 0;

beforeEach(() => {
  downloadCount = 0;
});

function makeCtx(fileUniqueId: string, getFile: TelegramContext["getFile"]): TelegramContext {
  const msg: Record<string, unknown> = {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: "private" },
    photo: [{ file_id: `${fileUniqueId}-id`, file_unique_id: fileUniqueId }],
  };
  return {
    message: msg as unknown as Message,
    me: {
      id: 1,
      is_bot: true,
      first_name: "bot",
      username: "bot",
    } as unknown as TelegramContext["me"],
    getFile,
  };
}

function mockNextDownload() {
  downloadCount += 1;
  const path = `/media/inbound/file-${downloadCount}.jpg`;
  saveRemoteMedia.mockImplementationOnce(async (params: { maxBytes?: number }) => {
    // Emulate the real save path: the download enforces the caller's limit.
    if (typeof params?.maxBytes === "number" && FILE_SIZE > params.maxBytes) {
      throw new Error(`Media exceeds ${params.maxBytes} limit`);
    }
    return { path, size: FILE_SIZE, contentType: "image/jpeg" };
  });
  return path;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveMedia media file cache", () => {
  it("reuses the session download when the same file is resolved again", async () => {
    saveRemoteMedia.mockReset();
    const getFile = vi.fn().mockResolvedValue({ file_path: "media/reuse.jpg" });
    mockNextDownload();

    const first = await resolveMedia({
      ctx: makeCtx("reuse-u1", getFile),
      maxBytes: 1024,
      token: BOT_TOKEN,
    });
    const second = await resolveMedia({
      ctx: makeCtx("reuse-u1", getFile),
      maxBytes: 1024,
      token: BOT_TOKEN,
    });

    expect(first?.path).toBe("/media/inbound/file-1.jpg");
    expect(second).toEqual(first);
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
  });

  it("enforces the caller media limit on cache hits without evicting the entry", async () => {
    saveRemoteMedia.mockReset();
    const getFile = vi.fn().mockResolvedValue({ file_path: "media/limit.jpg" });
    mockNextDownload();

    // The first account's larger limit admits and caches the file.
    const first = await resolveMedia({
      ctx: makeCtx("limit-u1", getFile),
      maxBytes: 1024,
      token: BOT_TOKEN,
    });
    expect(first?.path).toBe("/media/inbound/file-1.jpg");
    expect(getFile).toHaveBeenCalledTimes(1);

    // A second account enforcing a smaller limit must not reuse the cached
    // file; it falls back to the download path, which rejects the oversize
    // file exactly as it does without the cache.
    mockNextDownload();
    await expect(
      resolveMedia({
        ctx: makeCtx("limit-u1", getFile),
        maxBytes: FILE_SIZE - 1,
        token: BOT_TOKEN,
      }),
    ).rejects.toThrow(/exceeds/);
    expect(getFile).toHaveBeenCalledTimes(2);
    expect(saveRemoteMedia).toHaveBeenCalledTimes(2);

    // The rejected attempt never touches the cache: the original
    // larger-limit caller still hits the retained entry.
    const third = await resolveMedia({
      ctx: makeCtx("limit-u1", getFile),
      maxBytes: 1024,
      token: BOT_TOKEN,
    });
    expect(third).toEqual(first);
    expect(getFile).toHaveBeenCalledTimes(2);
    expect(saveRemoteMedia).toHaveBeenCalledTimes(2);
  });

  it("re-downloads after the cache entry expires", async () => {
    vi.useFakeTimers();
    saveRemoteMedia.mockReset();
    const getFile = vi.fn().mockResolvedValue({ file_path: "media/expiry.jpg" });
    mockNextDownload();

    const first = await resolveMedia({
      ctx: makeCtx("expiry-u1", getFile),
      maxBytes: 1024,
      token: BOT_TOKEN,
    });
    expect(getFile).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(56 * 60_000);

    mockNextDownload();
    const second = await resolveMedia({
      ctx: makeCtx("expiry-u1", getFile),
      maxBytes: 1024,
      token: BOT_TOKEN,
    });
    expect(second?.path).toBe("/media/inbound/file-2.jpg");
    expect(second?.path).not.toBe(first?.path);
    expect(getFile).toHaveBeenCalledTimes(2);
    expect(saveRemoteMedia).toHaveBeenCalledTimes(2);
  });
});
