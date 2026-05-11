import type { Message } from "@grammyjs/types";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMedia } from "./delivery.resolve-media.js";
import type { TelegramContext } from "./types.js";

const saveMediaBuffer = vi.fn();
const fetchRemoteMedia = vi.fn();
const rootRead = vi.fn();

vi.mock("openclaw/plugin-sdk/file-access-runtime", () => ({
  root: async (rootDir: string) => ({
    read: async (relativePath: string, options?: { maxBytes?: number }) =>
      await rootRead({
        rootDir,
        relativePath,
        maxBytes: options?.maxBytes,
      }),
  }),
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

function requireResolvedMedia(
  result: Awaited<ReturnType<typeof resolveMediaWithDefaults>>,
  label: string,
) {
  if (!result) {
    throw new Error(`expected ${label} media result`);
  }
  return result;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be a record`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function requireFetchRemoteMediaParams(callIndex = 0): Record<string, unknown> {
  const call = (fetchRemoteMedia.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected fetchRemoteMedia call ${callIndex}`);
  }
  return requireRecord(call[0], `fetchRemoteMedia call ${callIndex} params`);
}

function expectFetchRemoteMediaFields(fields: Record<string, unknown>, callIndex = 0) {
  expectRecordFields(requireFetchRemoteMediaParams(callIndex), fields);
}

function expectFetchSsrfPolicyFields(fields: Record<string, unknown>, callIndex = 0) {
  const params = requireFetchRemoteMediaParams(callIndex);
  expectRecordFields(requireRecord(params.ssrfPolicy, "fetchRemoteMedia ssrfPolicy"), fields);
}

function expectResolvedMediaFields(
  result: Awaited<ReturnType<typeof resolveMediaWithDefaults>>,
  label: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireResolvedMedia(result, label), fields);
}

async function expectMediaFetchError(
  promise: Promise<unknown>,
  fields: { code: string; messageIncludes: string },
) {
  try {
    await promise;
  } catch (error) {
    const record = requireRecord(error, "MediaFetchError");
    expect(record.name).toBe("MediaFetchError");
    expect(record.code).toBe(fields.code);
    expect(String(record.message)).toContain(fields.messageIncludes);
    return;
  }
  throw new Error("expected MediaFetchError rejection");
}

