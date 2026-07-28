import type { Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions, streamOpenAIResponses } from "@openclaw/ai/internal/openai";
// OpenAI-compatible auth tests cover API key and base URL normalization.
// Lives in core: it proves the facade-installed guarded fetch routes provider
// requests through OpenClaw's SSRF guard.
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
// Importing the facade installs the OpenClaw AI transport host ports.
import "./stream.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

const originalEnv = captureEnv(["OPENAI_API_KEY"]);

afterEach(() => {
  originalEnv.restore();
  mocks.fetchWithSsrFGuard.mockReset();
});

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function createBaseModel<TApi extends "openai-completions" | "openai-responses">(
  api: TApi,
): Model<TApi> {
  return {
    id: "custom-model",
    name: "Custom Model",
    api,
    provider: "custom-openai-compatible",
    baseUrl: "https://third-party.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_000,
    maxTokens: 4096,
  };
}

describe("OpenAI-compatible provider credentials", () => {
  it("does not use ambient OPENAI_API_KEY for generic chat-completions providers", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-ambient";

    const stream = streamOpenAICompletions(createBaseModel("openai-completions"), context);
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("No API key for provider: custom-openai-compatible");
  });

  it("does not use ambient OPENAI_API_KEY for generic responses providers", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-ambient";

    const stream = streamOpenAIResponses(createBaseModel("openai-responses"), context);
    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("No API key for provider: custom-openai-compatible");
  });

  it("sends explicit API keys as bearer auth for generic chat-completions providers", async () => {
    let capturedHeaders: Headers | undefined;
    mocks.fetchWithSsrFGuard.mockImplementationOnce(async (params: { init?: RequestInit }) => {
      capturedHeaders = new Headers(params.init?.headers);
      return {
        response: new Response(
          [
            'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"custom-model","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}',
            'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":0,"model":"custom-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
          { headers: { "content-type": "text/event-stream" } },
        ),
        release: async () => undefined,
      };
    });

    const stream = streamOpenAICompletions(createBaseModel("openai-completions"), context, {
      apiKey: "sk-third-party",
    });
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer sk-third-party");
  });

  it("does not replay Responses item ids for direct store-disabled requests", async () => {
    let capturedPayload: { store?: unknown; input?: Array<Record<string, unknown>> } | undefined;
    const model = {
      ...createBaseModel("openai-responses"),
      reasoning: true,
    } satisfies Model<"openai-responses">;
    const stream = streamOpenAIResponses(
      model,
      {
        messages: [
          {
            role: "assistant",
            api: "openai-responses",
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
        apiKey: "sk-test",
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
