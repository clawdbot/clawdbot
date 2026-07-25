import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "./model-runtime-binding.js";
import { streamSimple } from "./stream.js";
import { createAssistantMessageEventStream } from "./utils/event-stream.js";

describe("LLM stream facade", () => {
  it("routes a prepared model through its lifecycle runtime", async () => {
    const registry = createApiRegistry();
    const runtime = createLlmRuntime(registry);
    const expected = createAssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "complete" }],
      api: "test-lifecycle-api",
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } satisfies AssistantMessage;
    const providerStream = vi.fn(() => expected);
    registry.registerApiProvider({
      api: "test-lifecycle-api",
      stream: providerStream,
      streamSimple: providerStream,
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
      } satisfies Model,
      runtime,
    );

    const output = streamSimple(model, { messages: [] });
    expect(providerStream).not.toHaveBeenCalled();
    expected.push({ type: "done", reason: "stop", message });
    expected.end();

    await expect(output.result()).resolves.toEqual(message);
    expect(providerStream).toHaveBeenCalledOnce();
  });
});
