// Opencode tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("opencode provider policy public artifact", () => {
  it("exposes Claude Opus 4.7 thinking levels without loading the full provider plugin", () => {
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "claude-opus-4-7",
        compat: { supportedReasoningEfforts: ["low"] },
      }),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "xhigh" },
        { id: "adaptive" },
        { id: "max" },
      ],
      defaultLevel: "off",
    });
  });

  it("keeps adaptive-only Claude profiles aligned with Anthropic", () => {
    const profile = resolveThinkingProfile({
      provider: "opencode",
      modelId: "claude-opus-4-6",
    });

    expect(profile).toEqual({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "adaptive" },
      ],
      defaultLevel: "adaptive",
    });
  });

  it("exposes the full GPT-5.6 reasoning profile", () => {
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "gpt-5.6-luna",
        compat: {
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        },
      }),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "xhigh" },
        { id: "max" },
      ],
      defaultLevel: "medium",
    });
  });

  it("derives non-Claude profiles only from exact provider effort metadata", () => {
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "grok-4.5",
        compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "medium",
    });
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "kimi-k3",
        compat: { supportedReasoningEfforts: ["max"] },
      }),
    ).toEqual({ levels: [{ id: "off" }, { id: "max" }], defaultLevel: "off" });
    expect(
      resolveThinkingProfile({
        provider: "opencode",
        modelId: "big-pickle",
        api: "openai-completions",
        reasoning: true,
      }),
    ).toEqual({ levels: [{ id: "off", label: "always on" }], defaultLevel: "off" });
  });
});
