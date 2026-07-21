import { createLlmRuntime, getAiTransportHost } from "@openclaw/ai";
import type { Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";

describe("embedded stream transport host", () => {
  it("installs runtime transport ports before resolving an embedded stream", async () => {
    const inertResolver = getAiTransportHost().plugin.resolveProviderStream;
    const { describeEmbeddedAgentStreamStrategy } = await import("./stream-resolution.js");
    const model = {
      api: "test-embedded-runtime-host-api",
      provider: "test-embedded-runtime-host",
      id: "test-embedded-runtime-host-model",
      name: "Test Embedded Runtime Host Model",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1024,
      maxTokens: 512,
    } satisfies Model;
    const resolver = getAiTransportHost().plugin.resolveProviderStream;

    expect(resolver).not.toBe(inertResolver);
    expect(
      resolver({
        provider: model.provider,
        context: {
          provider: model.provider,
          modelId: model.id,
          model,
        },
      }),
    ).toBeUndefined();
    expect(
      describeEmbeddedAgentStreamStrategy({
        llmRuntime: createLlmRuntime(),
        currentStreamFn: undefined,
        model,
      }),
    ).toBe("stream-simple");
  });
});
