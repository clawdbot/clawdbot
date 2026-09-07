// Anthropic Vertex tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("anthropic-vertex provider-policy-api", () => {
  it("adds Vertex-native max without xhigh for Claude Sonnet 4.6", () => {
    const profile = resolveThinkingProfile({
      provider: "anthropic-vertex",
      modelId: "claude-sonnet-4-6",
    });

    expect(profile?.levels.map((level) => level.id)).toContain("max");
    expect(profile?.levels.map((level) => level.id)).not.toContain("xhigh");
  });

  it("ignores other providers", () => {
    expect(resolveThinkingProfile({ provider: "anthropic", modelId: "claude-opus-4-8" })).toBe(
      null,
    );
  });
});
