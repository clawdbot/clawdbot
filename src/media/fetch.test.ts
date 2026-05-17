import fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
  withStrictGuardedFetchMode: <T>(params: T) => params,
  withTrustedExplicitProxyGuardedFetchMode: <T>(params: T) => ({
    ...params,
    mode: "trusted_explicit_proxy",
  }),
}));

type FetchModule = typeof import("./fetch.js");
type ReadRemoteMediaBuffer = FetchModule["readRemoteMediaBuffer"];
type SaveRemoteMedia = FetchModule["saveRemoteMedia"];
type SaveResponseMedia = FetchModule["saveResponseMedia"];
type LookupFn = NonNullable<Parameters<ReadRemoteMediaBuffer>[0]["lookupFn"]>;
let readRemoteMediaBuffer: ReadRemoteMediaBuffer;
let saveRemoteMedia: SaveRemoteMedia;
let saveResponseMedia: SaveResponseMedia;
let defaultFetchMediaMaxBytes: number;
let tempHome: TempHomeEnv;

function makeStream(chunks: Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function makeStallingFetch(firstChunk: Uint8Array) {
  return vi.fn(async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(firstChunk);
        },
      }),
      { status: 200 },
    );
  });
}

function makeLookupFn(): LookupFn {
  return vi.fn(async () => ({ address: "149.154.167.220", family: 4 })) as unknown as LookupFn;
}

function requireFetchGuardRequest(): unknown {
  const [call] = fetchWithSsrFGuardMock.mock.calls;
  if (!call) {
    throw new Error("expected fetchWithSsrFGuard call");
  }
  return call[0];
}

async function expectRemoteMediaMaxBytesError(params: {
  fetchImpl: Parameters<typeof readRemoteMediaBuffer>[0]["fetchImpl"];
  maxBytes: number;
}) {
  await expect(
    readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl: params.fetchImpl,
      maxBytes: params.maxBytes,
      lookupFn: makeLookupFn(),
    }),
  ).rejects.toThrow("exceeds maxBytes");
}

async function expectRedactedBotTokenFetchError(params: {
  botFileUrl: string;
  botToken: string;
  expectedErrorText: string;
  fetchImpl: Parameters<typeof readRemoteMediaBuffer>[0]["fetchImpl"];
}) {
  const error = await readRemoteMediaBuffer({
    url: params.botFileUrl,
    fetchImpl: params.fetchImpl,
    lookupFn: makeLookupFn(),
    maxBytes: 1024,
    ssrfPolicy: {
      allowedHostnames: ["files.example.test"],
      allowRfc2544BenchmarkRange: true,
    },
  }).catch((err: unknown) => err as Error);

  expect(error).toBeInstanceOf(Error);
  const errorText = error instanceof Error ? String(error) : "";
  expect(errorText).not.toContain(params.botToken);
  expect(errorText).toBe(params.expectedErrorText);
}

async function expectReadRemoteMediaBufferRejected(params: {
  url: string;
  fetchImpl: Parameters<typeof readRemoteMediaBuffer>[0]["fetchImpl"];
  maxBytes?: number;
  readIdleTimeoutMs?: number;
  lookupFn?: LookupFn;
  expectedError: RegExp | string | Record<string, unknown>;
}) {
  const request = {
    url: params.url,
    fetchImpl: params.fetchImpl,
    lookupFn: params.lookupFn ?? makeLookupFn(),
    maxBytes: params.maxBytes ?? 1024,
    ...(params.readIdleTimeoutMs ? { readIdleTimeoutMs: params.readIdleTimeoutMs } : {}),
  };
  if (params.expectedError instanceof RegExp || typeof params.expectedError === "string") {
    await expect(readRemoteMediaBuffer(request)).rejects.toThrow(params.expectedError);
    return;
  }
  let fetchError: unknown;
  try {
    await readRemoteMediaBuffer(request);
  } catch (error) {
    fetchError = error;
  }
  expect(fetchError).toBeInstanceOf(Error);
  for (const [key, value] of Object.entries(params.expectedError)) {
    expect((fetchError as Record<string, unknown>)[key]).toStrictEqual(value);
  }
}

