// Xai tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("xai provider thinking policy", () => {
  it.each(["grok-4.3", "grok-4.3-latest", "grok-latest"])(
    "exposes Grok 4.3 thinking levels for %s",
    (modelId) => {
      const profile = resolveThinkingProfile({
        provider: "xai",
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
    },
  );

  it.each(["grok-4.5", "grok-4.5-latest", "grok-build-latest"])(
    "uses xAI's high reasoning default for %s",
    (modelId) => {
      const profile = resolveThinkingProfile({
        provider: "xai",
        modelId,
      });

      expect(profile).toEqual({
        levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
        defaultLevel: "high",
      });
    },
  );

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

  it.each(["grok-build-0.1", "grok-4.20-0309-reasoning", "grok-4.20-beta-latest-reasoning"])(
    "does not advertise configurable reasoning for %s",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "xai", modelId })).toEqual({
        levels: [{ id: "off" }],
        defaultLevel: "off",
      });
    },
  );
});
