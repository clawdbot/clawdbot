// Xai tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("xai provider thinking policy", () => {
  it.each([
    ["xai", "grok-4.3"],
    ["xai", "grok-4.3-latest"],
    ["xai", "grok-latest"],
    ["x-ai", "grok-4.3"],
    ["x-ai", "grok-4.3-latest"],
    ["x-ai", "grok-latest"],
  ])("exposes Grok 4.3 thinking levels for %s/%s", (provider, modelId) => {
    const profile = resolveThinkingProfile({
      provider,
      modelId,
    });

    expect(profile.defaultLevel).toBe("low");
    expect(profile.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it.each([
    ["xai", "grok-4.5"],
    ["xai", "grok-4.5-latest"],
    ["xai", "grok-build-latest"],
    ["x-ai", "grok-4.5"],
    ["x-ai", "grok-4.5-latest"],
    ["x-ai", "grok-build-latest"],
  ])("uses xAI's high reasoning default for %s/%s", (provider, modelId) => {
    const profile = resolveThinkingProfile({
      provider,
      modelId,
    });

    expect(profile).toEqual({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "high",
    });
  });

  it("keeps non-reasoning and non-xai routes off-only", () => {
    expect(
      resolveThinkingProfile({
        provider: "xai",
        modelId: "grok-4-fast-non-reasoning",
        reasoning: false,
      }),
    ).toEqual({ levels: [{ id: "off" }], defaultLevel: "off" });
    expect(
      resolveThinkingProfile({
        provider: "openrouter",
        modelId: "x-ai/grok-4.3",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "off" }], defaultLevel: "off" });
  });

  it.each([
    ["xai", "grok-build-0.1"],
    ["xai", "grok-4.20-0309-reasoning"],
    ["xai", "grok-4.20-beta-latest-reasoning"],
    ["x-ai", "grok-build-0.1"],
    ["x-ai", "grok-4.20-0309-reasoning"],
    ["x-ai", "grok-4.20-beta-latest-reasoning"],
  ])("does not advertise configurable reasoning for %s/%s", (provider, modelId) => {
    expect(resolveThinkingProfile({ provider, modelId })).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });
});
