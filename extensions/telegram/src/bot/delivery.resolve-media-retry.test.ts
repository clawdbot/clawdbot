import type { Message } from "@grammyjs/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryAsync } from "../../../../src/infra/retry.js";
import { resolveMedia } from "./delivery.resolve-media.js";
import type { TelegramContext } from "./types.js";

const saveMediaBuffer = vi.fn();
const fetchRemoteMedia = vi.fn();
const readFileWithinRoot = vi.fn();

vi.mock("openclaw/plugin-sdk/infra-runtime", () => ({
  readFileWithinRoot: (...args: unknown[]) => readFileWithinRoot(...args),
}));

vi.mock("./delivery.resolve-media.runtime.js", () => {
  class MediaFetchError extends Error {
    code: string;

    constructor(code: string, message: string, options?: { cause?: unknown }) {
      super(message, options);
      this.name = "MediaFetchError";
      this.code = code;
    }
  }
  return {
    fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMedia(...args),
    formatErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    logVerbose: () => {},
    MediaFetchError,
    resolveTelegramApiBase: (apiRoot?: string) =>
      apiRoot?.trim() ? apiRoot.replace(/\/+$/u, "") : "https://api.telegram.org",
    retryAsync,
    saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
    shouldRetryTelegramTransportFallback: vi.fn(() => false),
    warn: (s: string) => s,
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

const MAX_MEDIA_BYTES = 10_000_000;
const BOT_TOKEN = "tok123";

function makeCtx(
  mediaField: "voice" | "audio" | "photo" | "video" | "document" | "animation" | "sticker",
  getFile: TelegramContext["getFile"],
  opts?: { file_name?: string; mime_type?: string },
): TelegramContext {
  const msg: Record<string, unknown> = {
    message_id: 1,
    date: 0,
    chat: { id: 1, type: "private" },
  };
  if (mediaField === "voice") {
    msg.voice = {
      file_id: "v1",
      duration: 5,
      file_unique_id: "u1",
      ...(opts?.mime_type && { mime_type: opts.mime_type }),
    };
  }
  if (mediaField === "audio") {
    msg.audio = {
      file_id: "a1",
      duration: 5,
      file_unique_id: "u2",
      ...(opts?.file_name && { file_name: opts.file_name }),
      ...(opts?.mime_type && { mime_type: opts.mime_type }),
    };
  }
  if (mediaField === "photo") {
    msg.photo = [{ file_id: "p1", width: 100, height: 100 }];
  }
  if (mediaField === "video") {
    msg.video = {
      file_id: "vid1",
      duration: 10,
      file_unique_id: "u3",
      ...(opts?.file_name && { file_name: opts.file_name }),
    };
  }
  if (mediaField === "document") {
    msg.document = {
      file_id: "d1",
      file_unique_id: "u4",
      ...(opts?.file_name && { file_name: opts.file_name }),
      ...(opts?.mime_type && { mime_type: opts.mime_type }),
    };
  }
  if (mediaField === "animation") {
    msg.animation = {
      file_id: "an1",
      duration: 3,
      file_unique_id: "u5",
      width: 200,
      height: 200,
      ...(opts?.file_name && { file_name: opts.file_name }),
    };
  }
  if (mediaField === "sticker") {
    msg.sticker = {
      file_id: "stk1",
      file_unique_id: "ustk1",
      type: "regular",
      width: 512,
      height: 512,
      is_animated: false,
      is_video: false,
    };
  }
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

function setupTransientGetFileRetry() {
  const getFile = vi
    .fn()
    .mockRejectedValueOnce(new Error("Network request for 'getFile' failed!"))
    .mockResolvedValueOnce({ file_path: "voice/file_0.oga" });

  fetchRemoteMedia.mockResolvedValueOnce({
    buffer: Buffer.from("audio"),
    contentType: "audio/ogg",
    fileName: "file_0.oga",
  });
  saveMediaBuffer.mockResolvedValueOnce({
    path: "/tmp/file_0.oga",
    contentType: "audio/ogg",
  });

  return getFile;
}

function mockPdfFetchAndSave(fileName: string | undefined) {
  fetchRemoteMedia.mockResolvedValueOnce({
    buffer: Buffer.from("pdf-data"),
    contentType: "application/pdf",
    fileName,
  });
  saveMediaBuffer.mockResolvedValueOnce({
    path: "/tmp/file_42---uuid.pdf",
    contentType: "application/pdf",
  });
}

function createFileTooBigError(): Error {
  return new Error("GrammyError: Call to 'getFile' failed! (400: Bad Request: file is too big)");
}

function resolveMediaWithDefaults(
  ctx: TelegramContext,
  overrides: Partial<Parameters<typeof resolveMedia>[0]> = {},
) {
  return resolveMedia({
    ctx,
    maxBytes: MAX_MEDIA_BYTES,
    token: BOT_TOKEN,
    ...overrides,
  });
}

async function expectTransientGetFileRetrySuccess() {
  const getFile = setupTransientGetFileRetry();
  const promise = resolveMediaWithDefaults(makeCtx("voice", getFile));
  await flushRetryTimers();
  const result = await promise;
  expect(getFile).toHaveBeenCalledTimes(2);
  expect(fetchRemoteMedia).toHaveBeenCalledWith(
    expect.objectContaining({
      url: `https://api.telegram.org/file/bot${BOT_TOKEN}/voice/file_0.oga`,
      ssrfPolicy: {
        allowRfc2544BenchmarkRange: true,
        hostnameAllowlist: ["api.telegram.org"],
      },
    }),
  );
  return result;
}

async function flushRetryTimers() {
  await vi.runAllTimersAsync();
}

describe("resolveMedia getFile retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchRemoteMedia.mockReset();
    saveMediaBuffer.mockReset();
    readFileWithinRoot.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries getFile on transient failure and succeeds on second attempt", async () => {
    const result = await expectTransientGetFileRetrySuccess();
    expect(result).toEqual(
      expect.objectContaining({ path: "/tmp/file_0.oga", placeholder: "<media:audio>" }),
    );
  });

  it.each(["voice", "photo", "video"] as const)(
    "returns null for %s when getFile exhausts retries so message is not dropped",
    async (mediaField) => {
      const getFile = vi.fn().mockRejectedValue(new Error("Network request for 'getFile' failed!"));

      const promise = resolveMediaWithDefaults(makeCtx(mediaField, getFile));
      await flushRetryTimers();
      const result = await promise;

      expect(getFile).toHaveBeenCalledTimes(3);
      expect(result).toBeNull();
    },
  );

  it("does not catch errors from fetchRemoteMedia (only getFile is retried)", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "voice/file_0.oga" });
    fetchRemoteMedia.mockRejectedValueOnce(new Error("download failed"));

    await expect(resolveMediaWithDefaults(makeCtx("voice", getFile))).rejects.toThrow(
      "download failed",
    );

    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it("does not retry 'file is too big' error (400 Bad Request) and returns null", async () => {
    // Simulate Telegram Bot API error when file exceeds 20MB limit.
    const fileTooBigError = createFileTooBigError();
    const getFile = vi.fn().mockRejectedValue(fileTooBigError);

    const result = await resolveMediaWithDefaults(makeCtx("video", getFile));

    // Should NOT retry - "file is too big" is a permanent error, not transient.
    expect(getFile).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it("does not retry 'file is too big' GrammyError instances and returns null", async () => {
    const fileTooBigError = new Error(
      "GrammyError: Call to 'getFile' failed! (400: Bad Request: file is too big)",
    );
    const getFile = vi.fn().mockRejectedValue(fileTooBigError);

    const result = await resolveMediaWithDefaults(makeCtx("video", getFile));

    expect(getFile).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it.each(["audio", "voice"] as const)(
    "returns null for %s when file is too big",
    async (mediaField) => {
      const getFile = vi.fn().mockRejectedValue(createFileTooBigError());

      const result = await resolveMediaWithDefaults(makeCtx(mediaField, getFile));

      expect(getFile).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    },
  );

  it("throws when getFile returns no file_path", async () => {
    const getFile = vi.fn().mockResolvedValue({});
    await expect(resolveMediaWithDefaults(makeCtx("voice", getFile))).rejects.toThrow(
      "Telegram getFile returned no file_path",
    );
    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it("still retries transient errors even after encountering file too big in different call", async () => {
    const result = await expectTransientGetFileRetrySuccess();
    // Should retry transient errors.
    expect(result).not.toBeNull();
  });

  it("retries getFile for stickers on transient failure", async () => {
    const getFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network request for 'getFile' failed!"))
      .mockResolvedValueOnce({ file_path: "stickers/file_0.webp" });

    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker-data"),
      contentType: "image/webp",
      fileName: "file_0.webp",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/file_0.webp",
      contentType: "image/webp",
    });

    const ctx = makeCtx("sticker", getFile);
    const promise = resolveMediaWithDefaults(ctx);
    await flushRetryTimers();
    const result = await promise;

    expect(getFile).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({ path: "/tmp/file_0.webp", placeholder: "<media:sticker>" }),
    );
  });

  it("returns null for sticker when getFile exhausts retries", async () => {
    const getFile = vi.fn().mockRejectedValue(new Error("Network request for 'getFile' failed!"));

    const ctx = makeCtx("sticker", getFile);
    const promise = resolveMediaWithDefaults(ctx);
    await flushRetryTimers();
    const result = await promise;

    expect(getFile).toHaveBeenCalledTimes(3);
    expect(result).toBeNull();
  });

  it("uses caller-provided fetch impl for file downloads", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    const callerFetch = vi.fn() as unknown as typeof fetch;
    const dispatcherAttempts = [
      {
        dispatcherPolicy: {
          mode: "explicit-proxy" as const,
          proxyUrl: "http://localhost:6152",
          allowPrivateProxy: true,
        },
      },
    ];
    const callerTransport = {
      fetch: callerFetch,
      sourceFetch: callerFetch,
      dispatcherAttempts,
      close: async () => {},
    };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("pdf-data"),
      contentType: "application/pdf",
      fileName: "file_42.pdf",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/file_42---uuid.pdf",
      contentType: "application/pdf",
    });

    const result = await resolveMediaWithDefaults(makeCtx("document", getFile), {
      transport: callerTransport,
    });

    expect(result).not.toBeNull();
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchImpl: callerFetch,
        dispatcherAttempts,
        trustExplicitProxyDns: true,
        shouldRetryFetchError: expect.any(Function),
        readIdleTimeoutMs: 30_000,
        ssrfPolicy: {
          allowRfc2544BenchmarkRange: true,
          hostnameAllowlist: ["api.telegram.org"],
        },
      }),
    );
  });

  it("uses caller-provided fetch impl for sticker downloads", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "stickers/file_0.webp" });
    const callerFetch = vi.fn() as unknown as typeof fetch;
    const callerTransport = { fetch: callerFetch, sourceFetch: callerFetch, close: async () => {} };
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker-data"),
      contentType: "image/webp",
      fileName: "file_0.webp",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/file_0.webp",
      contentType: "image/webp",
    });

    const result = await resolveMediaWithDefaults(makeCtx("sticker", getFile), {
      transport: callerTransport,
    });

    expect(result).not.toBeNull();
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        fetchImpl: callerFetch,
      }),
    );
  });

  it("allows an explicit Telegram apiRoot host without broadening the default SSRF allowlist", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("pdf-data"),
      contentType: "application/pdf",
      fileName: "file_42.pdf",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/file_42---uuid.pdf",
      contentType: "application/pdf",
    });

    await resolveMediaWithDefaults(makeCtx("document", getFile), {
      apiRoot: "https://telegram.internal:8443/custom/",
      dangerouslyAllowPrivateNetwork: true,
    });

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://telegram.internal:8443/custom/file/bot${BOT_TOKEN}/documents/file_42.pdf`,
        ssrfPolicy: {
          hostnameAllowlist: ["api.telegram.org", "telegram.internal"],
          allowedHostnames: ["telegram.internal"],
          allowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
        },
      }),
    );
  });

  it("copies trusted local absolute file paths into inbound media storage for media downloads", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/file.pdf" });
    readFileWithinRoot.mockResolvedValueOnce({
      buffer: Buffer.from("pdf-data"),
      realPath: "/var/lib/telegram-bot-api/file.pdf",
      stat: { size: 8 },
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/inbound/file.pdf",
      contentType: "application/pdf",
    });

    const result = await resolveMediaWithDefaults(
      makeCtx("document", getFile, { mime_type: "application/pdf" }),
      { trustedLocalFileRoots: ["/var/lib/telegram-bot-api"] },
    );

    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(readFileWithinRoot).toHaveBeenCalledWith({
      rootDir: "/var/lib/telegram-bot-api",
      relativePath: "file.pdf",
      maxBytes: MAX_MEDIA_BYTES,
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("pdf-data"),
      "application/pdf",
      "inbound",
      MAX_MEDIA_BYTES,
      "file.pdf",
    );
    expect(result).toEqual(
      expect.objectContaining({
        path: "/tmp/inbound/file.pdf",
        contentType: "application/pdf",
        placeholder: "<media:document>",
      }),
    );
  });

  it("copies trusted local absolute file paths into inbound media storage for sticker downloads", async () => {
    const getFile = vi
      .fn()
      .mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/sticker.webp" });
    readFileWithinRoot.mockResolvedValueOnce({
      buffer: Buffer.from("sticker-data"),
      realPath: "/var/lib/telegram-bot-api/sticker.webp",
      stat: { size: 12 },
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/inbound/sticker.webp",
      contentType: "image/webp",
    });

    const result = await resolveMediaWithDefaults(makeCtx("sticker", getFile), {
      trustedLocalFileRoots: ["/var/lib/telegram-bot-api"],
    });

    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(readFileWithinRoot).toHaveBeenCalledWith({
      rootDir: "/var/lib/telegram-bot-api",
      relativePath: "sticker.webp",
      maxBytes: MAX_MEDIA_BYTES,
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("sticker-data"),
      undefined,
      "inbound",
      MAX_MEDIA_BYTES,
      "sticker.webp",
    );
    expect(result).toEqual(
      expect.objectContaining({
        path: "/tmp/inbound/sticker.webp",
        placeholder: "<media:sticker>",
      }),
    );
  });

  it("maps trusted local absolute path read failures to MediaFetchError", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/file.pdf" });
    readFileWithinRoot.mockRejectedValueOnce(new Error("file not found"));

    await expect(
      resolveMediaWithDefaults(makeCtx("document", getFile, { mime_type: "application/pdf" }), {
        trustedLocalFileRoots: ["/var/lib/telegram-bot-api"],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "MediaFetchError",
        code: "fetch_failed",
        message: expect.stringContaining("/var/lib/telegram-bot-api/file.pdf"),
      }),
    );
  });

  it("maps oversized trusted local absolute path reads to MediaFetchError", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/file.pdf" });
    readFileWithinRoot.mockRejectedValueOnce(new Error("file exceeds limit"));

    await expect(
      resolveMediaWithDefaults(makeCtx("document", getFile, { mime_type: "application/pdf" }), {
        trustedLocalFileRoots: ["/var/lib/telegram-bot-api"],
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "MediaFetchError",
        code: "fetch_failed",
        message: expect.stringContaining("file exceeds limit"),
      }),
    );
  });

  it("rejects absolute Bot API file paths outside trustedLocalFileRoots", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/file.pdf" });

    await expect(
      resolveMediaWithDefaults(makeCtx("document", getFile, { mime_type: "application/pdf" })),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "MediaFetchError",
        code: "fetch_failed",
        message: expect.stringContaining("outside trustedLocalFileRoots"),
      }),
    );

    expect(readFileWithinRoot).not.toHaveBeenCalled();
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
  });
});

