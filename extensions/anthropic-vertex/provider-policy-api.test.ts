// Anthropic Vertex tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("anthropic-vertex provider-policy-api", () => {
  it("leaves Claude Opus 4.8 thinking off by default with max effort support", () => {
    const profile = resolveThinkingProfile({
      provider: "anthropic-vertex",
      modelId: "claude-opus-4-8",
    });

    expect(profile?.defaultLevel).toBe("off");
    expect(profile?.levels.map((level) => level.id)).toContain("max");
  });

  it("keeps Claude Opus 4.7 thinking off by default", () => {
    const profile = resolveThinkingProfile({
      provider: "anthropic-vertex",
      modelId: "claude-opus-4-7",
    });

    expect(profile?.defaultLevel).toBe("off");
  });

  it("exposes native max without xhigh for Claude Sonnet 4.6", () => {
    const profile = resolveThinkingProfile({
      provider: "anthropic-vertex",
      modelId: "claude-sonnet-4-6",
    });

    expect(profile?.levels.map((level) => level.id)).toContain("max");
    expect(profile?.levels.map((level) => level.id)).not.toContain("xhigh");
  });

  it.each(["claude-fable-5", "claude-mythos-5"])(
    "inherits %s's provider-agnostic thinking contract",
    (modelId) => {
      const profile = resolveThinkingProfile({
        provider: "anthropic-vertex",
        modelId,
      });

      expect(profile?.defaultLevel).toBe("high");
      expect(profile?.preserveWhenCatalogReasoningFalse).toBe(true);
      expect(profile?.levels.map((level) => level.id)).toContain("max");
    },
  );

  it("resolves deployment aliases from canonical model metadata", () => {
    const profile = resolveThinkingProfile({
      provider: "anthropic-vertex",
      modelId: "production-claude",
      params: { canonicalModelId: "claude-fable-5" },
    });

    expect(profile?.defaultLevel).toBe("high");
    expect(profile?.preserveWhenCatalogReasoningFalse).toBe(true);
  });

  it("ignores other providers", () => {
    expect(resolveThinkingProfile({ provider: "anthropic", modelId: "claude-opus-4-8" })).toBe(
      null,
    );
  });
});
