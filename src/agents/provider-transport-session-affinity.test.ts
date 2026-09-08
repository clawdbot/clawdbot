import type { Api, Model } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stream: vi.fn((_model, _context, options) => options),
}));

vi.mock("./openai-transport-stream.js", () => ({
  createAzureOpenAIResponsesTransportStreamFn: () => mocks.stream,
  createOpenAICompletionsTransportStreamFn: () => mocks.stream,
  createOpenAIResponsesTransportStreamFn: () => mocks.stream,
}));
vi.mock("./anthropic-transport-stream.js", () => ({
  createAnthropicMessagesTransportStreamFn: () => mocks.stream,
}));
vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderStreamFn: () => mocks.stream,
}));

const { createBoundaryAwareStreamFnForModel } = await import("./provider-transport-stream.js");

function model(api: Api): Model {
  return {
    id: "test-model",
    name: "Test model",
    api,
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 128,
  };
}

describe("managed OpenCode session affinity", () => {
  beforeEach(() => mocks.stream.mockClear());

  it.each([
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
  ] as const)("forwards conversation identity through %s", async (api) => {
    const selectedModel = model(api);
    const stream = createBoundaryAwareStreamFnForModel(selectedModel);
    expect(stream).toBeTypeOf("function");

    await stream?.(
      selectedModel,
      { messages: [] },
      {
        sessionId: "conversation-a",
        cacheRetention: "none",
      },
    );

    expect(mocks.stream).toHaveBeenCalledWith(
      selectedModel,
      { messages: [] },
      expect.objectContaining({ headers: { "x-opencode-session": "conversation-a" } }),
    );
  });
});
