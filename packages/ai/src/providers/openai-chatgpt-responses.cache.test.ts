import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { configureAiTransportHost } from "../host.js";
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
    const sentPayloads: string[] = [];

    class CachedWebSocket extends EventTarget {
      readyState = 1;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
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

    const first = await streamOpenAICodexResponses(model, context, options).result();
    const second = await streamOpenAICodexResponses(
      model,
      {
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

  it("lazily builds authenticated SSE requests after session-scoped websocket fallback", async () => {
    let websocketAttempts = 0;

    class FailingWebSocket {
      constructor() {
        websocketAttempts += 1;
        throw new Error("websocket connect failed");
      }

      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }

    const captured: Array<{ headers: Headers; body: BodyInit | null | undefined }> = [];
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      captured.push({ headers: new Headers(init?.headers), body: init?.body });
      return new Response(
        `data: ${JSON.stringify(completion(`resp_sse_${captured.length}`))}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    vi.stubGlobal("WebSocket", FailingWebSocket);
    vi.stubGlobal("fetch", fetchMock);
    const apiKey = createJwt();
    const options = { apiKey, sessionId: "sticky-sse-fallback" };

    const first = await streamOpenAICodexResponses(model, context, options).result();
    const second = await streamOpenAICodexResponses(model, context, options).result();

    expect(first.stopReason).toBe("stop");
    expect(second.stopReason).toBe("stop");
    expect(websocketAttempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (const { headers, body } of captured) {
      expect(headers.get("authorization")).toBe(`Bearer ${apiKey}`);
      expect(headers.get("chatgpt-account-id")).toBe("acct-1");
      expect(headers.get("session_id")).toBe("sticky-sse-fallback");
      expect(headers.get("accept")).toBe("text/event-stream");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("content-encoding")).toBe("zstd");
      expect(body).toBeInstanceOf(Uint8Array);
      expect(
        JSON.parse(Buffer.from(zstdDecompressSync(body as Uint8Array)).toString("utf8")),
      ).toMatchObject({
        model: model.id,
        prompt_cache_key: "sticky-sse-fallback",
      });
    }
  });
});
