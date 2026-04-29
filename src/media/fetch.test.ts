import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
type FetchRemoteMedia = FetchModule["fetchRemoteMedia"];
type LookupFn = NonNullable<Parameters<FetchRemoteMedia>[0]["lookupFn"]>;
let fetchRemoteMedia: FetchRemoteMedia;
let defaultFetchMediaMaxBytes: number;

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

async function expectRemoteMediaMaxBytesError(params: {
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"];
  maxBytes: number;
}) {
  await expect(
    fetchRemoteMedia({
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
  redactedBotToken: string;
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"];
}) {
  const error = await fetchRemoteMedia({
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
  expect(errorText).toContain(`bot${params.redactedBotToken}`);
}

async function expectFetchRemoteMediaRejected(params: {
  url: string;
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"];
  maxBytes?: number;
  readIdleTimeoutMs?: number;
  lookupFn?: LookupFn;
  expectedError: RegExp | string | Record<string, unknown>;
}) {
  const rejection = expect(
    fetchRemoteMedia({
      url: params.url,
      fetchImpl: params.fetchImpl,
      lookupFn: params.lookupFn ?? makeLookupFn(),
      maxBytes: params.maxBytes ?? 1024,
      ...(params.readIdleTimeoutMs ? { readIdleTimeoutMs: params.readIdleTimeoutMs } : {}),
    }),
  ).rejects;
  if (params.expectedError instanceof RegExp || typeof params.expectedError === "string") {
    await rejection.toThrow(params.expectedError);
    return;
  }
  await rejection.toMatchObject(params.expectedError);
}

async function expectFetchRemoteMediaResolvesToError(
  params: Parameters<typeof fetchRemoteMedia>[0],
): Promise<Error> {
  const result = await fetchRemoteMedia(params).catch((err: unknown) => err);
  expect(result).toBeInstanceOf(Error);
  if (!(result instanceof Error)) {
    expect.unreachable("expected fetchRemoteMedia to reject");
  }
  return result;
}

async function expectFetchRemoteMediaIdleTimeoutCase(params: {
  lookupFn: LookupFn;
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"];
  readIdleTimeoutMs: number;
  expectedError: Record<string, unknown>;
}) {
  vi.useFakeTimers();
  try {
    const rejection = expectFetchRemoteMediaRejected({
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
  fetchImpl: Parameters<typeof fetchRemoteMedia>[0]["fetchImpl"],
) {
  const result = await expectFetchRemoteMediaResolvesToError(
    createFetchRemoteMediaParams({
      url: "https://example.com/file.bin",
      fetchImpl,
    }),
  );
  expect(result.message).not.toContain("BAD");
  expect(result.message).not.toContain("body:");
}

async function expectPrivateIpFetchBlockedCase() {
  const fetchImpl = vi.fn();
  await expectFetchRemoteMediaRejected({
    url: "http://127.0.0.1/secret.jpg",
    fetchImpl,
    expectedError: /private|internal|blocked/i,
  });
  expect(fetchImpl).not.toHaveBeenCalled();
}

function createFetchRemoteMediaParams(
  params: Omit<Parameters<typeof fetchRemoteMedia>[0], "lookupFn"> & { lookupFn?: LookupFn },
) {
  return {
    lookupFn: params.lookupFn ?? makeLookupFn(),
    maxBytes: 1024,
    ...params,
  };
}

describe("fetchRemoteMedia", () => {
  const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd";
  const redactedBotToken = `${botToken.slice(0, 6)}…${botToken.slice(-4)}`;
  const botFileUrl = `https://files.example.test/file/bot${botToken}/photos/1.jpg`;

  beforeAll(async () => {
    const fetchModule = await import("./fetch.js");
    fetchRemoteMedia = fetchModule.fetchRemoteMedia;
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
      fetchRemoteMedia({
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
    },
    {
      name: "redacts bot tokens from HTTP error messages",
      fetchImpl: vi.fn(async () => new Response("unauthorized", { status: 401 })),
    },
  ] as const)("$name", async ({ fetchImpl }) => {
    await expectRedactedBotTokenFetchError({
      botFileUrl,
      botToken,
      redactedBotToken,
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
    await expectFetchRemoteMediaIdleTimeoutCase({
      lookupFn,
      fetchImpl,
      readIdleTimeoutMs,
      expectedError,
    });
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

    await fetchRemoteMedia({
      url: "https://files.example.test/file/bot123/photos/test.jpg",
      fetchImpl,
      lookupFn: makeLookupFn(),
      trustExplicitProxyDns: true,
      dispatcherAttempts: [
        {
          dispatcherPolicy: {
            mode: "explicit-proxy",
            proxyUrl: "http://localhost:8888",
            allowPrivateProxy: true,
          },
        },
      ],
    });

    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "trusted_explicit_proxy",
        dispatcherPolicy: expect.objectContaining({
          mode: "explicit-proxy",
          proxyUrl: "http://localhost:8888",
        }),
      }),
    );
  });
});
