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
    ]);
    expect(profile?.defaultLevel).toBe("adaptive");
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

  it.each(["bedrock", "aws-bedrock"])("accepts provider alias %s", (provider) => {
    expect(
      resolveThinkingProfile({
        provider,
        modelId: "global.anthropic.claude-opus-4-6-v1",
      })?.levels.map((level) => level.id),
    ).toContain("adaptive");
  });

  it("ignores unrelated providers", () => {
    expect(
      resolveThinkingProfile({ provider: "anthropic", modelId: "claude-opus-4-6" }),
    ).toBeNull();
  });
});
