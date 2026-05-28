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
});
