import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";

describe("sglang provider plugin", () => {
  it("owns OpenAI-compatible replay without dropping reasoning history", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "sglang",
      modelApi: "openai-completions",
      modelId: "moonshotai/kimi-k2-thinking",
    } as never);

    expect(policy).toMatchObject({
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      applyAssistantFirstOrderingFix: true,
      validateGeminiTurns: true,
      validateAnthropicTurns: true,
    });
    expect(policy).not.toHaveProperty("dropReasoningFromHistory");
  });

  it("still drops historical reasoning for Gemma 4 chat-completions models", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const policy = provider.buildReplayPolicy?.({
      provider: "sglang",
      modelApi: "openai-completions",
      modelId: "google/gemma-4-26b-a4b-it",
    } as never);

    expect(policy).toHaveProperty("dropReasoningFromHistory", true);
  });
});
