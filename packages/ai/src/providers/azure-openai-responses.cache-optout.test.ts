import { afterEach, describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { streamAzureOpenAIResponses } from "./azure-openai-responses.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "azure-openai-responses",
  provider: "azure-openai-responses",
  baseUrl: "https://example.openai.azure.com/openai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"azure-openai-responses">;

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

async function captureRequest(
  requestModel: Model<"azure-openai-responses">,
): Promise<Record<string, unknown>> {
  let sentParams: Record<string, unknown> | undefined;
  configureAiTransportHost({
    buildModelFetch: () => async (input, init) => {
      sentParams = (await new Request(input, init).json()) as Record<string, unknown>;
      return Response.json({ error: { message: "captured" } }, { status: 400 });
    },
  });

  await streamAzureOpenAIResponses(requestModel, context, {
    apiKey: "test-api-key",
    sessionId: "session-123",
  }).result();

  if (!sentParams) {
    throw new Error("expected Azure Responses request payload");
  }
  return sentParams;
}

afterEach(() => {
  configureAiTransportHost({});
});

describe("Azure Responses prompt-cache compatibility", () => {
  it("omits prompt_cache_key when compat explicitly disables it", async () => {
    const sentParams = await captureRequest({
      ...model,
      compat: { supportsPromptCacheKey: false },
    });

    expect(sentParams).not.toHaveProperty("prompt_cache_key");
    expect(sentParams).not.toHaveProperty("prompt_cache_retention");
  });

  it("preserves prompt_cache_key when compat does not opt out", async () => {
    const sentParams = await captureRequest(model);

    expect(sentParams.prompt_cache_key).toBe("session-123");
  });
});
