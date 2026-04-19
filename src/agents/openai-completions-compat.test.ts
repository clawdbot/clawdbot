import { describe, expect, it } from "vitest";
import { resolveOpenAICompletionsCompatDefaults } from "./openai-completions-compat.js";

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
});
