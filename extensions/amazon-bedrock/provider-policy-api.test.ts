// Amazon Bedrock tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("amazon-bedrock provider-policy-api", () => {
  it("exposes adaptive thinking for Bedrock Claude 4.6 before runtime registration", () => {
    const profile = resolveThinkingProfile({
      provider: "amazon-bedrock",
      modelId: "amazon-bedrock/global.anthropic.claude-opus-4-6-v1",
    });

    expect(profile?.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "adaptive",
      "max",
    ]);
    expect(profile?.defaultLevel).toBe("adaptive");
  });

  it("caps Bedrock Claude Sonnet 4.6 at high effort", () => {
    const profile = resolveThinkingProfile({
      provider: "amazon-bedrock",
      modelId: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
    });

    expect(profile?.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "adaptive",
    ]);
  });

  it("defaults Bedrock Claude Opus 5 to high adaptive thinking", () => {
    const profile = resolveThinkingProfile({
      provider: "amazon-bedrock",
      modelId: "global.anthropic.claude-opus-5",
    });

    expect(profile?.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
    ]);
    expect(profile?.defaultLevel).toBe("high");
  });

  it("leaves Bedrock Claude Opus 4.8 thinking off by default with max effort available", () => {
    const profile = resolveThinkingProfile({
      provider: "amazon-bedrock",
      modelId:
        "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-4-8",
    });

    expect(profile?.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
    ]);
    expect(profile?.defaultLevel).toBe("off");
  });

  it("exposes max thinking for Bedrock Claude Opus 4.7 refs", () => {
    expect(
      resolveThinkingProfile({
        provider: "amazon-bedrock",
        modelId:
          "arn:aws:bedrock:us-west-2:123456789012:inference-profile/us.anthropic.claude-opus-4-7",
      })?.levels.map((level) => level.id),
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max"]);
  });

  it.each([
    {
      canonicalModelId: "claude-fable-5",
      defaultLevel: "high",
      preservesCatalogOptOut: true,
    },
    {
      canonicalModelId: "claude-mythos-5",
      defaultLevel: "high",
      preservesCatalogOptOut: true,
    },
    {
      canonicalModelId: "claude-opus-5",
      defaultLevel: "high",
      preservesCatalogOptOut: false,
    },
    {
      canonicalModelId: "claude-opus-4-8",
      defaultLevel: "off",
      preservesCatalogOptOut: false,
    },
  ])(
    "resolves $canonicalModelId deployment aliases from canonical metadata",
    ({ canonicalModelId, defaultLevel, preservesCatalogOptOut }) => {
      const profile = resolveThinkingProfile({
        provider: "amazon-bedrock",
        modelId: "production-claude",
        params: { canonicalModelId },
      });

      expect(profile?.defaultLevel).toBe(defaultLevel);
      expect(profile?.levels.map((level) => level.id)).toContain("max");
      expect(profile?.preserveWhenCatalogReasoningFalse === true).toBe(preservesCatalogOptOut);
    },
  );

  it("ignores unrelated providers", () => {
    expect(
      resolveThinkingProfile({ provider: "anthropic", modelId: "claude-opus-4-6" }),
    ).toBeNull();
  });
});
