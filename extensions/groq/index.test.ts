import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { contributeGroqResolvedModelCompat, resolveGroqReasoningCompatPatch } from "./api.js";
import plugin from "./index.js";

describe("groq provider compat", () => {
  it("maps Groq Qwen 3 reasoning to provider-native none/default values", () => {
    expect(resolveGroqReasoningCompatPatch("qwen/qwen3-32b")).toEqual({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "default"],
      reasoningEffortMap: expect.objectContaining({
        off: "none",
        low: "default",
        medium: "default",
        high: "default",
      }),
    });
  });

  it("keeps GPT-OSS reasoning on the Groq low/medium/high contract", () => {
    expect(resolveGroqReasoningCompatPatch("openai/gpt-oss-120b")).toEqual({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
    });
  });

  it("contributes compat only for Groq OpenAI-compatible chat models", () => {
    expect(
      contributeGroqResolvedModelCompat({
        modelId: "qwen/qwen3-32b",
        model: { api: "openai-completions", provider: "groq" },
      }),
    ).toMatchObject({ supportedReasoningEfforts: ["none", "default"] });
    expect(
      contributeGroqResolvedModelCompat({
        modelId: "qwen/qwen3-32b",
        model: { api: "openai-completions", provider: "openrouter" },
      }),
    ).toBeUndefined();
  });

  it("registers Groq model and media providers", () => {
    const captured = capturePluginRegistration(plugin);
    expect(captured.providers[0]).toMatchObject({
      id: "groq",
      label: "Groq",
      envVars: ["GROQ_API_KEY"],
    });
    expect(captured.mediaUnderstandingProviders[0]?.id).toBe("groq");
  });
});
