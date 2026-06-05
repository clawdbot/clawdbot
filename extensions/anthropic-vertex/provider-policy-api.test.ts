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

  it("ignores other providers", () => {
    expect(resolveThinkingProfile({ provider: "anthropic", modelId: "claude-opus-4-8" })).toBe(
      null,
    );
  });
});
