// Media fetch tests cover remote media download limits and validation.
import fs from "node:fs/promises";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
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

function makeCancelableStream(chunks: Uint8Array[]) {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
    },
    cancel() {
      canceled = true;
    },
  });
  return { stream, wasCanceled: () => canceled };
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

function makeResponseHeaderStallingFetch() {
  return vi.fn(
    async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const rejectForAbort = () => reject(abortReasonError(signal));
        if (signal?.aborted) {
          rejectForAbort();
          return;
        }
        signal?.addEventListener("abort", rejectForAbort, { once: true });
      }),
  );
}

function makeLookupFn(): LookupFn {
  return vi.fn(async () => ({ address: "149.154.167.220", family: 4 })) as unknown as LookupFn;
}

function abortReasonError(signal?: AbortSignal | null): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("request aborted", { cause: signal?.reason });
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
    vi.resetModules();
    tempHome = await createTempHomeEnv("openclaw-test-home-");
    const fetchModule = await import("./fetch.js");
    readRemoteMediaBuffer = fetchModule.readRemoteMediaBuffer;
    saveRemoteMedia = fetchModule.saveRemoteMedia;
    saveResponseMedia = fetchModule.saveResponseMedia;
    // Default cap mirrors the module-private DEFAULT_FETCH_MEDIA_MAX_BYTES.
    defaultFetchMediaMaxBytes = (await import("@openclaw/media-core/constants")).MAX_DOCUMENT_BYTES;
  });

  beforeEach(() => {
    vi.useRealTimers();
    fetchWithSsrFGuardMock.mockReset().mockImplementation(async (paramsUnknown: unknown) => {
      const params = paramsUnknown as {
        url: string;
        fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
        init?: RequestInit;
        signal?: AbortSignal;
      };
      if (params.url.startsWith("http://127.0.0.1/")) {
        throw new Error("Blocked hostname or private/internal/special-use IP address");
      }
      const fetcher = params.fetchImpl ?? globalThis.fetch;
      if (!fetcher) {
        throw new Error("fetch is not available");
      }
      return {
        response: await fetcher(params.url, {
          ...params.init,
          ...(params.signal ? { signal: params.signal } : {}),
        }),
        finalUrl: params.url,
        release: async () => {},
      };
    });
  });

  afterAll(async () => {
    try {
      await tempHome.restore();
    } finally {
      vi.doUnmock("../infra/net/fetch-guard.js");
      vi.resetModules();
    }
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

  it("cancels ignored content-length overflow bodies for remote buffer reads", async () => {
    const body = makeCancelableStream([new Uint8Array([1, 2, 3, 4, 5])]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(body.stream, {
          status: 200,
          headers: { "content-length": "5" },
        }),
    );

    await expectRemoteMediaMaxBytesError({ fetchImpl, maxBytes: 4 });

    expect(body.wasCanceled()).toBe(true);
  });

  it("rejects malformed content-length before remote buffer reads", async () => {
    const body = makeCancelableStream([new Uint8Array([1, 2, 3, 4, 5])]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(body.stream, {
          status: 200,
          headers: { "content-length": "1e9" },
        }),
    );

    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        maxBytes: 4,
        lookupFn: makeLookupFn(),
      }),
    ).rejects.toThrow("invalid content-length header: 1e9");

    expect(body.wasCanceled()).toBe(true);
  });

  it("accepts comma-joined identical content-length values", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("hello", {
          status: 200,
          headers: { "content-length": "5, 5" },
        }),
    );

    const result = await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      maxBytes: 5,
      lookupFn: makeLookupFn(),
    });

    expect(result.buffer.toString()).toBe("hello");
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
        cause: expect.objectContaining({ name: "TimeoutError" }),
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

  it("aborts when response headers exceed their deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = makeResponseHeaderStallingFetch();

      const result = readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        responseHeaderTimeoutMs: 20,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toMatchObject({
        name: "MediaFetchError",
        code: "fetch_failed",
        cause: { name: "TimeoutError" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the default response-header deadline for stalled media", async () => {
    vi.useFakeTimers();
    try {
      const result = readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl: makeResponseHeaderStallingFetch(),
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
      }).catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(15 * 60_000 + 5);

      await expect(result).resolves.toMatchObject({
        name: "MediaFetchError",
        code: "fetch_failed",
        cause: { name: "TimeoutError" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the response-header deadline while a healthy body keeps progressing", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const failForAbort = () => controller.error(signal?.reason);
              if (signal?.aborted) {
                failForAbort();
                return;
              }
              signal?.addEventListener("abort", failForAbort, { once: true });
              setTimeout(() => controller.enqueue(new Uint8Array([1])), 25);
              setTimeout(() => controller.enqueue(new Uint8Array([2])), 50);
              setTimeout(() => {
                signal?.removeEventListener("abort", failForAbort);
                controller.close();
              }, 75);
            },
          }),
          { status: 200 },
        );
      });

      const result = readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        responseHeaderTimeoutMs: 10,
        readIdleTimeoutMs: 30,
      });

      await vi.advanceTimersByTimeAsync(80);

      await expect(result).resolves.toMatchObject({ buffer: Buffer.from([1, 2]) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a parent abort while waiting for response headers", async () => {
    const parent = new AbortController();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectForAbort = () => reject(abortReasonError(signal));
          if (signal?.aborted) {
            rejectForAbort();
            return;
          }
          signal?.addEventListener("abort", rejectForAbort, { once: true });
        }),
    );
    const result = readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      requestInit: { signal: parent.signal },
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      responseHeaderTimeoutMs: 60_000,
    }).catch((error: unknown) => error);

    parent.abort();

    await expect(result).resolves.toMatchObject({
      name: "MediaFetchError",
      code: "fetch_failed",
      cause: { name: "AbortError" },
    });
  });

  it("keeps the parent abort active while reading the response body", async () => {
    const parent = new AbortController();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            const failForAbort = () => controller.error(signal?.reason);
            if (signal?.aborted) {
              failForAbort();
              return;
            }
            signal?.addEventListener("abort", failForAbort, { once: true });
          },
        }),
        { status: 200 },
      );
    });
    const result = readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      requestInit: { signal: parent.signal },
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      responseHeaderTimeoutMs: 60_000,
    }).catch((error: unknown) => error);

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    parent.abort();

    await expect(result).resolves.toMatchObject({
      name: "MediaFetchError",
      code: "fetch_failed",
      cause: { name: "AbortError" },
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

  it("retries a default response-body idle timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2]));
              },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response("ok", { status: 200 }));

      const result = readRemoteMediaBuffer({
        url: "https://example.com/file.bin",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
        readIdleTimeoutMs: 20,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toMatchObject({ buffer: Buffer.from("ok") });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
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
      signal: expect.any(AbortSignal),
    });
  });

  it("passes request timeout through the guarded fetch path", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    const parent = new AbortController();

    await readRemoteMediaBuffer({
      url: "https://example.com/file.bin",
      fetchImpl,
      requestInit: { signal: parent.signal },
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
      timeoutMs: 1234,
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
    expect(requireFetchGuardRequest()).toMatchObject({
      url: "https://example.com/file.bin",
      timeoutMs: 1234,
      signal: parent.signal,
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

  it("preserves content-disposition CSV detection for streamed downloads", async () => {
    const csv = Buffer.from("name,value\nopenclaw,1\n");
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([csv.subarray(0, 8), csv.subarray(8)]), {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="report.csv"',
            "content-type": "application/octet-stream",
          },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 64,
    });

    expect(saved.fileName).toBe("report.csv");
    expect(saved.contentType).toBe("text/csv");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.csv$/);
    expect(saved.path).not.toMatch(/report---/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(csv);
  });

  it("preserves content-disposition CSV detection for provided response streams", async () => {
    const csv = Buffer.from("name,value\nopenclaw,1\n");
    const response = new Response(makeStream([csv.subarray(0, 8), csv.subarray(8)]), {
      status: 200,
      headers: {
        "content-disposition": 'attachment; filename="report.csv"',
        "content-type": "application/octet-stream",
      },
    });

    const saved = await saveResponseMedia(response, {
      sourceUrl: "https://example.com/download",
      maxBytes: 64,
    });

    expect(saved.fileName).toBe("report.csv");
    expect(saved.contentType).toBe("text/csv");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.csv$/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(csv);
  });

  it("preserves content-disposition CSV detection for buffered downloads", async () => {
    const csv = Buffer.from("name,value\nopenclaw,1\n");
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([csv.subarray(0, 8), csv.subarray(8)]), {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="report.csv"',
            "content-type": "application/octet-stream",
          },
        }),
    );

    const media = await readRemoteMediaBuffer({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 64,
    });

    expect(media.fileName).toBe("report.csv");
    expect(media.contentType).toBe("text/csv");
    expect(media.buffer).toStrictEqual(csv);
  });

  it("keeps explicit stream detection hints ahead of content-disposition filenames", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="report.csv"',
            "content-type": "application/octet-stream",
          },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      filePathHint: "document.docx",
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("report.csv");
    expect(saved.contentType).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.docx$/);
    expect(saved.path).not.toMatch(/\.csv$/);
  });

  it("keeps byte-sniffed images ahead of content-disposition stream hints", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([jpeg]), {
          status: 200,
          headers: {
            "content-disposition": 'attachment; filename="report.csv"',
            "content-type": "application/octet-stream",
          },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("report.csv");
    expect(saved.contentType).toBe("image/jpeg");
    expect(saved.path).toMatch(/[a-f0-9-]{36}\.jpg$/);
    expect(saved.path).not.toMatch(/\.csv$/);
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(jpeg);
  });

  it("keeps saving a healthy streaming body after the response-header deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const failForAbort = () => controller.error(signal?.reason);
              if (signal?.aborted) {
                failForAbort();
                return;
              }
              signal?.addEventListener("abort", failForAbort, { once: true });
              setTimeout(() => controller.enqueue(new Uint8Array([1])), 25);
              setTimeout(() => controller.enqueue(new Uint8Array([2])), 50);
              setTimeout(() => {
                signal?.removeEventListener("abort", failForAbort);
                controller.close();
              }, 75);
            },
          }),
          { status: 200, headers: { "content-type": "application/octet-stream" } },
        );
      });
      const result = saveRemoteMedia({
        url: "https://example.com/download",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 8,
        responseHeaderTimeoutMs: 10,
        readIdleTimeoutMs: 30,
      });

      await vi.advanceTimersByTimeAsync(80);

      const saved = await result;
      await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([1, 2]));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the parent abort active while saving the response body", async () => {
    const parent = new AbortController();
    let bodyStarted!: () => void;
    const bodyReady = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
            const failForAbort = () => controller.error(signal?.reason);
            if (signal?.aborted) {
              failForAbort();
              return;
            }
            signal?.addEventListener("abort", failForAbort, { once: true });
            bodyStarted();
          },
        }),
        { status: 200 },
      );
    });
    const result = saveRemoteMedia({
      url: "https://example.com/download",
      fetchImpl,
      requestInit: { signal: parent.signal },
      lookupFn: makeLookupFn(),
      maxBytes: 8,
      responseHeaderTimeoutMs: 60_000,
    }).catch((error: unknown) => error);

    await bodyReady;
    parent.abort();

    await expect(result).resolves.toMatchObject({
      name: "MediaFetchError",
      code: "fetch_failed",
      cause: { name: "AbortError" },
    });
  });

  it("clamps oversized saved-response idle timeout timers", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const fetchImpl = vi.fn(
        async () =>
          new Response(makeStream([new Uint8Array([1, 2, 3])]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
      );

      const saved = await saveRemoteMedia({
        url: "https://example.com/download",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 8,
        readIdleTimeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
      });

      await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([1, 2, 3]));
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("cancels ignored content-length overflow bodies for saved responses", async () => {
    const body = makeCancelableStream([new Uint8Array([1, 2, 3, 4, 5])]);

    await expect(
      saveResponseMedia(
        new Response(body.stream, {
          status: 200,
          headers: { "content-length": "5" },
        }),
        {
          maxBytes: 4,
          sourceUrl: "https://example.com/file.bin",
        },
      ),
    ).rejects.toThrow("content length 5 exceeds maxBytes 4");

    expect(body.wasCanceled()).toBe(true);
  });

  it("rejects malformed content-length before saving responses", async () => {
    const body = makeCancelableStream([new Uint8Array([1, 2, 3, 4, 5])]);

    await expect(
      saveResponseMedia(
        new Response(body.stream, {
          status: 200,
          headers: { "content-length": "1e9" },
        }),
        {
          maxBytes: 4,
          sourceUrl: "https://example.com/file.bin",
        },
      ),
    ).rejects.toThrow("invalid content-length header: 1e9");

    expect(body.wasCanceled()).toBe(true);
  });

  it("decodes URL path basenames when deriving remote media filenames", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/files/My%20Report.pdf",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("My Report.pdf");
  });

  it("keeps raw URL path basenames when percent escapes are malformed", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    );

    const saved = await saveRemoteMedia({
      url: "https://example.com/files/bad%E0%A4%A.pdf",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    });

    expect(saved.fileName).toBe("bad%E0%A4%A.pdf");
  });

  it.each([
    ["https://example.com/files/reports%2FQ1.pdf", "reports_Q1.pdf"],
    ["https://example.com/files/reports%5CQ1.pdf", "reports_Q1.pdf"],
    ["https://example.com/files/reports%2F%2FQ1.pdf", "reports__Q1.pdf"],
  ])(
    "keeps decoded URL fallback separators inside the selected basename",
    async (url, fileName) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(makeStream([new Uint8Array([1, 2, 3])]), {
            status: 200,
            headers: { "content-type": "application/pdf" },
          }),
      );

      const saved = await saveRemoteMedia({
        url,
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 8,
      });

      expect(saved.fileName).toBe(fileName);
    },
  );

  it.each([
    {
      name: "quoted filename containing a semicolon",
      header: 'attachment; filename="quarter;final.csv"',
      fileName: "quarter;final.csv",
    },
    {
      name: "quoted filename containing an escaped quotation mark",
      header: String.raw`attachment; filename="quarter\"final.csv"`,
      fileName: 'quarter"final.csv',
    },
    {
      name: "quoted filename containing an escaped semicolon",
      header: String.raw`attachment; filename="quarter\;final.csv"`,
      fileName: "quarter;final.csv",
    },
    {
      name: "quoted filename containing an escaped comma",
      header: String.raw`attachment; filename="quarter\,final.csv"`,
      fileName: "quarter,final.csv",
    },
    {
      name: "quoted filename containing an escaped space",
      header: String.raw`attachment; filename="quarter\ final.csv"`,
      fileName: "quarter final.csv",
    },
    {
      name: "quoted filename containing an escaped hyphen",
      header: String.raw`attachment; filename="quarter\-final.csv"`,
      fileName: "quarter-final.csv",
    },
    {
      name: "quoted filename containing multiple escaped punctuation characters",
      header: String.raw`attachment; filename="quarter\ final\,v2.csv"`,
      fileName: "quarter final,v2.csv",
    },
    {
      name: "filename text inside an unrelated quoted parameter is ignored",
      header: 'attachment; note="x; filename=spoof.csv; y"; filename=safe.csv',
      fileName: "safe.csv",
    },
    {
      name: "Windows drive paths still decode escaped punctuation",
      header: String.raw`attachment; filename="C:/tmp/quarter\;final.csv"`,
      fileName: "quarter;final.csv",
    },
    {
      name: "mixed Windows path separators preserve the final basename",
      header: String.raw`attachment; filename="C:/tmp/reports\Q1.csv"`,
      fileName: "Q1.csv",
    },
    {
      name: "mixed relative Windows path separators preserve the final basename",
      header: String.raw`attachment; filename="reports/2026\Q1.csv"`,
      fileName: "Q1.csv",
    },
    {
      name: "legacy UNC Windows path is reduced to its basename",
      header: String.raw`attachment; filename="\\server\share\photo.csv"`,
      fileName: "photo.csv",
    },
    {
      name: "legacy UNC Windows path preserves a Unicode-leading basename",
      header: String.raw`attachment; filename="\\server\share\é.csv"`,
      fileName: "é.csv",
    },
    {
      name: "legacy UNC Windows path preserves a punctuation-leading basename",
      header: String.raw`attachment; filename="\\server\share\;photo.csv"`,
      fileName: ";photo.csv",
    },
    {
      name: "legacy UNC Windows path preserves a space-leading basename",
      header: String.raw`attachment; filename="\\server\share\ photo.csv"`,
      fileName: " photo.csv",
    },
    {
      name: "legacy relative Windows path is reduced to its basename",
      header: String.raw`attachment; filename="reports\Q1.csv"`,
      fileName: "Q1.csv",
    },
    {
      name: "nested legacy relative Windows path is reduced to its basename",
      header: String.raw`attachment; filename="reports\2026\Q1.csv"`,
      fileName: "Q1.csv",
    },
    {
      name: "UTF-8 filename with a language tag",
      header: "attachment; filename*=UTF-8'en'%E2%82%ACrates.csv",
      fileName: "€rates.csv",
    },
    {
      name: "ISO-8859-1 extended filename",
      header: "attachment; filename*=ISO-8859-1''caf%E9.csv",
      fileName: "café.csv",
    },
    {
      name: "valid extended filename preferred over plain fallback",
      header: "attachment; filename=legacy.csv; filename*=UTF-8'en'%E2%82%ACrates.csv",
      fileName: "€rates.csv",
    },
    {
      name: "malformed extended filename falls back to plain filename",
      header: "attachment; filename=fallback.csv; filename*=UTF-8''%ZZbad.csv",
      fileName: "fallback.csv",
    },
    {
      name: "unsupported extended charset falls back to plain filename",
      header: "attachment; filename*=UTF-16''bad.csv; filename=fallback.csv",
      fileName: "fallback.csv",
    },
  ] as const)("parses $name for buffered and stored remote media", async (testCase) => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(makeStream([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: {
            "content-disposition": testCase.header,
            "content-type": "text/csv",
          },
        }),
    );
    const request = {
      url: "https://example.com/download",
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 8,
    };

    const buffered = await readRemoteMediaBuffer(request);
    const stored = await saveRemoteMedia(request);

    expect(buffered.fileName).toBe(testCase.fileName);
    expect(stored.fileName).toBe(testCase.fileName);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [`attachment; filename*=UTF-8''reports%2FQ1.pdf`, "reports_Q1.pdf"],
    [`attachment; filename*=UTF-8''reports%5CQ1.pdf`, "reports_Q1.pdf"],
    [`attachment; filename*=UTF-8''reports%2F%2FQ1.pdf`, "reports__Q1.pdf"],
  ])(
    "keeps decoded content-disposition filename* separators inside the selected filename",
    async (contentDisposition, fileName) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(makeStream([new Uint8Array([1, 2, 3])]), {
            status: 200,
            headers: {
              "content-disposition": contentDisposition,
              "content-type": "application/pdf",
            },
          }),
      );

      const saved = await saveRemoteMedia({
        url: "https://example.com/download",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 8,
      });

      expect(saved.fileName).toBe(fileName);
    },
  );

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

  it("retries against the original file even when the 400 response body was drained (managed-media store path)", async () => {
    // Production reaches saveRemoteMedia through the managed-media store, whose fetch
    // wrapper replaces every non-OK response with an EMPTY body (store.remote.runtime.ts).
    // Simulate that: the 400 carries no body, so there is no "thumbnail sizes" text to
    // match — the original-file retry must still fire (the old body-text predicate could
    // not, leaving the fix dead on the real outgoing-reply path).
    const thumbUrl =
      "https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/007_American_Pit_Bull_Terrier.jpg/800px-007_American_Pit_Bull_Terrier.jpg";
    const originalUrl =
      "https://upload.wikimedia.org/wikipedia/commons/8/88/007_American_Pit_Bull_Terrier.jpg";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(
        new Response(makeStream([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      );

    const saved = await saveRemoteMedia({
      url: thumbUrl,
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(thumbUrl);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(originalUrl);
    expect(saved.contentType).toBe("image/jpeg");
    await expect(fs.readFile(saved.path)).resolves.toStrictEqual(Buffer.from([1, 2, 3]));
  });

  it("does not rewrite non-upload.wikimedia.org hosts (guards the endsWith overmatch)", async () => {
    const plainFetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      saveRemoteMedia({
        url: "https://example.com/image.jpg",
        fetchImpl: plainFetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "http_error", status: 400 });
    expect(plainFetchImpl).toHaveBeenCalledTimes(1);

    // endsWith("wikimedia.org") would wrongly accept this look-alike host and issue a
    // second fetch against a different origin; the exact-host check must reject it.
    const evilFetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      saveRemoteMedia({
        url: "https://evilwikimedia.org/wikipedia/commons/thumb/e/e7/x.jpg/800px-x.jpg",
        fetchImpl: evilFetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "http_error", status: 400 });
    expect(evilFetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original thumbnail error when the original file also fails", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      saveRemoteMedia({
        url: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/x.jpg/800px-x.jpg",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "http_error", status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // readRemoteMediaBuffer is the OTHER Wikimedia-fetching path — the one Telegram
  // reply delivery actually uses (via loadWebMedia), distinct from saveRemoteMedia's
  // managed-media-store path above. The original fix only wrapped saveRemoteMedia, so
  // a rejected Wikimedia thumbnail could still abort a Telegram reply before its text
  // sent, on exactly the route the original bug report described. These three tests
  // mirror the saveRemoteMedia Wikimedia tests above, against readRemoteMediaBuffer.
  it("retries against the original file even when the 400 response body was drained (readRemoteMediaBuffer / Telegram reply path)", async () => {
    const thumbUrl =
      "https://upload.wikimedia.org/wikipedia/commons/thumb/8/88/007_American_Pit_Bull_Terrier.jpg/800px-007_American_Pit_Bull_Terrier.jpg";
    const originalUrl =
      "https://upload.wikimedia.org/wikipedia/commons/8/88/007_American_Pit_Bull_Terrier.jpg";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(
        new Response(makeStream([new Uint8Array([1, 2, 3])]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        }),
      );

    const result = await readRemoteMediaBuffer({
      url: thumbUrl,
      fetchImpl,
      lookupFn: makeLookupFn(),
      maxBytes: 1024,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(thumbUrl);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(originalUrl);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.buffer).toStrictEqual(Buffer.from([1, 2, 3]));
  });

  it("does not rewrite non-upload.wikimedia.org hosts in readRemoteMediaBuffer (guards the endsWith overmatch)", async () => {
    const plainFetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      readRemoteMediaBuffer({
        url: "https://example.com/image.jpg",
        fetchImpl: plainFetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "http_error", status: 400 });
    expect(plainFetchImpl).toHaveBeenCalledTimes(1);

    const evilFetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      readRemoteMediaBuffer({
        url: "https://evilwikimedia.org/wikipedia/commons/thumb/e/e7/x.jpg/800px-x.jpg",
        fetchImpl: evilFetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "http_error", status: 400 });
    expect(evilFetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces the original thumbnail error when the original file also fails (readRemoteMediaBuffer)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      readRemoteMediaBuffer({
        url: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e7/x.jpg/800px-x.jpg",
        fetchImpl,
        lookupFn: makeLookupFn(),
        maxBytes: 1024,
      }),
    ).rejects.toMatchObject({ code: "http_error", status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
