import { zstdDecompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
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
