import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesParams,
  makeResponsesModel,
} from "./openai-transport-stream.test-harness.js";

const context = {
  systemPrompt: "system",
  messages: [],
  tools: [],
} as never;

function makeAzureResponsesModel(supportsPromptCacheKey?: boolean) {
  return makeResponsesModel<"azure-openai-responses">({
    api: "azure-openai-responses",
    provider: "azure-openai-responses",
    baseUrl: "https://example.openai.azure.com/openai/v1",
    ...(supportsPromptCacheKey === undefined
      ? {}
      : { compat: { supportsPromptCacheKey } }),
  });
}

describe("Azure Responses transport prompt-cache compatibility", () => {
  it("strips prompt-cache fields when compat explicitly disables them", () => {
    const params = buildOpenAIResponsesParams(
      makeAzureResponsesModel(false),
      context,
      { sessionId: "session-123", cacheRetention: "long" } as never,
    ) as Record<string, unknown>;

    expect(params).not.toHaveProperty("prompt_cache_key");
    expect(params).not.toHaveProperty("prompt_cache_retention");
  });

  it("preserves the existing prompt-cache default without an opt-out", () => {
    const params = buildOpenAIResponsesParams(
      makeAzureResponsesModel(),
      context,
      { sessionId: "session-123" } as never,
    ) as Record<string, unknown>;

    expect(params.prompt_cache_key).toBe("session-123");
  });
});
