// Z.AI tests cover its cold provider thinking policy.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("zai provider thinking policy", () => {
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
});
