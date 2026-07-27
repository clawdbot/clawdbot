import { afterEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const model = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "http://127.0.0.1:7862/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 372_000,
  maxTokens: 128_000,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function completedSseResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_proxy",
        status: "completed",
        output: [],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("OpenAI ChatGPT Responses loopback proxies", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    resetOpenAICodexWebSocketStateForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends opaque capabilities only to loopback Codex proxies", async () => {
    const capability = "opaque-loopback-capability";
    let requestUrl: string | undefined;
    let headers: Headers | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        requestUrl = String(input);
        headers = new Headers(init?.headers);
        return completedSseResponse();
      }),
    );

    const result = await streamOpenAICodexResponses(model, context, {
      apiKey: capability,
      transport: "sse",
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(requestUrl).toBe("http://127.0.0.1:7862/backend-api/codex/responses");
    expect(headers?.get("authorization")).toBe(`Bearer ${capability}`);
    expect(headers?.get("chatgpt-account-id")).toBeNull();

    vi.mocked(fetch).mockClear();
    const remote = await streamOpenAICodexResponses(
      { ...model, baseUrl: "https://relay.example.test/backend-api/codex" },
      context,
      { apiKey: capability, transport: "sse" },
    ).result();
    expect(remote).toMatchObject({
      stopReason: "error",
      errorMessage: "Failed to extract accountId from token",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
