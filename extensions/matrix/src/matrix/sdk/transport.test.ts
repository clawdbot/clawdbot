// Matrix tests cover transport plugin behavior.
import http from "node:http";
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
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    stubRuntimeFetch(
      vi.fn(
        async () =>
          new Response(stream, {
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
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects malformed raw content-length before buffering the body", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    stubRuntimeFetch(
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            headers: new Headers({ "content-length": "0x3" }),
            arrayBuffer,
          }) as unknown as Response,
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
    ).rejects.toThrow("invalid content-length header: 0x3");
    expect(arrayBuffer).not.toHaveBeenCalled();
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

  it("rejects oversized JSON responses via content-length before buffering the body", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    stubRuntimeFetch(
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: {
              "content-type": "application/json",
              "content-length": String(16 * 1024 * 1024),
            },
          }),
      ),
    );

    await expect(
      performMatrixRequest({
        homeserver: "http://127.0.0.1:8008",
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/client/v3/account/whoami",
        timeoutMs: 5000,
        maxBytes: 1024,
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toThrow("Matrix JSON response exceeds configured size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("applies streaming byte limits when JSON responses omit content-length", async () => {
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
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      performMatrixRequest({
        homeserver: "http://127.0.0.1:8008",
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/client/v3/account/whoami",
        timeoutMs: 5000,
        maxBytes: 1024,
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toThrow(
      "Matrix JSON response exceeds configured size limit (1536 bytes > 1024 bytes)",
    );
  });

  it("uses the JSON-specific idle-timeout error for stalled JSON downloads", async () => {
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
              headers: { "content-type": "application/json" },
            }),
        ),
      );

      const requestPromise = performMatrixRequest({
        homeserver: "http://127.0.0.1:8008",
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/client/v3/account/whoami",
        timeoutMs: 5000,
        maxBytes: 1024,
        readIdleTimeoutMs: 50,
        ssrfPolicy: { allowPrivateNetwork: true },
      });

      const rejection = expect(requestPromise).rejects.toThrow(
        "Matrix JSON response stalled: no data received for 50ms",
      );
      await vi.advanceTimersByTimeAsync(60);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 5_000);

  it("rejects oversized raw responses when maxBytes is not provided (default MATRIX_SDK_RESPONSE_MAX_BYTES)", async () => {
    // MATRIX_SDK_RESPONSE_MAX_BYTES = 64 * 1024 * 1024; declare a Content-Length above that
    const overCapBytes = 64 * 1024 * 1024 + 1;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    stubRuntimeFetch(
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: {
              "content-length": String(overCapBytes),
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
        // intentionally omitting maxBytes — fix should apply MATRIX_SDK_RESPONSE_MAX_BYTES
        ssrfPolicy: { allowPrivateNetwork: true },
      }),
    ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns raw buffer bodies that stay under the default MATRIX_SDK_RESPONSE_MAX_BYTES limit", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
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

    const result = await performMatrixRequest({
      homeserver: "http://127.0.0.1:8008",
      accessToken: "token",
      method: "GET",
      endpoint: "/_matrix/media/v3/download/example/id",
      timeoutMs: 5000,
      raw: true,
      // intentionally omitting maxBytes — default cap allows small bodies through
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result.buffer).toEqual(Buffer.from(payload));
  });

  it("real HTTP server: rejects with MatrixMediaSizeLimitError when server declares over-cap Content-Length and maxBytes is omitted", async () => {
    // MATRIX_SDK_RESPONSE_MAX_BYTES = 64 * 1024 * 1024 (64 MiB) — must match transport.ts constant
    const overCapBytes = 64 * 1024 * 1024 + 1; // 67108865 bytes

    const server = http.createServer((_req, res) => {
      // Declare a body larger than the default cap but do not send it —
      // enforceDeclaredResponseSize will abort before any bytes are read.
      res.writeHead(200, { "content-length": String(overCapBytes) });
      res.write(Buffer.alloc(1)); // one sentinel byte; transport cancels before reading more
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as { port: number };

    try {
      // Do NOT call stubRuntimeFetch — real undici + SSRF dispatcher is used here
      await expect(
        performMatrixRequest({
          homeserver: `http://127.0.0.1:${port}`,
          accessToken: "token",
          method: "GET",
          endpoint: "/_matrix/media/v3/download/example/id",
          timeoutMs: 10_000,
          raw: true,
          // intentionally omitting maxBytes — fix applies MATRIX_SDK_RESPONSE_MAX_BYTES as default
          ssrfPolicy: { allowPrivateNetwork: true },
        }),
      ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("real HTTP server: returns raw Buffer when server response is under the default cap and maxBytes is omitted", async () => {
    const payload = Buffer.from("matrix media payload — under cap");

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": String(payload.length) });
      res.end(payload);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as { port: number };

    try {
      // Do NOT call stubRuntimeFetch — real undici path
      const result = await performMatrixRequest({
        homeserver: `http://127.0.0.1:${port}`,
        accessToken: "token",
        method: "GET",
        endpoint: "/_matrix/media/v3/download/example/id",
        timeoutMs: 10_000,
        raw: true,
        // intentionally omitting maxBytes — small body passes through default cap
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      expect(result.buffer).toEqual(payload);
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("returns full JSON bodies that stay under the byte limit", async () => {
    const payload = JSON.stringify({ ok: true, items: [1, 2, 3] });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    stubRuntimeFetch(
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await performMatrixRequest({
      homeserver: "http://127.0.0.1:8008",
      accessToken: "token",
      method: "GET",
      endpoint: "/_matrix/client/v3/account/whoami",
      timeoutMs: 5000,
      maxBytes: 1024,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result.text).toBe(payload);
    expect(result.buffer.toString("utf8")).toBe(payload);
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

  it("preserves redirect success when the discarded body fails to cancel", async () => {
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    const cancel = vi.fn(() => {
      throw new Error("cancel failed");
    });
    const runtimeFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new ReadableStream<Uint8Array>({ cancel }), {
          status: 302,
          headers: { location: "/final" },
        }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    stubRuntimeFetch(runtimeFetch);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      const guardedFetch = createMatrixGuardedFetch({
        ssrfPolicy: { allowPrivateNetwork: true },
      });
      const response = await guardedFetch("http://127.0.0.1:8008/start");

      await expect(response.json()).resolves.toEqual({});
      expect(runtimeFetch).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandledRejections).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      expect(process.listeners("unhandledRejection")).not.toContain(onUnhandledRejection);
    }
  });

  it("rejects and cancels SDK responses above the declared size limit", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    stubRuntimeFetch(
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            headers: { "content-length": String(64 * 1024 * 1024 + 1) },
          }),
      ),
    );

    const guardedFetch = createMatrixGuardedFetch({
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await expect(guardedFetch("http://127.0.0.1:8008/_matrix/client/v3/sync")).rejects.toThrow(
      "Matrix SDK response exceeds size limit (67108865 bytes > 67108864 bytes)",
    );
    expect(cancel).toHaveBeenCalledOnce();
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

    const response = await guardedFetch(
      "http://127.0.0.1:8008/_matrix/client/v3/sync?filter=abc&org.matrix.msc4222.use_state_after=true&timeout=30000",
    );

    await expect(response.json()).resolves.toEqual({});
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

describe("matrix transport streaming OOM guard — real HTTP server without Content-Length", () => {
  // These tests use a real node:http server with NO Content-Length header so that
  // enforceDeclaredResponseSize() is a no-op and readResponseWithLimit() is the
  // sole byte-cap enforcement path. They prove the streaming bound cancels the
  // connection before the full body is buffered (OOM guard).

  beforeEach(() => {
    vi.unstubAllGlobals();
    clearTestUndiciRuntimeDepsOverride();
  });

  afterEach(() => {
    clearTestUndiciRuntimeDepsOverride();
  });

  it("rejects oversized streaming raw response before fully buffering 20 MiB (OOM guard)", async () => {
    const CHUNK = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB per chunk
    const TOTAL_CHUNKS = 20; // 20 MiB total — above 16 MiB cap
    let chunksWritten = 0;

    const server = http.createServer((_req, res) => {
      // Deliberately omit Content-Length so enforceDeclaredResponseSize is a no-op.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      let sent = 0;
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      const sendChunk = () => {
        if (closed) {
          return;
        }
        if (sent >= TOTAL_CHUNKS) {
          res.end();
          return;
        }
        sent++;
        chunksWritten++;
        const ok = res.write(CHUNK);
        const scheduleNextChunk = () => {
          setTimeout(sendChunk, 5);
        };
        if (ok) {
          scheduleNextChunk();
        } else {
          res.once("drain", scheduleNextChunk);
        }
      };
      sendChunk();
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as { port: number };

    try {
      // Do NOT call stubRuntimeFetch — real undici + SSRF dispatcher is used here.
      await expect(
        performMatrixRequest({
          homeserver: `http://127.0.0.1:${port}`,
          accessToken: "token",
          method: "GET",
          endpoint: "/_matrix/media/v3/download/example/id",
          timeoutMs: 30_000,
          raw: true,
          maxBytes: 16 * 1024 * 1024, // 16 MiB cap — readResponseWithLimit enforces this
          ssrfPolicy: { allowPrivateNetwork: true },
        }),
      ).rejects.toBeInstanceOf(MatrixMediaSizeLimitError);
      // Mutation-control: bare response.arrayBuffer() would buffer all 20 MiB.
      // readResponseWithLimit cancels the stream mid-flight so chunksWritten < TOTAL_CHUNKS.
      expect(chunksWritten).toBeLessThan(TOTAL_CHUNKS);
      console.log(
        `[bound-proof] matrix streaming canceled at ${chunksWritten}/${TOTAL_CHUNKS} chunks`,
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 30_000);

  it("reads streaming raw response under the byte cap without Content-Length", async () => {
    const payload = Buffer.from("hello matrix streaming bound proof");

    const server = http.createServer((_req, res) => {
      // Omit Content-Length — only readResponseWithLimit guards body size.
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(payload);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as { port: number };

    try {
      const result = (
        await performMatrixRequest({
          homeserver: `http://127.0.0.1:${port}`,
          accessToken: "token",
          method: "GET",
          endpoint: "/_matrix/media/v3/download/example/id",
          timeoutMs: 10_000,
          raw: true,
          maxBytes: 16 * 1024 * 1024,
          ssrfPolicy: { allowPrivateNetwork: true },
        })
      ).buffer;
      expect(result).toEqual(payload);
      console.log(
        "[matrix-bound-proof] under-cap: raw buffer returned correctly, size=" + result.length,
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
