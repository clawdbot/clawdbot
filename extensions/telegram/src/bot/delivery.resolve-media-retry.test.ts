// Telegram tests cover delivery.resolve media retry plugin behavior.
import { GrammyError } from "grammy";
import type { Message } from "grammy/types";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMedia } from "./delivery.resolve-media.js";
import type { TelegramContext } from "./types.js";

const saveMediaBuffer = vi.fn();
const readRemoteMediaBuffer = vi.fn();
const saveRemoteMedia = vi.fn(async (...args: unknown[]) => {
  const fetched = (await readRemoteMediaBuffer(...args)) as {
    buffer: Buffer;
    contentType?: string;
    fileName?: string;
  };
  return await saveMediaBuffer(
    fetched.buffer,
    fetched.contentType,
    "inbound",
    args[0] && typeof args[0] === "object"
      ? (args[0] as { maxBytes?: unknown }).maxBytes
      : undefined,
    args[0] && typeof args[0] === "object"
      ? ((args[0] as { originalFilename?: unknown }).originalFilename ??
          fetched.fileName ??
          (args[0] as { filePathHint?: unknown }).filePathHint)
      : undefined,
  );
});
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
    status?: number;

    constructor(code: string, message: string, options?: { cause?: unknown; status?: number }) {
      super(message, options);
      this.name = "MediaFetchError";
      this.code = code;
      this.status = options?.status;
    }
  }
  return {
    readRemoteMediaBuffer: (...args: unknown[]) => readRemoteMediaBuffer(...args),
    formatErrorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
    logVerbose: () => {},
    MediaFetchError,
    resolveTelegramApiBase: (apiRoot?: string) =>
      apiRoot?.trim() ? apiRoot.replace(/\/+$/u, "") : "https://api.telegram.org",
    sleepWithAbort,
    saveMediaBuffer: (...args: unknown[]) => saveMediaBuffer(...args),
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

  readRemoteMediaBuffer.mockResolvedValueOnce({
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
  readRemoteMediaBuffer.mockResolvedValueOnce({
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

function createFileTooBigGrammyError(): GrammyError {
  return new GrammyError(
    "Call to 'getFile' failed!",
    {
      ok: false,
      error_code: 400,
      description: "Bad Request: file is too big",
      parameters: {},
    },
    "getFile",
    {},
  );
}

function createRateLimitGrammyError(retryAfterSeconds = 3): GrammyError {
  return new GrammyError(
    "Call to 'getFile' failed!",
    {
      ok: false,
      error_code: 429,
      description: "Too Many Requests: retry later",
      parameters: { retry_after: retryAfterSeconds },
    },
    "getFile",
    {},
  );
}

function createFileAccessError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
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

function requireReadRemoteMediaBufferParams(callIndex = 0): Record<string, unknown> {
  const call = (readRemoteMediaBuffer.mock.calls as unknown[][])[callIndex];
  if (!call) {
    throw new Error(`expected readRemoteMediaBuffer call ${callIndex}`);
  }
  return requireRecord(call[0], `readRemoteMediaBuffer call ${callIndex} params`);
}

function expectReadRemoteMediaBufferFields(fields: Record<string, unknown>, callIndex = 0) {
  expectRecordFields(requireReadRemoteMediaBufferParams(callIndex), fields);
}

function expectFetchSsrfPolicyFields(fields: Record<string, unknown>, callIndex = 0) {
  const params = requireReadRemoteMediaBufferParams(callIndex);
  expectRecordFields(requireRecord(params.ssrfPolicy, "readRemoteMediaBuffer ssrfPolicy"), fields);
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
  fields: { code: string; messageIncludes: string; name?: string; status?: number },
) {
  try {
    await promise;
  } catch (error) {
    const record = requireRecord(error, "MediaFetchError");
    expect(record.name).toBe(fields.name ?? "MediaFetchError");
    expect(record.code).toBe(fields.code);
    expect(String(record.message)).toContain(fields.messageIncludes);
    if (fields.status !== undefined) {
      expect(record.status).toBe(fields.status);
    }
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
  expectReadRemoteMediaBufferFields({
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
    readRemoteMediaBuffer.mockReset();
    saveMediaBuffer.mockReset();
    saveRemoteMedia.mockClear();
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
    "throws a typed failure for %s when getFile exhausts retries",
    async (mediaField) => {
      const getFile = vi.fn().mockRejectedValue(new Error("Network request for 'getFile' failed!"));

      const promise = resolveMediaWithDefaults(makeCtx(mediaField, getFile));
      const failure = expectMediaFetchError(promise, {
        code: "fetch_failed",
        messageIncludes: "Telegram getFile failed after retries",
      });
      await flushRetryTimers();
      await failure;

      expect(getFile).toHaveBeenCalledTimes(3);
    },
  );

  it("does not catch errors from readRemoteMediaBuffer (only getFile is retried)", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "voice/file_0.oga" });
    readRemoteMediaBuffer.mockRejectedValueOnce(new Error("download failed"));

    await expect(resolveMediaWithDefaults(makeCtx("voice", getFile))).rejects.toThrow(
      "download failed",
    );

    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it("does not retry string-shaped 'file is too big' errors", async () => {
    // Simulate Telegram Bot API error when file exceeds 20MB limit.
    const fileTooBigError = createFileTooBigError();
    const getFile = vi.fn().mockRejectedValue(fileTooBigError);

    await expectMediaFetchError(resolveMediaWithDefaults(makeCtx("video", getFile)), {
      code: "max_bytes",
      messageIncludes: "larger than 20 MB",
      name: "TelegramBotApiFileTooLargeError",
      status: 400,
    });

    // Should NOT retry - "file is too big" is a permanent error, not transient.
    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it("preserves Telegram status for 'file is too big' GrammyError instances", async () => {
    const fileTooBigError = createFileTooBigGrammyError();
    const getFile = vi.fn().mockRejectedValue(fileTooBigError);

    await expectMediaFetchError(resolveMediaWithDefaults(makeCtx("video", getFile)), {
      code: "max_bytes",
      messageIncludes: "larger than 20 MB",
      name: "TelegramBotApiFileTooLargeError",
      status: 400,
    });

    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it("honors Telegram retry_after before retrying getFile", async () => {
    const getFile = vi
      .fn()
      .mockRejectedValueOnce(createRateLimitGrammyError())
      .mockResolvedValueOnce({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const promise = resolveMediaWithDefaults(makeCtx("document", getFile));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(getFile).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await promise;

    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it("does not cap Telegram retry_after at 30 seconds", async () => {
    const getFile = vi
      .fn()
      .mockRejectedValueOnce(createRateLimitGrammyError(60))
      .mockResolvedValueOnce({ file_path: "documents/file_42.pdf" });
    mockPdfFetchAndSave("file_42.pdf");

    const promise = resolveMediaWithDefaults(makeCtx("document", getFile));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(getFile).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
    await promise;

    expect(getFile).toHaveBeenCalledTimes(2);
  });

  it("aborts long retry_after waits at the overall handler deadline", async () => {
    const getFile = vi.fn().mockRejectedValue(createRateLimitGrammyError(1_200));
    const startedAt = Date.now();

    const promise = resolveMediaWithDefaults(makeCtx("document", getFile));
    const failure = expectMediaFetchError(promise, {
      code: "http_error",
      messageIncludes: "Telegram getFile failed after retries",
      status: 429,
    });
    await vi.runAllTimersAsync();
    await failure;

    expect(getFile.mock.calls.length).toBeLessThanOrEqual(2);
    expect(Date.now() - startedAt).toBeLessThan(25 * 60_000);
  });

  it("aborts retry_after waits when the Telegram session shuts down", async () => {
    const shutdown = new AbortController();
    const getFile = vi.fn().mockRejectedValue(createRateLimitGrammyError(60));
    const promise = resolveMediaWithDefaults(makeCtx("document", getFile), {
      abortSignal: shutdown.signal,
    });
    const failure = expectMediaFetchError(promise, {
      code: "http_error",
      messageIncludes: "Telegram getFile failed after retries",
      status: 429,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    shutdown.abort();
    await failure;

    expect(getFile).toHaveBeenCalledTimes(1);
  });

  it.each(["audio", "voice"] as const)(
    "throws a typed failure for %s when file is too big",
    async (mediaField) => {
      const getFile = vi.fn().mockRejectedValue(createFileTooBigError());

      await expectMediaFetchError(resolveMediaWithDefaults(makeCtx(mediaField, getFile)), {
        code: "max_bytes",
        messageIncludes: "larger than 20 MB",
        name: "TelegramBotApiFileTooLargeError",
        status: 400,
      });

      expect(getFile).toHaveBeenCalledTimes(1);
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

    readRemoteMediaBuffer.mockResolvedValueOnce({
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

  it("throws a typed failure for stickers when getFile exhausts retries", async () => {
    const getFile = vi.fn().mockRejectedValue(new Error("Network request for 'getFile' failed!"));

    const ctx = makeCtx("sticker", getFile);
    const promise = resolveMediaWithDefaults(ctx);
    const failure = expectMediaFetchError(promise, {
      code: "fetch_failed",
      messageIncludes: "Telegram getFile failed after retries",
    });
    await flushRetryTimers();
    await failure;

    expect(getFile).toHaveBeenCalledTimes(3);
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
    readRemoteMediaBuffer.mockResolvedValueOnce({
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
    const params = requireReadRemoteMediaBufferParams();
    expectRecordFields(params, {
      fetchImpl: callerFetch,
      dispatcherAttempts,
      trustExplicitProxyDns: true,
      responseHeaderTimeoutMs: 120_000,
      readIdleTimeoutMs: 30_000,
    });
    expect(params.timeoutMs).toBeUndefined();
    expect(params.retry).toBeUndefined();
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
    readRemoteMediaBuffer.mockResolvedValueOnce({
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
    expectReadRemoteMediaBufferFields({ fetchImpl: callerFetch });
  });

  it.each([
    { mediaField: "document" as const, filePath: "documents/file_42.pdf" },
    { mediaField: "sticker" as const, filePath: "stickers/file_0.webp" },
  ])("keeps the session abort signal attached to $mediaField downloads", async (scenario) => {
    const shutdown = new AbortController();
    const getFile = vi.fn().mockResolvedValue({ file_path: scenario.filePath });
    readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("media"),
      contentType: scenario.mediaField === "sticker" ? "image/webp" : "application/pdf",
      fileName: scenario.filePath.split("/").at(-1),
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: `/tmp/${scenario.filePath.split("/").at(-1)}`,
      contentType: scenario.mediaField === "sticker" ? "image/webp" : "application/pdf",
    });

    await resolveMediaWithDefaults(makeCtx(scenario.mediaField, getFile), {
      abortSignal: shutdown.signal,
    });

    expect(requireReadRemoteMediaBufferParams()).toMatchObject({
      requestInit: { signal: shutdown.signal },
      responseHeaderTimeoutMs: 120_000,
      readIdleTimeoutMs: 30_000,
    });
  });

  it("omits nested download retries so callers own failure handling", async () => {
    const timeout = Object.assign(new Error("request timed out"), { name: "TimeoutError" });
    const fetchError = Object.assign(new Error("failed to fetch media", { cause: timeout }), {
      name: "MediaFetchError",
      code: "fetch_failed",
    });
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/first.pdf" });
    readRemoteMediaBuffer.mockRejectedValueOnce(fetchError);

    await expect(resolveMediaWithDefaults(makeCtx("document", getFile))).rejects.toBe(fetchError);

    expect(readRemoteMediaBuffer).toHaveBeenCalledTimes(1);
    expect(saveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(requireReadRemoteMediaBufferParams().retry).toBeUndefined();
  });

  it("allows an explicit Telegram apiRoot host without broadening the default SSRF allowlist", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    readRemoteMediaBuffer.mockResolvedValueOnce({
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

    expectReadRemoteMediaBufferFields({
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

    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
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

  it("copies trusted local file paths whose names start with dots", async () => {
    const getFile = vi
      .fn()
      .mockResolvedValue({ file_path: "/var/lib/telegram-bot-api/..photo.jpg" });
    rootRead.mockResolvedValueOnce({
      buffer: Buffer.from("image-data"),
      realPath: "/var/lib/telegram-bot-api/..photo.jpg",
      stat: { size: 10 },
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/inbound/photo.jpg",
      contentType: "image/jpeg",
    });

    const result = await resolveMediaWithDefaults(
      makeCtx("document", getFile, { file_name: "..photo.jpg", mime_type: "image/jpeg" }),
      { trustedLocalFileRoots: ["/var/lib/telegram-bot-api"] },
    );

    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(rootRead).toHaveBeenCalledWith({
      rootDir: "/var/lib/telegram-bot-api",
      relativePath: "..photo.jpg",
      maxBytes: MAX_MEDIA_BYTES,
    });
    expect(saveMediaBuffer).toHaveBeenCalledWith(
      Buffer.from("image-data"),
      "image/jpeg",
      "inbound",
      MAX_MEDIA_BYTES,
      "..photo.jpg",
    );
    expectResolvedMediaFields(result, "trusted local dot-prefixed document", {
      path: "/tmp/inbound/photo.jpg",
      contentType: "image/jpeg",
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

    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
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
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
  });
});

describe("resolveMedia local Bot API container paths", () => {
  beforeEach(() => {
    readRemoteMediaBuffer.mockReset();
    saveMediaBuffer.mockReset();
    saveRemoteMedia.mockClear();
    rootRead.mockReset();
  });

  it("maps container-absolute file paths onto a trusted host data root", async () => {
    const getFile = vi.fn().mockResolvedValue({
      file_path: `/var/lib/telegram-bot-api/${BOT_TOKEN}/documents/file_12.zip`,
    });
    rootRead.mockResolvedValueOnce({
      buffer: Buffer.from("zip-data"),
      realPath: `/host/telegram-bot-api/data/${BOT_TOKEN}/documents/file_12.zip`,
      stat: { size: 8 },
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/inbound/file_12.zip",
      contentType: "application/zip",
    });

    const result = await resolveMediaWithDefaults(
      makeCtx("document", getFile, { file_name: "file_12.zip", mime_type: "application/zip" }),
      { trustedLocalFileRoots: ["/host/telegram-bot-api/data"] },
    );

    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(rootRead).toHaveBeenCalledWith({
      rootDir: "/host/telegram-bot-api/data",
      relativePath: `${BOT_TOKEN}/documents/file_12.zip`,
      maxBytes: MAX_MEDIA_BYTES,
    });
    expectResolvedMediaFields(result, "container-mapped document", {
      path: "/tmp/inbound/file_12.zip",
      contentType: "application/zip",
      placeholder: "<media:document>",
    });
  });

  it("maps container paths when the trusted root is the per-token directory", async () => {
    const getFile = vi.fn().mockResolvedValue({
      file_path: `/var/lib/telegram-bot-api/${BOT_TOKEN}/documents/file_7.zip`,
    });
    rootRead.mockRejectedValueOnce(createFileAccessError("not-found", "file not found"));
    rootRead.mockResolvedValueOnce({
      buffer: Buffer.from("zip-data"),
      realPath: "/host/telegram-bot-api/token/documents/file_7.zip",
      stat: { size: 8 },
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/inbound/file_7.zip",
      contentType: "application/zip",
    });

    const result = await resolveMediaWithDefaults(
      makeCtx("document", getFile, { file_name: "file_7.zip", mime_type: "application/zip" }),
      { trustedLocalFileRoots: ["/host/telegram-bot-api/token"] },
    );

    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(rootRead).toHaveBeenNthCalledWith(1, {
      rootDir: "/host/telegram-bot-api/token",
      relativePath: `${BOT_TOKEN}/documents/file_7.zip`,
      maxBytes: MAX_MEDIA_BYTES,
    });
    expect(rootRead).toHaveBeenNthCalledWith(2, {
      rootDir: "/host/telegram-bot-api/token",
      relativePath: "documents/file_7.zip",
      maxBytes: MAX_MEDIA_BYTES,
    });
    expectResolvedMediaFields(result, "per-token-root document", {
      path: "/tmp/inbound/file_7.zip",
      contentType: "application/zip",
      placeholder: "<media:document>",
    });
  });

  it("accepts the colon-to-tilde token directory used on restricted filesystems", async () => {
    const token = "123:secret";
    const getFile = vi.fn().mockResolvedValue({
      file_path: "/var/lib/telegram-bot-api/123~secret/documents/file_9.pdf",
    });
    rootRead.mockRejectedValueOnce(createFileAccessError("not-found", "file not found"));
    rootRead.mockResolvedValueOnce({
      buffer: Buffer.from("pdf-data"),
      realPath: "/host/telegram-bot-api/token/documents/file_9.pdf",
      stat: { size: 8 },
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/inbound/file_9.pdf",
      contentType: "application/pdf",
    });

    const result = await resolveMediaWithDefaults(
      makeCtx("document", getFile, { file_name: "file_9.pdf", mime_type: "application/pdf" }),
      { token, trustedLocalFileRoots: ["/host/telegram-bot-api/token"] },
    );

    expect(rootRead).toHaveBeenCalledTimes(2);
    expect(rootRead).toHaveBeenLastCalledWith({
      rootDir: "/host/telegram-bot-api/token",
      relativePath: "documents/file_9.pdf",
      maxBytes: MAX_MEDIA_BYTES,
    });
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
    expectResolvedMediaFields(result, "tilde-token document", {
      path: "/tmp/inbound/file_9.pdf",
      contentType: "application/pdf",
      placeholder: "<media:document>",
    });
  });

  it("preserves non-missing trusted-root read failures", async () => {
    const getFile = vi.fn().mockResolvedValue({
      file_path: `/var/lib/telegram-bot-api/${BOT_TOKEN}/documents/file_3.zip`,
    });
    rootRead.mockRejectedValue(createFileAccessError("too-large", "file exceeds limit"));

    await expectMediaFetchError(
      resolveMediaWithDefaults(makeCtx("document", getFile, { mime_type: "application/zip" }), {
        trustedLocalFileRoots: ["/host/telegram-bot-api/data"],
      }),
      {
        code: "fetch_failed",
        messageIncludes: "file exceeds limit",
      },
    );
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("rejects container paths when all trusted candidates are missing", async () => {
    const getFile = vi.fn().mockResolvedValue({
      file_path: `/var/lib/telegram-bot-api/${BOT_TOKEN}/documents/file_3.zip`,
    });
    rootRead.mockRejectedValue(createFileAccessError("not-found", "file not found"));

    await expectMediaFetchError(
      resolveMediaWithDefaults(makeCtx("document", getFile, { mime_type: "application/zip" }), {
        trustedLocalFileRoots: ["/host/telegram-bot-api/data"],
      }),
      { code: "fetch_failed", messageIncludes: "outside trustedLocalFileRoots" },
    );
    expect(rootRead).toHaveBeenCalledTimes(2);
    expect(readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("rejects dot-segment escapes before reading a trusted root", async () => {
    const getFile = vi.fn().mockResolvedValue({
      file_path: `/var/lib/telegram-bot-api/${BOT_TOKEN}/../outside.zip`,
    });

    await expectMediaFetchError(
      resolveMediaWithDefaults(makeCtx("document", getFile), {
        trustedLocalFileRoots: ["/host/telegram-bot-api/data"],
      }),
      { code: "fetch_failed", messageIncludes: "outside trustedLocalFileRoots" },
    );
    expect(rootRead).not.toHaveBeenCalled();
  });
});

describe("resolveMedia original filename preservation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readRemoteMediaBuffer.mockClear();
    saveMediaBuffer.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes document.file_name to saveMediaBuffer instead of server-side path", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/file_42.pdf" });
    readRemoteMediaBuffer.mockResolvedValueOnce({
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

  it("classifies an audio document from the saved MIME type", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "documents/recording.m2a" });
    saveRemoteMedia.mockResolvedValueOnce({
      path: "/tmp/inbound/recording.m2a",
      contentType: "audio/mpeg",
    });

    const result = await resolveMediaWithDefaults(
      makeCtx("document", getFile, {
        file_name: "recording.m2a",
        mime_type: "application/octet-stream",
      }),
    );

    expectResolvedMediaFields(result, "MPEG-2 audio document", {
      path: "/tmp/inbound/recording.m2a",
      contentType: "audio/mpeg",
      placeholder: "<media:audio>",
    });
  });

  it("passes audio.file_name to saveMediaBuffer", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "music/file_99.mp3" });
    readRemoteMediaBuffer.mockResolvedValueOnce({
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
    readRemoteMediaBuffer.mockResolvedValueOnce({
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

    expectReadRemoteMediaBufferFields({
      url: `${customApiRoot}/file/bot${BOT_TOKEN}/documents/file_42.pdf`,
    });
    requireResolvedMedia(result, "custom apiRoot document URL");
  });

  it("constructs correct download URL with custom apiRoot for stickers", async () => {
    const getFile = vi.fn().mockResolvedValue({ file_path: "stickers/file_0.webp" });
    readRemoteMediaBuffer.mockResolvedValueOnce({
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

    expectReadRemoteMediaBufferFields({
      url: `${customApiRoot}/file/bot${BOT_TOKEN}/stickers/file_0.webp`,
    });
    requireResolvedMedia(result, "custom apiRoot sticker URL");
  });
});
