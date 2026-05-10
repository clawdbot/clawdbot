import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("xai provider thinking policy", () => {
  it("exposes thinking levels for reasoning-capable xAI models", () => {
    const profile = resolveThinkingProfile({
      provider: "xai",
      modelId: "grok-4.3",
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
});
