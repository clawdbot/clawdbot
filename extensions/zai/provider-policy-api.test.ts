// Z.AI tests cover its cold provider thinking policy.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile, resolveZaiReasoningEffort } from "./provider-policy-api.js";

describe("zai provider thinking policy", () => {
  it.each(["glm-5.3", "glm-5.3-preview"])(
    "exposes GLM 5.3 effort levels and default for %s",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "zai", modelId })).toEqual({
        levels: [
          { id: "low", label: "low" },
          { id: "high", label: "high" },
          { id: "max", label: "max" },
        ],
        defaultLevel: "max",
      });
    },
  );

  it.each(["glm-5.2", "glm-5.2-flash"])("exposes full GLM 5.2 levels for %s", (modelId) => {
    expect(resolveThinkingProfile({ provider: "zai", modelId })).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
      defaultLevel: "off",
    });
  });

  it.each(["glm-5.1", "glm-4.7"])("keeps older GLM models binary for %s", (modelId) => {
    expect(resolveThinkingProfile({ provider: "zai", modelId })).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });

  it.each([
    ["glm-5.3", "minimal", "low"],
    ["glm-5.3", "low", "low"],
    ["glm-5.3", "medium", "high"],
    ["glm-5.3", "high", "high"],
    ["glm-5.3", "adaptive", "max"],
    ["glm-5.3", "xhigh", "max"],
    ["glm-5.3", "max", "max"],
    ["glm-5.2", "low", "high"],
    ["glm-5.2", "max", "max"],
    ["glm-5.1", "high", undefined],
  ] as const)("maps %s %s to reasoning effort %s", (modelId, level, expected) => {
    expect(resolveZaiReasoningEffort(modelId, level)).toBe(expected);
  });
});