async function expectReadRemoteMediaBufferResolvesToError(
  params: Parameters<typeof readRemoteMediaBuffer>[0],
): Promise<Error> {
  const result = await readRemoteMediaBuffer(params).catch((err: unknown) => err);
  expect(result).toBeInstanceOf(Error);
  if (!(result instanceof Error)) {
    expect.unreachable("expected readRemoteMediaBuffer to reject");
  }
  return result;
}

async function expectReadRemoteMediaBufferIdleTimeoutCase(params: {
  lookupFn: LookupFn;
  fetchImpl: Parameters<typeof readRemoteMediaBuffer>[0]["fetchImpl"];
  readIdleTimeoutMs: number;
  expectedError: Record<string, unknown>;
}) {
  vi.useFakeTimers();
  try {
    const rejection = expectReadRemoteMediaBufferRejected({
      url: "https://example.com/file.bin",
      fetchImpl: params.fetchImpl,
      lookupFn: params.lookupFn,
      readIdleTimeoutMs: params.readIdleTimeoutMs,
      expectedError: params.expectedError,
    });

    await vi.advanceTimersByTimeAsync(params.readIdleTimeoutMs + 5);
    await rejection;
  } finally {
    vi.useRealTimers();
  }
}

async function expectBoundedErrorBodyCase(
  fetchImpl: Parameters<typeof readRemoteMediaBuffer>[0]["fetchImpl"],
) {
  const result = await expectReadRemoteMediaBufferResolvesToError(
    createReadRemoteMediaBufferParams({
      url: "https://example.com/file.bin",
      fetchImpl,
    }),
  );
  expect(result.message).not.toContain("BAD");
  expect(result.message).not.toContain("body:");
}

async function expectPrivateIpFetchBlockedCase() {
  const fetchImpl = vi.fn();
  await expectReadRemoteMediaBufferRejected({
    url: "http://127.0.0.1/secret.jpg",
    fetchImpl,
    expectedError: /private|internal|blocked/i,
  });
  expect(fetchImpl).not.toHaveBeenCalled();
}

function createReadRemoteMediaBufferParams(
  params: Omit<Parameters<typeof readRemoteMediaBuffer>[0], "lookupFn"> & { lookupFn?: LookupFn },
) {
  return {
    lookupFn: params.lookupFn ?? makeLookupFn(),
    maxBytes: 1024,
    ...params,
  };
}

