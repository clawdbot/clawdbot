// Runtime proxy tests cover SSE parsing, terminal error handling, and request
// payload scrubbing before proxying model streams.
import { once } from "node:events";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model, Usage } from "../../llm/types.js";
import { streamProxy } from "./proxy.js";

const usage: Usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model = {
  id: "test-model",
  name: "Test Model",
  provider: "test",
  api: "openai-responses",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1024,
  maxTokens: 1024,
};

const context: Context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function responseFromText(text: string): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

function responseFromReaderText(text: string, releaseLock: () => void): Response {
  const chunks: Array<ReadableStreamReadResult<Uint8Array>> = [
    { done: false, value: new TextEncoder().encode(text) },
    { done: true, value: undefined },
  ];
  const reader = {
    read: async () => chunks.shift() ?? { done: true, value: undefined },
    cancel: async () => undefined,
    releaseLock,
  } as ReadableStreamDefaultReader<Uint8Array>;

  return {
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  } as Response;
}

const unresolved = Symbol("unresolved stream result");

function pendingReaderResponse(params: {
  chunks: Uint8Array[];
  status?: number;
  statusText?: string;
  onCancel?: (reason?: unknown) => void;
}): Response {
  const chunks = [...params.chunks];
  const reader = {
    read: vi.fn(async () => {
      const chunk = chunks.shift();
      if (chunk) {
        return { done: false, value: chunk };
      }
      return await new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
    }),
    cancel: vi.fn(async (reason?: unknown) => {
      params.onCancel?.(reason);
    }),
    releaseLock: vi.fn(),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;

  return {
    ok: (params.status ?? 200) >= 200 && (params.status ?? 200) < 300,
    status: params.status ?? 200,
    statusText: params.statusText ?? "OK",
    body: { getReader: () => reader },
  } as Response;
}

async function resultWithinMs(
  stream: { result(): Promise<unknown> },
  timeoutMs = 25,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stream.result(),
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(unresolved), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function settledResult(stream: { result(): Promise<unknown> }): Promise<unknown> {
  return await Promise.race([stream.result(), Promise.resolve(unresolved)]);
}

describe("streamProxy", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reconstructs a text signature from text_start before streamed deltas", async () => {
    const contentSignature = JSON.stringify({
      v: 1,
      id: "item-commentary",
      phase: "commentary",
    });
    const proxyEvents = [
      { type: "text_start", contentIndex: 0, contentSignature },
      { type: "text_delta", contentIndex: 0, delta: "Working..." },
      { type: "text_end", contentIndex: 0 },
      { type: "done", reason: "stop", usage },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFromText(proxyEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "text", text: "Working...", textSignature: contentSignature }],
    });
  });

  it("flushes a final SSE frame without a trailing newline", async () => {
    // Provider proxies can close immediately after the last SSE frame; the
    // parser still has to emit the terminal done event.
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responseFromText(
        `data: ${JSON.stringify({
          type: "done",
          reason: "stop",
          usage,
        })}`,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const options = {
      authToken: "token",
      headers: { Authorization: "Bearer upstream", "x-api-key": "secret" },
      proxyUrl: "https://proxy.example",
    };
    const stream = streamProxy(model, context, options);
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("done");
    await expect(stream.result()).resolves.toMatchObject({
      role: "assistant",
      stopReason: "stop",
      usage,
    });
    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(rawBody as string) as {
      model?: { headers?: unknown };
      options?: { headers?: unknown; promptCacheKey?: string };
    };
    expect(body.options).not.toHaveProperty("headers");
    expect(body.options?.promptCacheKey).toBeUndefined();
    expect(body.model).not.toHaveProperty("headers");
  });

  it("forwards prompt cache affinity separately from session identity", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      responseFromText(
        `data: ${JSON.stringify({
          type: "done",
          reason: "stop",
          usage,
        })}`,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
    }).result();

    const rawBody = fetchMock.mock.calls[0]?.[1]?.body;
    expect(typeof rawBody).toBe("string");
    const body = JSON.parse(rawBody as string) as {
      options?: { promptCacheKey?: string; sessionId?: string };
    };
    expect(body.options).toMatchObject({
      sessionId: "run-session",
      promptCacheKey: "stable-cache-key",
    });
  });

  it("applies timeoutMs before proxy response headers arrive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(
              signal.reason instanceof Error ? signal.reason : new Error("Request was aborted"),
            );
          });
        });
      }),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
      timeoutMs: 5,
    });
    await vi.advanceTimersByTimeAsync(5);

    expect(await settledResult(stream)).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy request timed out after 5ms",
    });
  });

  it("bounds non-2xx proxy JSON error reads", async () => {
    const firstChunk = new TextEncoder().encode(`{"error":"${"x".repeat(17 * 1024 * 1024)}`);
    let cancelled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        pendingReaderResponse({
          chunks: [firstChunk],
          status: 502,
          statusText: "Bad Gateway",
          onCancel: () => {
            cancelled = true;
          },
        }),
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });

    expect(await resultWithinMs(stream)).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy error body exceeded 16777216 bytes",
    });
    expect(cancelled).toBe(true);
  });

  it("caps unterminated pending SSE bytes before a frame delimiter arrives", async () => {
    const overLimitFrame = new TextEncoder().encode(`data: ${"x".repeat(17 * 1024 * 1024)}`);
    let cancelReason: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        pendingReaderResponse({
          chunks: [overLimitFrame],
          onCancel: (reason) => {
            cancelReason = reason;
          },
        }),
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });

    expect(await resultWithinMs(stream)).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy SSE stream exceeded 16777216 bytes",
    });
    expect(cancelReason).toBeInstanceOf(Error);
  });

  it("caps delimiter-terminated SSE success body bytes", async () => {
    const overLimitFrame = new TextEncoder().encode(`data: ${"x".repeat(17 * 1024 * 1024)}\n`);
    let cancelReason: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        pendingReaderResponse({
          chunks: [overLimitFrame],
          onCancel: (reason) => {
            cancelReason = reason;
          },
        }),
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });

    expect(await resultWithinMs(stream)).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy SSE stream exceeded 16777216 bytes",
    });
    expect(cancelReason).toBeInstanceOf(Error);
  });

  it("re-arms the SSE idle timeout after each received chunk", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let secondReadResolve: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    let thirdReadResolve: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    const cancel = vi.fn(async () => undefined);
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: encoder.encode("data: ") })
        .mockImplementationOnce(
          () =>
            new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
              secondReadResolve = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
              thirdReadResolve = resolve;
            }),
        ),
      cancel,
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            body: { getReader: () => reader },
          }) as Response,
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });

    await vi.advanceTimersByTimeAsync(119_000);
    expect(cancel).not.toHaveBeenCalled();
    secondReadResolve?.({
      done: false,
      value: encoder.encode(
        `${JSON.stringify({
          type: "done",
          reason: "stop",
          usage,
        })}\n\n`,
      ),
    });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(cancel).not.toHaveBeenCalled();
    thirdReadResolve?.({ done: true, value: undefined });

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "stop",
      usage,
    });
  });

  it("does not apply the pre-header timeout as an absolute stream deadline", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let secondReadResolve: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    let thirdReadResolve: ((result: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    const cancel = vi.fn(async () => undefined);
    const reader = {
      read: vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: encoder.encode("data: ") })
        .mockImplementationOnce(
          () =>
            new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
              secondReadResolve = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
              thirdReadResolve = resolve;
            }),
        ),
      cancel,
      releaseLock: vi.fn(),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            body: { getReader: () => reader },
          }) as Response,
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
      timeoutMs: 5,
    });

    await vi.advanceTimersByTimeAsync(4);
    expect(cancel).not.toHaveBeenCalled();
    secondReadResolve?.({
      done: false,
      value: encoder.encode(
        `${JSON.stringify({
          type: "done",
          reason: "stop",
          usage,
        })}\n\n`,
      ),
    });
    await vi.advanceTimersByTimeAsync(4);
    expect(cancel).not.toHaveBeenCalled();
    thirdReadResolve?.({ done: true, value: undefined });

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "stop",
      usage,
    });
  });

  it("returns an error result when the SSE read idles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            body: {
              getReader: () =>
                ({
                  read: vi.fn(
                    async () => await new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
                  ),
                  cancel,
                  releaseLock: vi.fn(),
                }) as unknown as ReadableStreamDefaultReader<Uint8Array>,
            },
          }) as Response,
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await settledResult(stream)).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy SSE stream stalled: no data received for 120000ms",
    });
    expect(cancel).toHaveBeenCalledWith(expect.any(Error));
  });

  it("honors a longer configured SSE read idle timeout", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            body: {
              getReader: () =>
                ({
                  read: vi.fn(
                    async () => await new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
                  ),
                  cancel,
                  releaseLock: vi.fn(),
                }) as unknown as ReadableStreamDefaultReader<Uint8Array>,
            },
          }) as Response,
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
      timeoutMs: 180_000,
    });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await settledResult(stream)).toBe(unresolved);
    expect(cancel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(await settledResult(stream)).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy SSE stream stalled: no data received for 180000ms",
    });
    expect(cancel).toHaveBeenCalledWith(expect.any(Error));
  });

  it("releases the proxy response reader after a terminal stream", async () => {
    let resolveReleased: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const releaseLock = vi.fn(() => {
      resolveReleased?.();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFromReaderText(
          `data: ${JSON.stringify({
            type: "done",
            reason: "stop",
            usage,
          })}\n\n`,
          releaseLock,
        ),
      ),
    );

    await streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    }).result();
    await released;

    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("returns an error result when EOF arrives without a terminal event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFromText(`data: ${JSON.stringify({ type: "start" })}`)),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("error");
    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy stream ended before terminal event",
    });
  });
});

