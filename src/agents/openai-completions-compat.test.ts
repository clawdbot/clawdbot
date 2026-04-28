import { describe, expect, it } from "vitest";
import {
  detectOpenAICompletionsCompat,
  resolveOpenAICompletionsCompatDefaults,
} from "./openai-completions-compat.js";

describe("resolveOpenAICompletionsCompatDefaults", () => {
  it("keeps streaming usage enabled for provider-declared compatible endpoints", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "custom-local",
        endpointClass: "local",
        knownProviderFamily: "custom-local",
        supportsNativeStreamingUsageCompat: true,
      }).supportsUsageInStreaming,
    ).toBe(true);
  });

  it("keeps streaming usage enabled for custom provider-declared compatible endpoints", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "custom-local",
        endpointClass: "custom",
        knownProviderFamily: "custom-local",
        supportsNativeStreamingUsageCompat: true,
      }).supportsUsageInStreaming,
    ).toBe(true);
  });

  it("does not broaden streaming usage for generic custom providers", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "custom-cpa",
        endpointClass: "custom",
        knownProviderFamily: "custom-cpa",
      }).supportsUsageInStreaming,
    ).toBe(false);
  });

  it.each(["vllm", "sglang", "lmstudio"])(
    "enables streaming usage compat for manifest-declared local provider %s",
    (provider) => {
      expect(
        resolveOpenAICompletionsCompatDefaults({
          provider,
          endpointClass: "custom",
          knownProviderFamily: provider,
          supportsOpenAICompletionsStreamingUsageCompat: true,
        }).supportsUsageInStreaming,
      ).toBe(true);
    },
  );

  it("does not infer local streaming usage from provider id alone", () => {
    expect(
      resolveOpenAICompletionsCompatDefaults({
        provider: "vllm",
        endpointClass: "custom",
        knownProviderFamily: "vllm",
      }).supportsUsageInStreaming,
    ).toBe(false);
  });
});

describe("detectOpenAICompletionsCompat", () => {
  it("enables streaming usage compat for vLLM on a local OpenAI-compatible endpoint", () => {
    const detected = detectOpenAICompletionsCompat({
      provider: "vllm",
      baseUrl: "http://127.0.0.1:8000/v1",
      id: "Qwen/Qwen3-Coder-Next-FP8",
    });

    expect(detected.defaults.supportsUsageInStreaming).toBe(true);
  });
});
