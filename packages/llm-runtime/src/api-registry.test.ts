// LLM Runtime tests cover api registry behavior.
import { createAssistantMessageEventStream, type Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it } from "vitest";
import { getApiProvider, registerApiProvider, unregisterApiProviders } from "./api-registry.js";

const TEST_SOURCE_ID = "test:llm-runtime-api-registry";

const model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.invalid",
  input: ["text"],
  reasoning: false,
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Model;

describe("LLM API registry", () => {
  afterEach(() => {
    unregisterApiProviders(TEST_SOURCE_ID);
  });

  it("rejects mismatched model API calls", () => {
    registerApiProvider(
      {
        api: "test-api",
        stream: () => createAssistantMessageEventStream(),
        streamSimple: () => createAssistantMessageEventStream(),
      },
      TEST_SOURCE_ID,
    );

    const provider = getApiProvider("test-api");
    expect(provider).toBeDefined();
    expect(() => provider?.streamSimple({ ...model, api: "other-api" }, { messages: [] })).toThrow(
      "Mismatched api: other-api expected test-api",
    );
  });
});
