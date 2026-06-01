import { afterEach, describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { streamOpenAIResponses } from "./openai-responses.js";

const previousOpenAIKey = process.env.OPENAI_API_KEY;

afterEach(() => {
  if (previousOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = previousOpenAIKey;
  }
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
