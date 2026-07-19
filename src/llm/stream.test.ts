import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { streamSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

describe("LLM stream facade", () => {
  it("routes a prepared model through its lifecycle runtime", () => {
    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const expected = createAssistantMessageEventStream();
    const stream = vi.fn(() => expected);
    registry.registerApiProvider({
      api: "test-lifecycle-api",
      stream,
      streamSimple: stream,
    });
    const model = bindModelLlmRuntime(
      {
        api: "test-lifecycle-api",
        provider: "test-provider",
        id: "test-model",
        name: "Test Model",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 512,
      },
      runtime,
    );

    expect(streamSimple(model, { messages: [] })).toBe(expected);
    expect(stream).toHaveBeenCalledOnce();
  });
});
