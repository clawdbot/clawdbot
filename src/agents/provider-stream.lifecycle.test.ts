import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import { describe, expect, it, vi } from "vitest";
import { bindModelLlmRuntime } from "../llm/model-runtime-binding.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { registerProviderStreamForModel } from "./provider-stream.js";

const { providerStream } = vi.hoisted(() => ({
  providerStream: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: () => providerStream,
}));

describe("provider stream lifecycle registration", () => {
  it("registers provider streams into the prepared model runtime", () => {
    providerStream.mockReturnValue(createAssistantMessageEventStream());
    const apiRegistry = createApiRegistry();
    const llmRuntime = createLlmRuntime(apiRegistry);
    const model = bindModelLlmRuntime(
      {
        api: "test-lifecycle-provider",
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
      llmRuntime,
    );

    expect(registerProviderStreamForModel({ model })).toBeTypeOf("function");
    expect(apiRegistry.getApiProvider("test-lifecycle-provider")).toBeDefined();
  });
});
