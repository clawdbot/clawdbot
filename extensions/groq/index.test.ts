// Groq tests cover index plugin behavior.
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { resolveGroqReasoningCompatPatch } from "./api.js";
import plugin from "./index.js";

describe("groq provider compat", () => {
  it("maps Groq Qwen 3 reasoning to provider-native none/default values", () => {
    expect(resolveGroqReasoningCompatPatch("qwen/qwen3-32b")).toEqual({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "default"],
      reasoningEffortMap: {
        adaptive: "default",
        high: "default",
        off: "none",
        none: "none",
        minimal: "default",
        low: "default",
        medium: "default",
        max: "default",
        xhigh: "default",
      },
    });
  });

  it("keeps GPT-OSS reasoning on the Groq low/medium/high contract", () => {
    expect(resolveGroqReasoningCompatPatch("openai/gpt-oss-120b")).toEqual({
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["low", "medium", "high"],
    });
  });

  it("registers Groq model and media providers", () => {
    const captured = capturePluginRegistration(plugin);
    const [provider] = captured.providers;
    if (!provider) {
      throw new Error("Expected Groq provider");
    }
    expect(provider).toEqual({
      auth: [],
      docsPath: "/providers/groq",
      envVars: ["GROQ_API_KEY"],
      id: "groq",
      label: "Groq",
    });
    expect(captured.mediaUnderstandingProviders).toHaveLength(1);
    const [mediaProvider] = captured.mediaUnderstandingProviders;
    if (!mediaProvider) {
      throw new Error("Expected Groq media understanding provider");
    }
    const { transcribeAudio, ...mediaProviderMetadata } = mediaProvider;
    expect(mediaProviderMetadata).toEqual({
      autoPriority: { audio: 20 },
      capabilities: ["audio"],
      defaultModels: { audio: "whisper-large-v3-turbo" },
      id: "groq",
    });
    expect(transcribeAudio).toBeTypeOf("function");
  });
});
