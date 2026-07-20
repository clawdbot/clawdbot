// Covers which ChatGPT Responses failures the SSE transport retries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

function createTestJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("streamOpenAICodexResponses retry classification", () => {
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

  const jwt = createTestJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  });

  it.each([
    { status: 401, statusText: "Unauthorized", message: "Invalid credentials" },
    { status: 403, statusText: "Forbidden", message: "Account is not authorized" },
    { status: 400, statusText: "Bad Request", message: "Unsupported parameter" },
  ])(
    "does not retry non-retryable ChatGPT responses: $status",
    async ({ status, statusText, message }) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: { message } }), {
          status,
          statusText,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      const result = await streamOpenAICodexResponses(model, context, {
        apiKey: jwt,
        transport: "sse",
      }).result();

      expect(result.stopReason).toBe("error");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
    },
  );

  it("still retries retryable ChatGPT responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Invalid credentials" } }), {
          status: 401,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback: TimerHandler) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: jwt,
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "unparseable", retryAfterMs: "not-a-number" },
    { label: "empty", retryAfterMs: "" },
  ])("honors retry-after when retry-after-ms is $label", async ({ retryAfterMs }) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after-ms": retryAfterMs, "retry-after": "7" },
        }),
      )
      .mockRejectedValueOnce(new Error("usage limit: stop after retry delay"));
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback: TimerHandler) => {
        if (typeof callback === "function") {
          callback();
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

    await streamOpenAICodexResponses(model, context, {
      apiKey: jwt,
      transport: "sse",
    }).result();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 7_000);
  });

  it("does not retry a bodyless 304 response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 304, statusText: "Not Modified" }));
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: jwt,
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Not Modified");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});
