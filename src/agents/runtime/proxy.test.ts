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

function responseFromSseFrames(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  const chunks = frames.map((frame) => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
  const reader = {
    read: vi.fn(async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const value = chunks.shift();
      return value ? { done: false, value } : { done: true, value: undefined };
    }),
    cancel: vi.fn(async () => undefined),
    releaseLock: vi.fn(),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;

  return {
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  } as Response;
}

function responseFromReaderText(
  text: string,
  releaseLock: () => void,
  cancel: () => Promise<void> = async () => undefined,
): Response {
  const chunks: Array<ReadableStreamReadResult<Uint8Array>> = [
    { done: false, value: new TextEncoder().encode(text) },
    { done: true, value: undefined },
  ];
  const reader = {
    read: async () => chunks.shift() ?? { done: true, value: undefined },
    cancel,
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

  it("accepts data lines without a space after the colon", async () => {
    // The SSE spec makes the space optional; proxies emitting `data:{...}`
    // must not have their events silently dropped.
    const proxyEvents = [
      { type: "text_start", contentIndex: 0, contentSignature: "sig" },
      { type: "text_delta", contentIndex: 0, delta: "Working..." },
      { type: "text_end", contentIndex: 0 },
      { type: "done", reason: "stop", usage },
    ];
    const body = [
      `data:${JSON.stringify(proxyEvents[0])}`,
      "",
      `data: ${JSON.stringify(proxyEvents[1])}`,
      "",
      `data:${JSON.stringify(proxyEvents[2])}`,
      "",
      `data:${JSON.stringify(proxyEvents[3])}`,
      "",
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responseFromText(body)),
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
      content: [{ type: "text", text: "Working..." }],
    });
  });

  it("delays tool argument previews while preserving exact terminal arguments", async () => {
    const initialContent = "a".repeat(128);
    const checkpointContent = "b".repeat(400);
    const deltas = [`{"content":"${initialContent}`, checkpointContent, `","terminal":"exact"}`];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFromSseFrames([
          { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "write" },
          ...deltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 0, delta })),
          { type: "toolcall_end", contentIndex: 0 },
          { type: "done", reason: "toolUse", usage },
        ]),
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });
    const argumentSnapshots: Array<Record<string, unknown>> = [];
    let terminalArguments: Record<string, unknown> | undefined;
    for await (const event of stream) {
      if (event.type === "toolcall_delta") {
        const content = event.partial.content[event.contentIndex];
        if (content?.type === "toolCall") {
          argumentSnapshots.push(structuredClone(content.arguments));
        }
      } else if (event.type === "toolcall_end") {
        terminalArguments = structuredClone(event.toolCall.arguments);
      }
    }

    const checkpointPreview = { content: initialContent + checkpointContent };
    expect(argumentSnapshots).toEqual([{}, checkpointPreview, checkpointPreview]);
    const exactArguments = {
      content: initialContent + checkpointContent,
      terminal: "exact",
    };
    expect(terminalArguments).toEqual(exactArguments);
    await expect(stream.result()).resolves.toMatchObject({
      content: [{ type: "toolCall", arguments: exactArguments }],
    });
  });

  it("preserves empty arguments for terminal-only tool calls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFromSseFrames([
          { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "list" },
          { type: "toolcall_end", contentIndex: 0 },
          { type: "done", reason: "toolUse", usage },
        ]),
      ),
    );

    const stream = streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    });

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-1", name: "list", arguments: {} }],
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
      value: encoder.encode(`${JSON.stringify({ type: "start" })}\n\n`),
    });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(cancel).not.toHaveBeenCalled();
    thirdReadResolve?.({
      done: false,
      value: encoder.encode(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`),
    });

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
      value: encoder.encode(`${JSON.stringify({ type: "start" })}\n\n`),
    });
    await vi.advanceTimersByTimeAsync(4);
    expect(cancel).not.toHaveBeenCalled();
    thirdReadResolve?.({
      done: false,
      value: encoder.encode(`data: ${JSON.stringify({ type: "done", reason: "stop", usage })}\n\n`),
    });

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

  it("releases the response reader when terminal stream cancellation never settles", async () => {
    const releaseLock = vi.fn();
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
          () => new Promise<void>(() => {}),
        ),
      ),
    );

    await streamProxy(model, context, {
      authToken: "token",
      proxyUrl: "https://proxy.example",
    }).result();

    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a naturally drained response ending with a terminal frame", async () => {
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        responseFromReaderText(
          `data: ${JSON.stringify({ type: "done", reason: "stop", usage })}`,
          () => undefined,
          cancel,
        ),
      ),
    );

    await expect(
      streamProxy(model, context, {
        authToken: "token",
        proxyUrl: "https://proxy.example",
      }).result(),
    ).resolves.toMatchObject({ stopReason: "stop" });
    expect(cancel).not.toHaveBeenCalled();
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

  async function listenProxyErrorBody(bytes: Buffer, splitAt: number) {
    const request: {
      method?: string;
      path?: string;
      authorization?: string;
    } = {};

    server = http.createServer((req, res) => {
      request.method = req.method;
      request.path = req.url;
      request.authorization = req.headers.authorization;
      if (req.method !== "POST" || req.url !== "/api/stream") {
        res.writeHead(404);
        res.end();
        return;
      }

      res.writeHead(502, "Bad Gateway", { "Content-Type": "application/json" });
      res.write(bytes.subarray(0, splitAt));
      res.end(bytes.subarray(splitAt));
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return { port: address.port, request };
  }

  it.each([
    {
      name: "terminal success",
      terminal: { type: "done", reason: "stop", usage },
      expected: { stopReason: "stop" },
    },
    {
      name: "terminal error",
      terminal: { type: "error", reason: "error", errorMessage: "upstream failed", usage },
      expected: { stopReason: "error", errorMessage: "upstream failed" },
    },
    {
      name: "malformed event",
      terminal: "{invalid json",
      expected: { stopReason: "error" },
    },
  ])(
    "closes a hanging native SSE body after $name without applying later frames",
    async (entry) => {
      let notifyClosed: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => {
        notifyClosed = resolve;
      });
      server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.once("close", () => notifyClosed?.());
        const frames = [
          { type: "text_start", contentIndex: 0 },
          { type: "text_delta", contentIndex: 0, delta: "visible" },
          entry.terminal,
          { type: "text_delta", contentIndex: 0, delta: " late mutation" },
        ];
        res.write(
          frames
            .map(
              (frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`,
            )
            .join(""),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected loopback server address");
      }

      const result = await streamProxy(model, context, {
        authToken: "token",
        proxyUrl: `http://127.0.0.1:${address.port}`,
        timeoutMs: 3_000,
      }).result();
      // Native cancellation closes the remote socket asynchronously; the test owns the deadline.
      await closed;
      expect(result).toMatchObject({
        ...entry.expected,
        content: [{ type: "text", text: "visible" }],
      });
    },
  );

  it("falls back to the HTTP status for malformed UTF-8 proxy errors", async () => {
    const prefix = Buffer.from('{"error":"corrupted ');
    const bytes = Buffer.concat([prefix, Buffer.from([0xff]), Buffer.from(' upstream"}')]);
    const { port, request } = await listenProxyErrorBody(bytes, prefix.length);

    const result = await streamProxy(model, context, {
      authToken: "token",
      proxyUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3_000,
    }).result();

    expect(request).toEqual({
      method: "POST",
      path: "/api/stream",
      authorization: "Bearer token",
    });
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Proxy error: 502 Bad Gateway",
    });
  });

  it("preserves a valid replacement character in proxy error responses", async () => {
    const error = "upstream legitimately contains \uFFFD";
    const bytes = Buffer.from(JSON.stringify({ error }));
    const { port, request } = await listenProxyErrorBody(bytes, bytes.indexOf(0xef) + 1);

    const result = await streamProxy(model, context, {
      authToken: "token",
      proxyUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 3_000,
    }).result();

    expect(request).toEqual({
      method: "POST",
      path: "/api/stream",
      authorization: "Bearer token",
    });
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: `Proxy error: ${error}`,
    });
  });

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