describe("streamProxy loopback /api/stream", () => {
  let server: http.Server | undefined;
  const dripIntervals = new Set<ReturnType<typeof setInterval>>();

  afterEach(async () => {
    for (const interval of dripIntervals) {
      clearInterval(interval);
    }
    dripIntervals.clear();
    if (!server) {
      return;
    }
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
    server = undefined;
  });

  async function listenDripProxy(): Promise<number> {
    server = http.createServer((req, res) => {
      res.on("error", () => {});
      if (req.method !== "POST" || req.url !== "/api/stream") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Transfer-Encoding": "chunked",
      });
      // Keepalive-style drip resets chunk-idle; outer abort must win.
      const drip = () => {
        if (res.writableEnded || res.destroyed) {
          return;
        }
        res.write(`data: ${JSON.stringify({ type: "start" })}\n\n`);
      };
      const interval = setInterval(drip, 20);
      dripIntervals.add(interval);
      res.once("close", () => {
        clearInterval(interval);
        dripIntervals.delete(interval);
      });
      drip();
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return address.port;
  }

  it("cancels a dripping native SSE body when the outer abort signal fires", async () => {
    const port = await listenDripProxy();
    const controller = new AbortController();
    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: `http://127.0.0.1:${port}`,
      // Idle well above drip cadence so only the outer abort can terminate.
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    const firstEvent = await stream[Symbol.asyncIterator]().next();
    expect(firstEvent).toMatchObject({ done: false, value: { type: "start" } });
    controller.abort();

    expect(await resultWithinMs(stream, 1_500)).toMatchObject({
      stopReason: "aborted",
      errorMessage: "Request aborted by user",
    });
  });
});
