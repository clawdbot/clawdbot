import { arch, platform, release } from "node:os";
import { zstdDecompressSync } from "node:zlib";
// ChatGPT Responses provider tests cover stream handling and timeout behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  extractOpenAICodexAccountId,
  resetOpenAICodexWebSocketStateForTest,
  streamSimpleOpenAICodexResponses,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";
import { installTestModelWebSocketHost } from "./openai-chatgpt-responses.test-websocket.js";

beforeEach(installTestModelWebSocketHost);

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function stubTimeoutSignal(timeoutMs: number): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
    expect(actualTimeoutMs).toBe(timeoutMs);
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort(new DOMException("timed out", "TimeoutError"));
    });
    return controller.signal;
  });
}

function stubHangingFetch(timeoutMs: number): void {
  stubTimeoutSignal(timeoutMs);

  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }

          const abort = () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("aborted", "AbortError"),
            );
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        }),
    ),
  );
}

function completedSseResponse(responseId = "resp_test"): Response {
  const event = {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
  return new Response(`data: ${JSON.stringify(event)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("extractOpenAICodexAccountId", () => {
  it("decodes URL-safe base64 JWT payloads", () => {
    const accessToken = createJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "w_ébé_1fzcswWN6Pi5zL",
      },
    });
    expect(accessToken.split(".")[1]).toContain("_");

    expect(extractOpenAICodexAccountId(accessToken)).toBe("w_ébé_1fzcswWN6Pi5zL");
  });

  it("rejects tokens without a Codex account id", () => {
    expect(() => extractOpenAICodexAccountId(createJwt({}))).toThrow(
      "Failed to extract accountId from token",
    );
  });
});

describe("streamOpenAICodexResponses transport", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

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

  it("unwraps sentinels before constructing ChatGPT SSE auth headers", async () => {
    const realToken = createJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-sentinel" },
    });
    const sentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    configureAiTransportHost({
      resolveSecretSentinel: (value) => value.replaceAll(sentinel, realToken),
    });
    let authorization: string | null = null;
    let providerToken: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization");
        providerToken = headers.get("x-provider-token");
        return completedSseResponse();
      }),
    );

    const result = await streamOpenAICodexResponses(
      { ...model, headers: { "X-Provider-Token": `Bearer ${sentinel}` } },
      context,
      {
        apiKey: sentinel,
        transport: "sse",
      },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(authorization).toBe(`Bearer ${realToken}`);
    expect(authorization).not.toContain(sentinel);
    expect(providerToken).toBe(`Bearer ${realToken}`);
  });

  it("clamps session headers to the backend limit", async () => {
    const jwt = createJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } });
    let headers: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        headers = new Headers(init?.headers);
        return completedSseResponse();
      }),
    );

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: jwt,
      requestId: "request-id",
      sessionId: "s".repeat(80),
      threadId: "thread-id",
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(headers?.get("session_id")).toBe("s".repeat(64));
    expect(headers?.get("session-id")).toBe("s".repeat(64));
    expect(headers?.get("thread-id")).toBe("thread-id");
    expect(headers?.get("x-client-request-id")).toBe("thread-id");
  });

  it("builds the first Node request with an OS-specific user agent", async () => {
    vi.resetModules();
    const freshProvider = await import("./openai-chatgpt-responses.js");
    let userAgent: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        userAgent = new Headers(init?.headers).get("user-agent");
        return completedSseResponse();
      }),
    );

    await freshProvider
      .streamOpenAICodexResponses(model, context, {
        apiKey: createJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        }),
        transport: "sse",
      })
      .result();

    expect(userAgent).toBe(`openclaw (${platform()} ${release()}; ${arch()})`);
  });

  it("zstd-compresses SSE bodies without overriding an existing encoding", async () => {
    const captured: Array<{ body: BodyInit | null | undefined; encoding: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        captured.push({
          body: init?.body,
          encoding: new Headers(init?.headers).get("content-encoding"),
        });
        return completedSseResponse(`resp_${captured.length}`);
      }),
    );
    const apiKey = createJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    });

    await streamOpenAICodexResponses(model, context, { apiKey, transport: "sse" }).result();
    await streamOpenAICodexResponses(model, context, {
      apiKey,
      transport: "sse",
      headers: { "content-encoding": "identity" },
    }).result();

    expect(captured[0]?.encoding).toBe("zstd");
    expect(captured[0]?.body).toBeInstanceOf(Uint8Array);
    const decoded = JSON.parse(
      Buffer.from(zstdDecompressSync(captured[0]?.body as Uint8Array)).toString("utf8"),
    ) as { model?: string };
    expect(decoded.model).toBe(model.id);
    expect(captured[1]).toMatchObject({ encoding: "identity", body: expect.any(String) });
  });

  it("keeps JSON request bodies for custom ChatGPT relays", async () => {
    let capturedBody: BodyInit | null | undefined;
    let capturedEncoding: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        capturedBody = init?.body;
        capturedEncoding = new Headers(init?.headers).get("content-encoding");
        return completedSseResponse();
      }),
    );

    await streamOpenAICodexResponses(
      { ...model, provider: "custom-relay", baseUrl: "https://relay.test/backend-api" },
      context,
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        }),
        transport: "sse",
      },
    ).result();

    expect(capturedEncoding).toBeNull();
    expect(capturedBody).toEqual(expect.any(String));
    expect(JSON.parse(capturedBody as string)).toMatchObject({ model: model.id });
  });

  it("reconnects once when the websocket connection limit is reached", async () => {
    let connections = 0;
    class ConnectionLimitWebSocket extends EventTarget {
      private readonly limitReached = connections++ === 0;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        const event = this.limitReached
          ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
          : {
              type: "response.completed",
              response: {
                id: "resp_ws",
                status: "completed",
                output: [],
                usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
              },
            };
        queueMicrotask(() => {
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
        });
      }

      close(): void {}
    }
    const fetchMock = vi.fn();
    vi.stubGlobal("WebSocket", ConnectionLimitWebSocket);
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
      }),
      transport: "websocket",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(connections).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rotates cached websockets before the backend connection age limit", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-03T00:00:00Z");
    vi.setSystemTime(startedAt);
    let connections = 0;
    const sentConnectionIds: number[] = [];

    class AgedWebSocket extends EventTarget {
      readonly connectionId = ++connections;
      readyState = 1;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        sentConnectionIds.push(this.connectionId);
        queueMicrotask(() => {
          this.dispatchEvent(
            Object.assign(new Event("message"), {
              data: JSON.stringify({
                type: "response.completed",
                response: {
                  id: `resp_${this.connectionId}`,
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
                },
              }),
            }),
          );
        });
      }

      close(): void {
        this.readyState = 3;
      }
    }
    vi.stubGlobal("WebSocket", AgedWebSocket);
    const apiKey = createJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    });
    const sessionId = "aged-session";

    await streamOpenAICodexResponses(model, context, {
      apiKey,
      sessionId,
      transport: "websocket-cached",
    }).result();
    vi.setSystemTime(new Date(startedAt.getTime() + 56 * 60 * 1000));
    await streamOpenAICodexResponses(model, context, {
      apiKey,
      sessionId,
      transport: "websocket-cached",
    }).result();

    expect(sentConnectionIds).toEqual([1, 2]);
    expect(connections).toBe(2);
  });

  it("preserves max for GPT-5.6 simple Codex Responses requests", async () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const stream = streamSimpleOpenAICodexResponses(
      {
        ...model,
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        contextWindow: 372_000,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
      context,
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
          },
        }),
        reasoning: "max",
        transport: "sse",
        onPayload: (payload) => {
          capturedPayload = payload as Record<string, unknown>;
          throw new Error("stop after payload");
        },
      },
    );

    await stream.result();

    expect(capturedPayload).toMatchObject({
      reasoning: { effort: "max", summary: "auto" },
    });
  });

  it("does not fall back to SSE when websocket transport is explicit", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not run");
    });
    vi.stubGlobal("fetch", fetchMock);
    class FailingWebSocket {
      constructor() {
        throw new Error("websocket connect failed");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      sessionId: "session-explicit-websocket",
      transport: "websocket",
    });

    const result = await stream.result();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("websocket connect failed");
  });

  it("honors timeoutMs for explicit SSE transport requests", async () => {
    stubHangingFetch(5);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey: createJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct-1",
        },
      }),
      timeoutMs: 5,
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Request timed out after 5ms");
  });

  it("does not replay Responses item ids for store-disabled ChatGPT requests", async () => {
    let capturedPayload:
      | {
          store?: unknown;
          input?: Array<Record<string, unknown>>;
        }
      | undefined;
    const stream = streamOpenAICodexResponses(
      model,
      {
        messages: [
          {
            role: "assistant",
            api: "openai-chatgpt-responses",
            provider: model.provider,
            model: model.id,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "lookup",
                arguments: {},
              },
            ],
          },
        ],
      },
      {
        apiKey: createJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct-1",
          },
        }),
        transport: "sse",
        onPayload: (payload) => {
          capturedPayload = payload as typeof capturedPayload;
          throw new Error("stop after payload");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("stop after payload");
    expect(capturedPayload?.store).toBe(false);
    const reasoningItem = capturedPayload?.input?.find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem).not.toHaveProperty("id");
    const messageItem = capturedPayload?.input?.find((item) => item.type === "message");
    expect(messageItem).toMatchObject({
      type: "message",
      phase: "commentary",
    });
    expect(messageItem).not.toHaveProperty("id");
    const functionCall = capturedPayload?.input?.find((item) => item.type === "function_call");
    expect(functionCall).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall).not.toHaveProperty("id");
  });
});
