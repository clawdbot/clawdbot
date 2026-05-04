import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("opencode provider policy public artifact", () => {
  it("exposes Claude Opus 4.7 thinking levels without loading the full provider plugin", () => {
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "claude-opus-4-7",
      }),
    ).toMatchObject({
      levels: expect.arrayContaining([{ id: "xhigh" }, { id: "adaptive" }, { id: "max" }]),
      defaultLevel: "off",
    });
  });

  it("keeps adaptive-only Claude profiles aligned with Anthropic", () => {
    const profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-opus-4-6",
    });

    expect(profile).toMatchObject({
      levels: expect.arrayContaining([{ id: "adaptive" }]),
      defaultLevel: "adaptive",
    });
    expect(profile.levels.some((level) => level.id === "xhigh" || level.id === "max")).toBe(false);
  });
});
