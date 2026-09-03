import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { configureAiTransportHost } from "../host.js";
import { responsesPromptObserver, type ResponsesPromptObservation } from "../internal/openai.js";
import { cleanupSessionResources } from "../session-resources.js";
import { MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "../transports/transport-utils.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function completion(responseId: string) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

describe("ChatGPT Responses cached transport", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

  it("does not clobber a newer cached websocket when releasing a stale reused lease", async () => {
    let connectionCount = 0;
    const sockets: Array<EventTarget & { connectionId: number; readyState: number }> = [];
    let releaseFirstReuse: (() => void) | undefined;
    const holdFirstReuse = new Promise<void>((resolve) => {
      releaseFirstReuse = resolve;
    });
    let originalSendCount = 0;

    class ReplacementRaceWebSocket extends EventTarget {
      readonly connectionId = ++connectionCount;
      readyState = 1;

      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        const complete = () => {
          queueMicrotask(() => {
            this.dispatchEvent(
              Object.assign(new Event("message"), {
                data: JSON.stringify(completion(`resp_${this.connectionId}`)),
              }),
            );
          });
        };
        if (this.connectionId === 1 && ++originalSendCount > 1) {
          void holdFirstReuse.then(complete);
          return;
        }
        complete();
      }

      // Keep the original lease pending until its replacement is installed.
      close(): void {
        this.readyState = 3;
      }
    }

    vi.stubGlobal("WebSocket", ReplacementRaceWebSocket);
    const sessionId = "replacement-before-release";
    const options = {
      apiKey: createJwt(),
      sessionId,
      transport: "websocket-cached" as const,
    };

    expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe(
      "stop",
    );
    const staleReuse = streamOpenAICodexResponses(model, context, options).result();
    await vi.waitFor(() => expect(originalSendCount).toBe(2));

    closeOpenAICodexWebSocketSessions(sessionId);
    expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe(
      "stop",
    );
    expect(connectionCount).toBe(2);

    sockets[0]?.dispatchEvent(
      Object.assign(new Event("close"), { code: 1000, reason: "stale_lease", wasClean: true }),
    );
    releaseFirstReuse?.();
    await expect(staleReuse).resolves.toMatchObject({ stopReason: "error" });

    expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe(
      "stop",
    );
    expect(connectionCount).toBe(2);
    expect(sockets[1]?.readyState).toBe(1);
  });

  it.each(["close", "abort"] as const)(
    "keeps an authenticated replacement socket when a reused lease ends by %s",
    async (termination) => {
      const sessionId = `replacement-after-${termination}`;
      const apiKey = createJwt();
      const handshakes: Array<{
        authorization?: string;
        accountId?: string;
        openaiBeta?: string;
        sessionId?: string;
        requestId?: string;
      }> = [];
      const receivedConnectionIds: number[] = [];
      let originalServerSocket: WebSocket | undefined;
      let deferredOriginalClose: (() => void) | undefined;
      let holdOriginalDebugClose = true;

      class AuthenticatedLoopbackWebSocket extends WebSocket {
        override close(code?: number, reason?: string | Buffer): void {
          if (holdOriginalDebugClose && reason === "debug_close") {
            holdOriginalDebugClose = false;
            deferredOriginalClose = () => super.close(code, reason);
            return;
          }
          super.close(code, reason);
        }
      }

      vi.stubGlobal("WebSocket", AuthenticatedLoopbackWebSocket);
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.on("connection", (socket, request) => {
        const connectionId = handshakes.length + 1;
        handshakes.push({
          authorization: request.headers.authorization,
          accountId: request.headers["chatgpt-account-id"] as string | undefined,
          openaiBeta: request.headers["openai-beta"] as string | undefined,
          sessionId: request.headers.session_id as string | undefined,
          requestId: request.headers["x-client-request-id"] as string | undefined,
        });
        if (connectionId === 1) {
          originalServerSocket = socket;
        }
        let requestCount = 0;
        socket.on("message", () => {
          requestCount += 1;
          receivedConnectionIds.push(connectionId);
          if (connectionId === 1 && requestCount === 2) {
            return;
          }
          socket.send(JSON.stringify(completion(`resp_${connectionId}_${requestCount}`)));
        });
      });

      await once(server, "listening");
      const port = (server.address() as AddressInfo).port;
      const loopbackModel = {
        ...model,
        baseUrl: `http://127.0.0.1:${port}/backend-api`,
      } satisfies Model<"openai-chatgpt-responses">;
      const options = { apiKey, sessionId, transport: "websocket-cached" as const };

      try {
        expect(
          (await streamOpenAICodexResponses(loopbackModel, context, options).result()).stopReason,
        ).toBe("stop");

        // Hold a real authenticated lease until the replacement is cached so
        // close and abort prove stale teardown cannot evict its successor.
        const abortController = new AbortController();
        const originalTurn = streamOpenAICodexResponses(loopbackModel, context, {
          ...options,
          signal: abortController.signal,
        }).result();
        await vi.waitFor(() => expect(receivedConnectionIds).toEqual([1, 1]));

        closeOpenAICodexWebSocketSessions(sessionId);
        expect(deferredOriginalClose).toBeTypeOf("function");
        expect(
          (await streamOpenAICodexResponses(loopbackModel, context, options).result()).stopReason,
        ).toBe("stop");

        if (termination === "abort") {
          abortController.abort();
        } else {
          if (!originalServerSocket) {
            throw new Error("Original authenticated WebSocket did not connect");
          }
          originalServerSocket.close(1011, "stale original");
        }
        expect((await originalTurn).stopReason).toBe(termination === "abort" ? "aborted" : "error");

        expect(
          (await streamOpenAICodexResponses(loopbackModel, context, options).result()).stopReason,
        ).toBe("stop");
        expect(receivedConnectionIds).toEqual([1, 1, 2, 2]);
        expect(handshakes).toEqual([
          {
            authorization: `Bearer ${apiKey}`,
            accountId: "acct-1",
            openaiBeta: "responses_websockets=2026-02-06",
            sessionId,
            requestId: sessionId,
          },
          {
            authorization: `Bearer ${apiKey}`,
            accountId: "acct-1",
            openaiBeta: "responses_websockets=2026-02-06",
            sessionId,
            requestId: sessionId,
          },
        ]);
      } finally {
        deferredOriginalClose?.();
        closeOpenAICodexWebSocketSessions(sessionId);
        for (const socket of server.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("keeps a replacement cached when a stale idle-expiry callback runs", async () => {
    let connectionCount = 0;
    const closedConnectionIds: number[] = [];

    class CachedWebSocket extends EventTarget {
      readonly connectionId = ++connectionCount;
      readyState = 1;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completion(`resp_${this.connectionId}`)),
            }),
          );
        });
      }

      close(): void {
        this.readyState = 3;
        closedConnectionIds.push(this.connectionId);
      }
    }

    vi.stubGlobal("WebSocket", CachedWebSocket);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const sessionId = "replacement-after-stale-expiry";
    const options = {
      apiKey: createJwt(),
      sessionId,
      transport: "websocket-cached" as const,
    };

    expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe(
      "stop",
    );
    const staleExpiry = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 5 * 60 * 1_000)?.[0];
    expect(staleExpiry).toBeTypeOf("function");

    closeOpenAICodexWebSocketSessions(sessionId);
    expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe(
      "stop",
    );
    (staleExpiry as () => void)();
    expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe(
      "stop",
    );
    expect(connectionCount).toBe(2);
    expect(closedConnectionIds).not.toContain(2);
  });

  it("does not prepare SSE requests or serialize full bodies for cached websocket turns", async () => {
    const prompt = "PRIVATE-CACHED-WEBSOCKET-PROMPT";
    const observations: ResponsesPromptObservation[] = [];
    const order: string[] = [];
    const sentPayloads: string[] = [];

    class CachedWebSocket extends EventTarget {
      readyState = 1;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        order.push("send");
        sentPayloads.push(payload);
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify(completion(`resp_ws_${sentPayloads.length}`)),
            }),
          );
        });
      }

      close(): void {
        this.readyState = 3;
      }
    }

    const fetchMock = vi.fn();
    vi.stubGlobal("WebSocket", CachedWebSocket);
    vi.stubGlobal("fetch", fetchMock);
    const apiKey = createJwt();
    const headerSet = vi.spyOn(Headers.prototype, "set");
    const jsonStringify = vi.spyOn(JSON, "stringify");
    const options = {
      apiKey,
      sessionId: "cached-hot-path",
      transport: "websocket-cached" as const,
    };
    responsesPromptObserver.set(options, (observation) => {
      order.push("observe");
      observations.push(observation);
    });

    const first = await streamOpenAICodexResponses(
      model,
      { ...context, systemPrompt: prompt },
      options,
    ).result();
    const second = await streamOpenAICodexResponses(
      model,
      {
        systemPrompt: prompt,
        messages: [...context.messages, { role: "user", content: "follow-up", timestamp: 2 }],
      },
      options,
    ).result();

    expect(first.stopReason).toBe("stop");
    expect(second.stopReason).toBe("stop");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(headerSet).not.toHaveBeenCalledWith("accept", "text/event-stream");
    expect(headerSet).not.toHaveBeenCalledWith("content-type", "application/json");
    expect(sentPayloads).toHaveLength(2);
    expect(order).toEqual(["observe", "send", "observe", "send"]);
    expect(observations).toHaveLength(2);
    expect(observations.every((entry) => entry.egress === "native-codex-websocket")).toBe(true);
    expect(observations.every((entry) => entry.matchesAssembledPrompt)).toBe(true);
    expect(JSON.stringify(observations)).not.toContain(prompt);

    const continuation = JSON.parse(sentPayloads[1] as string) as {
      input?: unknown[];
      previous_response_id?: string;
    };
    expect(continuation.previous_response_id).toBe("resp_ws_1");
    expect(continuation.input).toHaveLength(1);
    expect(
      jsonStringify.mock.calls.filter(([value]) => {
        return (
          typeof value === "object" &&
          value !== null &&
          "model" in value &&
          "input" in value &&
          !("type" in value)
        );
      }),
    ).toEqual([]);
  });

  it.each([
    {
      label: "valid UTF-8 JSON",
      frame: new TextEncoder().encode(JSON.stringify(completion("resp_binary"))).buffer,
    },
    {
      label: "malformed bytes",
      frame: Uint8Array.from([0xff, 0xfe, 0xfd]).buffer,
    },
  ])("rejects $label in a binary frame and invalidates cached state", async ({ frame }) => {
    const sockets: ProtocolFrameWebSocket[] = [];
    const sentPayloads: Array<Record<string, unknown>> = [];
    let connectionCount = 0;

    class ProtocolFrameWebSocket extends EventTarget {
      readonly connectionId = ++connectionCount;
      readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
      readyState = 1;
      sendCount = 0;

      constructor() {
        super();
        sockets.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      override addEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions,
      ): void {
        super.addEventListener(type, listener, options);
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
      }

      override removeEventListener(
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions,
      ): void {
        super.removeEventListener(type, listener, options);
        this.listeners.get(type)?.delete(listener);
      }

      send(payload: string): void {
        this.sendCount += 1;
        sentPayloads.push(JSON.parse(payload) as Record<string, unknown>);
        queueMicrotask(() => {
          const data =
            this.connectionId === 1 && this.sendCount === 2
              ? frame
              : JSON.stringify(completion(`resp_${this.connectionId}_${this.sendCount}`));
          this.dispatchEvent(Object.assign(new Event("message"), { data }));
        });
      }

      close(): void {
        this.readyState = 3;
      }

      activeStreamListenerCount(): number {
        return ["message", "error", "close"].reduce(
          (count, type) => count + (this.listeners.get(type)?.size ?? 0),
          0,
        );
      }
    }

    vi.stubGlobal("WebSocket", ProtocolFrameWebSocket);
    const options = {
      apiKey: createJwt(),
      sessionId: `binary-frame-${connectionCount}`,
      transport: "websocket-cached" as const,
    };
    const followUpContext = {
      messages: [...context.messages, { role: "user", content: "follow-up", timestamp: 2 }],
    } satisfies Context;

    expect((await streamOpenAICodexResponses(model, context, options).result()).stopReason).toBe(
      "stop",
    );
    expect(sockets[0]?.activeStreamListenerCount()).toBe(0);

    const rejected = await streamOpenAICodexResponses(model, followUpContext, options).result();
    expect(rejected).toMatchObject({
      stopReason: "error",
      errorMessage: MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE,
    });
    expect(sockets[0]).toMatchObject({ readyState: 3, sendCount: 2 });
    expect(sockets[0]?.activeStreamListenerCount()).toBe(0);
    expect(sentPayloads[1]?.previous_response_id).toBe("resp_1_1");

    expect(
      (await streamOpenAICodexResponses(model, followUpContext, options).result()).stopReason,
    ).toBe("stop");
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.activeStreamListenerCount()).toBe(0);
    expect(sentPayloads[2]?.previous_response_id).toBeUndefined();
  });

  it("closes the concurrent acquire loser promptly without leaking its socket", async () => {
    const apiKey = createJwt();
    const sessionId = "concurrent-acquire-loser";
    const handshakes: Array<{ connectionId: number }> = [];
    const receivedConnectionIds: number[] = [];
    const closedConnectionIds: number[] = [];
    const requestBodies: Array<{ connectionId: number; body: Record<string, unknown> }> = [];
    let holdLoserHandshake: ((res: boolean) => void) | undefined;
    let verifyCount = 0;
    let holdNextReconnect = false;
    const releaseLoserHandshake = () => {
      const heldHandshake = holdLoserHandshake;
      holdLoserHandshake = undefined;
      holdNextReconnect = false;
      heldHandshake?.(true);
    };

    class TrackingWebSocket extends WebSocket {
      override close(code?: number, reason?: string | Buffer): void {
        super.close(code, reason);
      }
    }

    vi.stubGlobal("WebSocket", TrackingWebSocket);
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      verifyClient: (_info, cb) => {
        verifyCount += 1;
        // verifyCount 1 = seed; after seed is closed, holdNextReconnect is set
        // so the first reconnect (loser A) blocks while winner B proceeds.
        if (holdNextReconnect && !holdLoserHandshake) {
          holdLoserHandshake = cb;
          return;
        }
        cb(true);
      },
    });
    server.on("connection", (socket) => {
      const connectionId = handshakes.length + 1;
      handshakes.push({ connectionId });
      socket.on("close", () => {
        closedConnectionIds.push(connectionId);
      });
      socket.on("message", (raw: Buffer) => {
        receivedConnectionIds.push(connectionId);
        const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        requestBodies.push({ connectionId, body });
        socket.send(JSON.stringify(completion(`resp_${connectionId}`)));
      });
    });

    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const loopbackModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${port}/backend-api`,
    } satisfies Model<"openai-chatgpt-responses">;
    const options = { apiKey, sessionId, transport: "websocket-cached" as const };

    try {
      // Seed connection 1 into cache.
      expect(
        (await streamOpenAICodexResponses(loopbackModel, context, options).result()).stopReason,
      ).toBe("stop");

      // Force the cached entry to be removed so both reconnects start fresh.
      // This mirrors the existing authenticated-loopback tests.
      closeOpenAICodexWebSocketSessions(sessionId);
      holdNextReconnect = true;

      // Start loser A; its verifyClient is held so winner B can install the cache entry first.
      const loserResult = streamOpenAICodexResponses(loopbackModel, context, options).result();
      await vi.waitFor(() => expect(holdLoserHandshake).toBeTypeOf("function"));

      // Start winner B; it proceeds immediately and installs the cache entry.
      const winnerResult = streamOpenAICodexResponses(loopbackModel, context, options).result();
      expect((await winnerResult).stopReason).toBe("stop");

      // Release loser A's handshake; it loses the CAS and should close promptly.
      releaseLoserHandshake();
      expect((await loserResult).stopReason).toBe("stop");
      await vi.waitFor(() => expect(closedConnectionIds).toContain(3));
      expect(closedConnectionIds).not.toContain(2);

      // Follow-up must reuse winner B's connection, not open a fourth.
      expect(
        (
          await streamOpenAICodexResponses(
            loopbackModel,
            {
              messages: [...context.messages, { role: "user", content: "follow-up", timestamp: 2 }],
            },
            options,
          ).result()
        ).stopReason,
      ).toBe("stop");

      // Server saw seed=1, winner B=2, loser A=3, follow-up on connection 2.
      expect(receivedConnectionIds).toEqual([1, 2, 3, 2]);
      expect(handshakes).toHaveLength(3);
      expect(requestBodies[3]?.body.previous_response_id).toBe("resp_2");
    } finally {
      releaseLoserHandshake();
      closeOpenAICodexWebSocketSessions(sessionId);
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps SSE fallback sticky only for the active session lifecycle", async () => {
    const websocketUpgrades: Array<{
      method: string;
      path: string;
      authorization?: string;
      accountId?: string;
      openaiBeta?: string;
      sessionId?: string;
      requestId?: string;
    }> = [];
    const sseRequests: Array<{
      method: string;
      path: string;
      authorization?: string;
      accountId?: string;
      sessionId?: string;
      requestId?: string;
      accept?: string;
      contentType?: string;
      contentEncoding?: string;
      body: Buffer;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const requestNumber = sseRequests.length + 1;
        sseRequests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          authorization: request.headers.authorization,
          accountId: request.headers["chatgpt-account-id"] as string | undefined,
          sessionId: request.headers.session_id as string | undefined,
          requestId: request.headers["x-client-request-id"] as string | undefined,
          accept: request.headers.accept,
          contentType: request.headers["content-type"],
          contentEncoding: request.headers["content-encoding"],
          body: Buffer.concat(chunks),
        });
        response.writeHead(200, {
          connection: "close",
          "content-type": "text/event-stream",
        });
        response.end(`data: ${JSON.stringify(completion(`resp_sse_${requestNumber}`))}\n\n`);
      });
    });
    server.on("upgrade", (request, socket) => {
      websocketUpgrades.push({
        method: request.method ?? "",
        path: request.url ?? "",
        authorization: request.headers.authorization,
        accountId: request.headers["chatgpt-account-id"] as string | undefined,
        openaiBeta: request.headers["openai-beta"] as string | undefined,
        sessionId: request.headers.session_id as string | undefined,
        requestId: request.headers["x-client-request-id"] as string | undefined,
      });
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const loopbackModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${port}/backend-api`,
    } satisfies Model<"openai-chatgpt-responses">;
    vi.stubGlobal("WebSocket", WebSocket);
    const apiKey = createJwt();
    const runSession = (sessionId: string) =>
      streamOpenAICodexResponses(loopbackModel, context, { apiKey, sessionId }).result();

    try {
      const firstStickyResult = await runSession("sticky-sse-fallback");
      expect(firstStickyResult).toMatchObject({
        stopReason: "stop",
        diagnostics: [
          {
            type: "provider_transport_failure",
            error: { message: "Unexpected server response: 426" },
            details: {
              configuredTransport: "auto",
              fallbackTransport: "sse",
              eventsEmitted: false,
              phase: "before_message_stream_start",
            },
          },
        ],
      });
      const stickyResult = await runSession("sticky-sse-fallback");
      expect(stickyResult.stopReason).toBe("stop");
      expect(stickyResult.diagnostics).toBeUndefined();
      expect((await runSession("unrelated-sse-fallback")).stopReason).toBe("stop");
      expect(websocketUpgrades).toHaveLength(2);

      cleanupSessionResources("sticky-sse-fallback");
      expect((await runSession("unrelated-sse-fallback")).stopReason).toBe("stop");
      expect(websocketUpgrades).toHaveLength(2);
      expect((await runSession("sticky-sse-fallback")).stopReason).toBe("stop");
      expect((await runSession("sticky-sse-fallback")).stopReason).toBe("stop");
      expect(websocketUpgrades).toHaveLength(3);

      cleanupSessionResources();
      expect((await runSession("sticky-sse-fallback")).stopReason).toBe("stop");
      expect((await runSession("unrelated-sse-fallback")).stopReason).toBe("stop");

      expect(websocketUpgrades.map((request) => request.sessionId)).toEqual([
        "sticky-sse-fallback",
        "unrelated-sse-fallback",
        "sticky-sse-fallback",
        "sticky-sse-fallback",
        "unrelated-sse-fallback",
      ]);
      expect(sseRequests.map((request) => request.sessionId)).toEqual([
        "sticky-sse-fallback",
        "sticky-sse-fallback",
        "unrelated-sse-fallback",
        "unrelated-sse-fallback",
        "sticky-sse-fallback",
        "sticky-sse-fallback",
        "sticky-sse-fallback",
        "unrelated-sse-fallback",
      ]);

      for (const request of websocketUpgrades) {
        expect(request).toMatchObject({
          method: "GET",
          path: "/backend-api/codex/responses",
          authorization: `Bearer ${apiKey}`,
          accountId: "acct-1",
          openaiBeta: "responses_websockets=2026-02-06",
          requestId: request.sessionId,
        });
      }
      for (const request of sseRequests) {
        expect(request).toMatchObject({
          method: "POST",
          path: "/backend-api/codex/responses",
          authorization: `Bearer ${apiKey}`,
          accountId: "acct-1",
          requestId: request.sessionId,
          accept: "text/event-stream",
          contentType: "application/json",
          contentEncoding: "zstd",
        });
        expect(request.body).not.toHaveLength(0);
        const payload = JSON.parse(zstdDecompressSync(request.body).toString("utf8"));
        expect(payload).toMatchObject({
          model: model.id,
          prompt_cache_key: request.sessionId,
        });
      }

      console.info(
        "[behavior-evidence] chatgpt-sse-fallback-cleanup",
        JSON.stringify({
          transport: "real ws client and loopback HTTP server",
          rejectedUpgradeStatus: 426,
          websocketSessionIds: websocketUpgrades.map((request) => request.sessionId),
          sseSessionIds: sseRequests.map((request) => request.sessionId),
          firstFallbackError: firstStickyResult.diagnostics?.[0]?.error?.message,
          scopedCleanupRetriedOnly: "sticky-sse-fallback",
          globalCleanupRetried: ["sticky-sse-fallback", "unrelated-sse-fallback"],
        }),
      );
    } finally {
      cleanupSessionResources();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
