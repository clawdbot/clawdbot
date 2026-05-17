import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import { createMatrixGuardedFetch, performMatrixRequest } from "./transport.js";

const TEST_UNDICI_RUNTIME_DEPS_KEY = "__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__";

function clearTestUndiciRuntimeDepsOverride(): void {
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
}

function stubRuntimeFetch(fetchImpl: typeof fetch): void {
  (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
    Agent: function MockAgent() {},
    EnvHttpProxyAgent: function MockEnvHttpProxyAgent() {},
    ProxyAgent: function MockProxyAgent() {},
    fetch: fetchImpl,
  };
}

describe("performMatrixRequest", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    clearTestUndiciRuntimeDepsOverride();
  });

  afterEach(() => {
    clearTestUndiciRuntimeDepsOverride();
  });

  it("rejects oversized raw responses before buffering the whole body", async () => {
    stubRuntimeFetch(
      vi.fn(
        async () =>
          new Response("too-big", {
            status: 200,
            headers: {
              "content-length": "8192",
            },
          }),
      ),
    );

    await expect(
      performMatrixRequest({
        homeserver: "http://127.0.0.1:8008",
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/media/v3/download/example/id",
        timeoutMs: 5000,
        raw: true,
        maxBytes: 1024,
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
  });

  it("applies streaming byte limits when raw responses omit content-length", async () => {
    const chunk = new Uint8Array(768);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    stubRuntimeFetch(
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
          }),
      ),
    );

    await expect(
      performMatrixRequest({
        homeserver: "http://127.0.0.1:8008",
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/media/v3/download/example/id",
        timeoutMs: 5000,
        raw: true,
        maxBytes: 1024,
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
  });

  it("uses the matrix-specific idle-timeout error for stalled raw downloads", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      });
      stubRuntimeFetch(
        vi.fn(
          async () =>
            new Response(stream, {
              status: 200,
            }),
        ),
      );

      const requestPromise = performMatrixRequest({
        homeserver: "http://127.0.0.1:8008",
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/media/v3/download/example/id",
        timeoutMs: 5000,
        raw: true,
        maxBytes: 1024,
        readIdleTimeoutMs: 50,
        ssrfPolicy: { allowPrivateNetwork: true },
      });

      const rejection = expect(requestPromise).rejects.toThrow(
        "Matrix media download stalled: no data received for 50ms",
      );
      await vi.advanceTimersByTimeAsync(60);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  it("uses undici runtime fetch for pinned Matrix requests so the dispatcher stays bound", async () => {
    let ambientFetchCalls = 0;
    vi.stubGlobal("fetch", (async () => {
      ambientFetchCalls += 1;
      throw new Error("expected pinned Matrix requests to avoid ambient fetch");
    }) as typeof fetch);
    const runtimeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      expect(
        (requestInit.dispatcher as { constructor?: { name?: string } } | undefined)?.constructor
          ?.name,
      ).toBe("MockAgent");
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });
    stubRuntimeFetch(runtimeFetch);

    const result = await performMatrixRequest({
      homeserver: "http://127.0.0.1:8008",
      accessToken: "token",
      method: "GET",
      endpoint: "/_matrix/client/v3/account/whoami",
      timeoutMs: 5000,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result.text).toBe('{"ok":true}');
    expect(ambientFetchCalls).toBe(0);
    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    const dispatcher = (
      runtimeFetch.mock.calls.at(0)?.[1] as RequestInit & { dispatcher?: unknown }
    )?.dispatcher;
    expect((dispatcher as { constructor?: { name?: string } } | undefined)?.constructor?.name).toBe(
      "MockAgent",
    );
  });
});

describe("createMatrixGuardedFetch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    clearTestUndiciRuntimeDepsOverride();
  });

  afterEach(() => {
    clearTestUndiciRuntimeDepsOverride();
  });

  it("strips matrix-js-sdk state_after sync opt-in from /sync requests", async () => {
    const runtimeFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
    );
    stubRuntimeFetch(runtimeFetch);

    const guardedFetch = createMatrixGuardedFetch({
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await guardedFetch(
      "http://127.0.0.1:8008/_matrix/client/v3/sync?filter=abc&org.matrix.msc4222.use_state_after=true&timeout=30000",
    );

    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(runtimeFetch.mock.calls.at(0)?.[0]).toBe(
      "http://127.0.0.1:8008/_matrix/client/v3/sync?filter=abc&timeout=30000",
    );
  });

  it("leaves non-sync Matrix requests unchanged", async () => {
    const runtimeFetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("{}", {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
    );
    stubRuntimeFetch(runtimeFetch);

    const guardedFetch = createMatrixGuardedFetch({
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    const url =
      "http://127.0.0.1:8008/_matrix/client/v3/account/whoami?org.matrix.msc4222.use_state_after=true";
    await guardedFetch(url);

    expect(runtimeFetch).toHaveBeenCalledTimes(1);
    expect(runtimeFetch.mock.calls.at(0)?.[0]).toBe(url);
  });
});