function expectSaveMediaBufferCall(callIndex: number, fields: Record<string, unknown>) {
  const call = (saveMediaBuffer.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected saveMediaBuffer call ${callIndex}`);
  }
  expect(Buffer.isBuffer(call[0])).toBe(true);
  expect(call[1]).toBe(fields.contentType);
  expect(call[2]).toBe(fields.bucket);
  expect(call[3]).toBe(fields.maxBytes);
  expect(call[4]).toBe(fields.fileName);
}

async function expectTransientGetFileRetrySuccess() {
  const getFile = setupTransientGetFileRetry();
  const promise = resolveMediaWithDefaults(makeCtx("voice", getFile));
  await flushRetryTimers();
  const result = await promise;
  expect(getFile).toHaveBeenCalledTimes(2);
  expectFetchRemoteMediaFields({
    url: `https://api.telegram.org/file/bot${BOT_TOKEN}/voice/file_0.oga`,
  });
  expectFetchSsrfPolicyFields({
    allowRfc2544BenchmarkRange: true,
    hostnameAllowlist: ["api.telegram.org"],
  });
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
    rootRead.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries getFile on transient failure and succeeds on second attempt", async () => {
    const result = await expectTransientGetFileRetrySuccess();
    expectResolvedMediaFields(result, "retried voice", {
      path: "/tmp/file_0.oga",
      placeholder: "<media:audio>",
    });
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
    expect(result?.path).toBe("/tmp/file_0.oga");
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
    expectResolvedMediaFields(result, "retried sticker", {
      path: "/tmp/file_0.webp",
      placeholder: "<media:sticker>",
    });
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

    expect(result?.path).toBe("/tmp/file_42---uuid.pdf");
    const params = requireFetchRemoteMediaParams();
    expectRecordFields(params, {
      fetchImpl: callerFetch,
      dispatcherAttempts,
      trustExplicitProxyDns: true,
      readIdleTimeoutMs: 30_000,
    });
    expect(typeof params.shouldRetryFetchError).toBe("function");
    expectFetchSsrfPolicyFields({
      allowRfc2544BenchmarkRange: true,
      hostnameAllowlist: ["api.telegram.org"],
    });
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

    expect(result?.path).toBe("/tmp/file_0.webp");
    expectFetchRemoteMediaFields({ fetchImpl: callerFetch });
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

    expectFetchRemoteMediaFields({
      url: `https://telegram.internal:8443/custom/file/bot${BOT_TOKEN}/documents/file_42.pdf`,
    });
    expectFetchSsrfPolicyFields({
      hostnameAllowlist: ["api.telegram.org", "telegram.internal"],
      allowedHostnames: ["telegram.internal"],
      allowPrivateNetwork: true,
      allowRfc2544BenchmarkRange: true,
    });
  });

  it("copies trusted local absolute file paths into inbound media storage for media downloads", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/file.pdf" });
    rootRead.mockResolvedValueOnce({
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
    expect(rootRead).toHaveBeenCalledWith({
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
    expectResolvedMediaFields(result, "trusted local document", {
      path: "/tmp/inbound/file.pdf",
      contentType: "application/pdf",
      placeholder: "<media:document>",
    });
  });

  it("copies trusted local absolute file paths into inbound media storage for sticker downloads", async () => {
    const getFile = vi
      .fn()
      .mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/sticker.webp" });
    rootRead.mockResolvedValueOnce({
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
    expect(rootRead).toHaveBeenCalledWith({
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
    expectResolvedMediaFields(result, "trusted local sticker", {
      path: "/tmp/inbound/sticker.webp",
      placeholder: "<media:sticker>",
    });
  });

  it("maps trusted local absolute path read failures to MediaFetchError", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/file.pdf" });
    rootRead.mockRejectedValueOnce(new Error("file not found"));

    await expectMediaFetchError(
      resolveMediaWithDefaults(makeCtx("document", getFile, { mime_type: "application/pdf" }), {
        trustedLocalFileRoots: ["/var/lib/telegram-bot-api"],
      }),
      {
        code: "fetch_failed",
        messageIncludes: "/var/lib/telegram-bot-api/file.pdf",
      },
    );
  });

  it("maps oversized trusted local absolute path reads to MediaFetchError", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/file.pdf" });
    rootRead.mockRejectedValueOnce(new Error("file exceeds limit"));

    await expectMediaFetchError(
      resolveMediaWithDefaults(makeCtx("document", getFile, { mime_type: "application/pdf" }), {
        trustedLocalFileRoots: ["/var/lib/telegram-bot-api"],
      }),
      {
        code: "fetch_failed",
        messageIncludes: "file exceeds limit",
      },
    );
  });

  it("rejects absolute Bot API file paths outside trustedLocalFileRoots", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/file.pdf" });

    await expectMediaFetchError(
      resolveMediaWithDefaults(makeCtx("document", getFile, { mime_type: "application/pdf" })),
      {
        code: "fetch_failed",
        messageIncludes: "outside trustedLocalFileRoots",
      },
    );

    expect(rootRead).not.toHaveBeenCalled();
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

    expectSaveMediaBufferCall(0, {
      contentType: "application/pdf",
      bucket: "inbound",
      maxBytes: MAX_MEDIA_BYTES,
      fileName: "business-plan.pdf",
    });
    expectResolvedMediaFields(result, "document filename", {
      path: "/tmp/business-plan---uuid.pdf",
    });
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

    expectSaveMediaBufferCall(0, {
      contentType: "audio/mpeg",
      bucket: "inbound",
      maxBytes: MAX_MEDIA_BYTES,
      fileName: "my-song.mp3",
    });
    requireResolvedMedia(result, "audio filename");
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

    expectSaveMediaBufferCall(0, {
      contentType: "video/mp4",
      bucket: "inbound",
      maxBytes: MAX_MEDIA_BYTES,
      fileName: "presentation.mp4",
    });
    requireResolvedMedia(result, "video filename");
  });

  it("falls back to fetched.fileName when telegram file_name is absent", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx);

    expectSaveMediaBufferCall(0, {
      contentType: "application/pdf",
      bucket: "inbound",
      maxBytes: MAX_MEDIA_BYTES,
      fileName: "file_42.pdf",
    });
    requireResolvedMedia(result, "fetched filename fallback");
  });

  it("falls back to filePath when neither telegram nor fetched fileName is available", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave(undefined);

    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx);

    expectSaveMediaBufferCall(0, {
      contentType: "application/pdf",
      bucket: "inbound",
      maxBytes: MAX_MEDIA_BYTES,
      fileName: "documents/file_42.pdf",
    });
    requireResolvedMedia(result, "file path fallback");
  });

  it("allows a configured custom apiRoot host while keeping the hostname allowlist", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx, {
      apiRoot: "http://192.168.1.50:8081/custom-bot-api/",
    });

    expectFetchSsrfPolicyFields({
      hostnameAllowlist: ["api.telegram.org", "192.168.1.50"],
      allowedHostnames: ["192.168.1.50"],
      allowRfc2544BenchmarkRange: true,
    });
    requireResolvedMedia(result, "custom apiRoot allowlist");
  });

  it("opts into private-network Telegram media downloads only when explicitly configured", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx, { dangerouslyAllowPrivateNetwork: true });

    expectFetchSsrfPolicyFields({
      hostnameAllowlist: ["api.telegram.org"],
      allowPrivateNetwork: true,
      allowRfc2544BenchmarkRange: true,
    });
    requireResolvedMedia(result, "private network opt-in");
  });

  it("constructs correct download URL with custom apiRoot for documents", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const customApiRoot = "http://192.168.1.50:8081/custom-bot-api";
    const ctx = makeCtx("document", getFile);
    const result = await resolveMediaWithDefaults(ctx, { apiRoot: customApiRoot });

    expectFetchRemoteMediaFields({
      url: `${customApiRoot}/file/bot${BOT_TOKEN}/documents/file_42.pdf`,
    });
    requireResolvedMedia(result, "custom apiRoot document URL");
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

    expectFetchRemoteMediaFields({
      url: `${customApiRoot}/file/bot${BOT_TOKEN}/stickers/file_0.webp`,
    });
    requireResolvedMedia(result, "custom apiRoot sticker URL");
  });
});