describe("resolveMedia original filename preservation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fetchRemoteMedia.mockClear();
    saveMediaBuffer.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes document.file_name to saveMediaBuffer instead of server-side path", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("pdf-data"),
      contentType: "application/pdf",
      fileName: "file_42.pdf",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/business-plan---uuid.pdf",
      contentType: "application/pdf",
    });

    const ctx = makeCtx("document", getFile, { file_name: "business-plan.pdf" });
    const result = await resolveMediaWithDefaults(ctx);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      MAX_MEDIA_BYTES,
      "business-plan.pdf",
    );
    expect(result).toEqual(expect.objectContaining({ path: "/tmp/business-plan---uuid.pdf" }));
  });

  it("passes audio.file_name to saveMediaBuffer", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "music/file_99.mp3" });
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio-data"),
      contentType: "audio/mpeg",
      fileName: "file_99.mp3",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/my-song---uuid.mp3",
      contentType: "audio/mpeg",
    });

    const ctx = makeCtx("audio", getFile, { file_name: "my-song.mp3" });
    const result = await resolveMediaWithDefaults(ctx);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "audio/mpeg",
      "inbound",
      MAX_MEDIA_BYTES,
      "my-song.mp3",
    );
    expect(result).not.toBeNull();
  });

  it("passes video.file_name to saveMediaBuffer", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "videos/file_55.mp4" });
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("video-data"),
      contentType: "video/mp4",
      fileName: "file_55.mp4",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/presentation---uuid.mp4",
      contentType: "video/mp4",
    });

    const ctx = makeCtx("video", getFile, { file_name: "presentation.mp4" });
    const result = await resolveMediaWithDefaults(ctx);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "video/mp4",
      "inbound",
      MAX_MEDIA_BYTES,
      "presentation.mp4",
    );
    expect(result).not.toBeNull();
  });

  it("falls back to fetched.fileName when telegram file_name is absent", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      MAX_MEDIA_BYTES,
      "file_42.pdf",
    );
    expect(result).not.toBeNull();
  });

  it("falls back to filePath when neither telegram nor fetched fileName is available", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave(undefined);

    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx);

    expect(saveMediaBuffer).toHaveBeenCalledWith(
      expect.any(Buffer),
      "application/pdf",
      "inbound",
      MAX_MEDIA_BYTES,
      "documents/file_42.pdf",
    );
    expect(result).not.toBeNull();
  });

  it("allows a configured custom apiRoot host while keeping the hostname allowlist", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx, {
      apiRoot: "http://192.168.1.50:8081/custom-bot-api/",
    });

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: {
          hostnameAllowlist: ["api.telegram.org", "192.168.1.50"],
          allowedHostnames: ["192.168.1.50"],
          allowRfc2544BenchmarkRange: true,
        },
      }),
    );
    expect(result).not.toBeNull();
  });

  it("opts into private-network Telegram media downloads only when explicitly configured", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx, { dangerouslyAllowPrivateNetwork: true });

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        ssrfPolicy: {
          hostnameAllowlist: ["api.telegram.org"],
          allowPrivateNetwork: true,
          allowRfc2544BenchmarkRange: true,
        },
      }),
    );
    expect(result).not.toBeNull();
  });

  it("constructs correct download URL with custom apiRoot for documents", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const customApiRoot = "http://192.168.1.50:8081/custom-bot-api";
    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx, { apiRoot: customApiRoot });

    // Verify the URL uses the custom apiRoot, not the default Telegram API
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${customApiRoot}/file/bot${BOT_TOKEN}/documents/file_42.pdf`,
      }),
    );
    expect(result).not.toBeNull();
  });

  it("constructs correct download URL with custom apiRoot for stickers", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "stickers/file_0.webp" });
    fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("sticker-data"),
      contentType: "image/webp",
      fileName: "file_0.webp",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/file_0.webp",
      contentType: "image/webp",
    });

    const customApiRoot = "http://localhost:8081/bot";
    const ctx = makeCtx("sticker", getFile);
    const result = await resolveMediaWithDefaults(ctx, { apiRoot: customApiRoot });

    // Verify the URL uses the custom apiRoot for sticker downloads
    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `${customApiRoot}/file/bot${BOT_TOKEN}/stickers/file_0.webp`,
      }),
    );
    expect(result).not.toBeNull();
  });
});