describe("readRemoteMediaBuffer", () => {
  const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
  const redactedBotToken = `${botToken.slice(0, 6)}…${botToken.slice(-4)}`;
  const botFileUrl = `https://files.example.test/file/bot${botToken}/photos/1.jpg`;

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-test-home-");
    const fetchModule = await import("./fetch.js");
    readRemoteMediaBuffer = fetchModule.readRemoteMediaBuffer;
    saveRemoteMedia = fetchModule.saveRemoteMedia;
    saveResponseMedia = fetchModule.saveResponseMedia;
    defaultFetchMediaMaxBytes = fetchModule.DEFAULT_FETCH_MEDIA_MAX_BYTES;
  });

  beforeEach(() => {
    vi.useRealTimers();
    fetchWithSsrFGuardMock.mockReset().mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        url: string;
        fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        init?: RequestInit;
      };
      if (params.url.startsWith("http://127.0.0.1/")) {
        throw new Error("Blocked hostname or private/internal/special-use IP address");
      }
      const fetcher = params.fetchImpl ?? globalThis.fetch;
      if (!fetcher) {
        throw new Error("fetch is not available");
      }
      return {
        response: await fetcher(params.url, params.init),
        finalUrl: params.url,
        release: async () => {},
      };
    });
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  it.each([
    {
      name: "rejects when content-length exceeds maxBytes",
      fetchImpl: async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3, 4, 5])]), {
          status: 200,
          headers: { "content-length": "5" },
        }),
    },
    {
      name: "rejects when streamed payload exceeds maxBytes",
      fetchImpl: async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])]), {
          status: 200,
        }),
    },
  ] as const)("$name", async ({ fetchImpl }) => {
    await expectRemoteMediaMaxBytesError({ fetchImpl, maxBytes: 4 });
  });

  it("applies a default stream limit when maxBytes is omitted", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1])]), {
          status: 200,
          headers: { "content-length": String(defaultFetchMediaMaxBytes + 1) },
        }),
    );

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
      }),
    ).rejects.toThrow(`exceeds maxBytes ${defaultFetchMediaMaxBytes}`);
  });

  it.each([
    {
      name: "redacts bot tokens from fetch failure messages",
      fetchImpl: vi.fn(async () => {
        throw new Error(`dial failed for ${botFileUrl}`);
      }),
      expectedErrorText: `MediaFetchError: Failed to fetch media from https://files.example.test/file/bot${redactedBotToken}/photos/1.jpg: dial failed for https://files.example.test/file/bot${redactedBotToken}/photos/1.jpg`,
    },
    {
      name: "redacts bot tokens from HTTP error messages",
      fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      expectedErrorText: `MediaFetchError: Failed to fetch media from https://files.example.test/file/bot${redactedBotToken}/photos/1.jpg: HTTP 401; body: unauthorized`,
    },
  ] as const)("$name", async ({ fetchImpl, expectedErrorText }) => {
    await expectRedactedBotTokenFetchError({
      botFileUrl,
      botToken,
      expectedErrorText,
      fetchImpl,
    });
  });

  it.each([
    {
      name: "aborts stalled body reads when idle timeout expires",
      lookupFn: vi.fn(async () => ({
        address: "93.184.216.34",
        family: 4,
      })) as unknown as LookupFn,
      fetchImpl: makeStallingFetch(new Uint8Array([1, 2])),
      readIdleTimeoutMs: 20,
      expectedError: {
        code: "fetch_failed",
        name: "MediaFetchError",
      },
    },
  ] as const)("$name", async ({ lookupFn, fetchImpl, readIdleTimeoutMs, expectedError }) => {
    await expectReadRemoteMediaBufferIdleTimeoutCase({
      lookupFn,
      fetchImpl,
      readIdleTimeoutMs,
      expectedError,
    });
  });

  it("retries transient fetch failures when retry is enabled", async () => {
    const transientError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result.buffer.toString()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx responses when retry is enabled", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("busy", { status: 503, statusText: "Service Unavailable" }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result.buffer.toString()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 408 responses when retry is enabled", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("timeout", { status: 408, statusText: "Request Timeout" }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result.buffer.toString()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries transient response body read failures when retry is enabled", async () => {
    const transientError = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(transientError);
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
    });

    expect(result.buffer.toString()).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx responses", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toMatchObject({ code: "http_error", status: 404 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry caller aborts", async () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toMatchObject({ code: "fetch_failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry SSRF guard blocks", async () => {
    const fetchImpl = vi.fn();

    await expect(
      readRemoteMediaBuffer({
        url: "http://127.0.0.1/secret.jpg",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not retry maxBytes failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("large", { status: 200, headers: { "content-length": "5" } }),
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 4,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toMatchObject({ code: "max_bytes" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "bounds error-body snippets instead of reading the full response",
      kind: "bounded-error-body" as const,
      fetchImpl: vi.fn(
        async () =>
          new Response(makeStream([new TextEncoder().encode(`${" ".repeat(9_000)}BAD`)]), {
            status: 400,
            statusText: "Bad Request",
          }),
      ),
    },
    {
      name: "blocks private IP literals before fetching",
      kind: "private-ip-block" as const,
    },
  ] as const)("$name", async (testCase) => {
    if (testCase.kind === "private-ip-block") {
      await expectPrivateIpFetchBlockedCase();
      return;
    }

    await expectBoundedErrorBodyCase(testCase.fetchImpl);
  });

  it("uses trusted explicit-proxy mode when the caller opts in for proxy-side DNS", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const lookupFn = makeLookupFn();
    const dispatcherPolicy = {
      mode: "explicit-proxy" as const,
      proxyUrl: "http://localhost:8888",
      allowPrivateProxy: true,
    };

    await readRemoteMediaBuffer({
      url: "https://files.example.test/file/bot123/photos/test.jpg",
      fetchImpl,
      lookupFn,
      trustExplicitProxyDns: true,
      dispatcherAttempts: [
        {
          dispatcherPolicy,
        },
      ],
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(requireFetchGuardRequest()).toStrictEqual({
      url: "https://files.example.test/file/bot123/photos/test.jpg",
      fetchImpl,
      init: undefined,
      maxRedirects: undefined,
      policy: undefined,
      lookupFn,
      dispatcherPolicy,
      mode: "trusted_explicit_proxy",
    });
  });

  it("passes request timeout through the guarded fetch path", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));

    await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      timeoutMs: 1234,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(requireFetchGuardRequest()).toMatchObject({
      url: "https://example.com/file.bin",
      timeoutMs: 1234,
    });
  });

  it("streams successful responses directly into the media store", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3]), new Uint8Array([4])]), {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="photo"',
            "content-type": "image/png",
          },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("photo");
    expect(saved.contentType).toBe("image/png");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.png$/);
    expect(saved.path).not.toMatch(/photo---/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("saves bodyless successful responses without unbounded buffering", async () => {
    const saved = await saveResponseMedia(new Response(null, { status: 204 }), {
      sourceUrl: "https://example.com/empty",
      fallbackContentType: "application/octet-stream",
      maxBytes: 8,
    });

    expect(saved.size).toBe(0);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.alloc(0));
  });

  it("uses caller filename hints for MIME detection without preserving storage basenames", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://smba.trafficmanager.net/v3/attachments/att-1/views/original",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "document.docx",
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("document.docx");
    expect(saved.contentType).toBe(contentType);
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.docx$/);
    expect(saved.path).not.toMatch(/document---/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([1, 2, 3]));
  });

  it("normalizes Windows-style response filenames and caller hints on POSIX hosts", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: {
            "content-disposition": String.raw`attachment; filename="C:\Users\Ada\Downloads\photo.png"`,
            "content-type": "application/octet-stream",
          },
        }),
    );

    const savedFromHeader = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(savedFromHeader.fileName).toBe("photo.png");

    const savedFromHint = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl: vi.fn(
        async () =>
          new Response(makeStream([new Uint8Array([1, 2, 3])]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
      ),
      lookupFn: makeLookupFn(),
      filePathHint: String.raw`C:\Users\Ada\Downloads\document.docx`,
      maxBytes: 8,
    });

    expect(savedFromHint.fileName).toBe("document.docx");
    expect(savedFromHint.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
  });

  it("does not let filename hints force stored extensions before byte sniffing", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([jpeg]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/views/original",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "document.docx",
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("document.docx");
    expect(saved.contentType).toBe("image/jpeg");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.jpg$/);
    expect(saved.path).not.toMatch(/\.docx$/);
    expect(saved.path).not.toMatch(/document---/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(jpeg);
  });

  it("preserves explicit original filenames when saving streams", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://smba.trafficmanager.net/v3/attachments/att-1/views/original",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "document.docx",
      fallbackContentType: contentType,
      originalFilename: "document.docx",
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("document.docx");
    expect(saved.contentType).toBe(contentType);
    expect(saved.path).toMatch(/document---.+\.docx$/);
  });

  it("uses fallback content type when streamed response headers are generic", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([4, 5, 6])]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/views/original",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "document",
      fallbackContentType: contentType,
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("document");
    expect(saved.contentType).toBe(contentType);
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.docx$/);
    expect(saved.path).not.toMatch(/document---/);
  });

  it("uses audio fallback content type when streamed response headers report matching video container", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([7, 8, 9])]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/voice.mp4",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "voice.mp4",
      fallbackContentType: "audio/mp4",
      maxBytes: 8,
    });

    expect(saved.contentType).toBe("audio/mp4");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.m4a$/);
  });

  it("cancels streamed response bodies when media save exceeds maxBytes", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.enqueue(new Uint8Array([4, 5, 6]));
            },
            cancel,
          }),
          { status: 200 },
        ),
    );

    await expect(
      saveRemoteMedia({
        url: "https://example.com/large.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 4,
      }),
    ).rejects.toThrow("exceeds maxBytes");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("retries saveRemoteMedia after a transient fetch failure", async () => {
    const transientError = Object.assign(new TypeError("socket reset"), { code: "ECONNRESET" });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce(
        new Response(makeStream([new Uint8Array([5, 6])]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
    const onRetry = vi.fn();

    const saved = await saveRemoteMedia({
      url: "https://example.com/retry.png",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0, onRetry },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(saved.contentType).toBe("image/png");
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([5, 6]));
  });

  it("does not retry permanent media limit failures", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3, 4, 5])]), {
          status: 200,
          headers: { "content-length": "5" },
        }),
    );

    await expect(
      saveRemoteMedia({
        url: "https://example.com/too-large.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 4,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow("exceeds maxBytes");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
