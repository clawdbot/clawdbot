// Openai tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("OpenAI provider policy artifact", () => {
  it("keeps OpenAI thinking policy for openai refs", () => {
    const codexProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
    });
    const openaiProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3",
    });
    const openaiMiniProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });

    expect(codexProfile?.levels.map((level) => level.id)).toContain("xhigh");
    expect(openaiProfile?.levels.map((level) => level.id)).not.toContain("xhigh");
    expect(openaiMiniProfile?.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("exposes max for the GPT-5.6 series", () => {
    const solLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
    })?.levels.map((level) => level.id);
    const terraLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-terra",
    })?.levels.map((level) => level.id);
    const lunaLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-luna",
    })?.levels.map((level) => level.id);

    expect(solLevels).toContain("max");
    expect(terraLevels).toContain("xhigh");
    expect(terraLevels).toContain("max");
    expect(lunaLevels).toContain("xhigh");
    expect(lunaLevels).toContain("max");
  });

  it.each([
    ["gpt-5.6-sol", "codex", "low"],
    ["gpt-5.6-sol", "openclaw", "low"],
    ["gpt-5.6-terra", "codex", "medium"],
    ["gpt-5.6-terra", "openclaw", "medium"],
    ["gpt-5.6-luna", "codex", "medium"],
    ["gpt-5.6-luna", "openclaw", "medium"],
  ])("uses the model default for %s on %s", (modelId, agentRuntime, expected) => {
    const profile = resolveThinkingProfile({
      provider: "openai",
      modelId,
      agentRuntime,
    });

    expect(profile?.defaultLevel).toBe(expected);
  });

  it.each(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "exposes logical Ultra for %s on the OpenClaw runtime",
    (modelId) => {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "openclaw",
      })?.levels.map((level) => level.id);

      expect(levels).toContain("ultra");
    },
  );

  it.each(["gpt-5.6-sol", "gpt-5.6-terra"])(
    "uses native Ultra fallback for %s when model/list metadata is unavailable",
    (modelId) => {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "codex",
      })?.levels.map((level) => level.id);

      expect(levels).toContain("ultra");
    },
  );

  it.each(["gpt-5.6-sol", "gpt-5.6-terra"])(
    "keeps native Ultra fallback for %s with direct OpenAI API metadata",
    (modelId) => {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "codex",
        compat: {
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        },
      })?.levels.map((level) => level.id);

      expect(levels).toContain("ultra");
    },
  );

  it("does not invent native Ultra support for bare or suffixed GPT-5.6 refs", () => {
    for (const modelId of ["gpt-5.6", "gpt-5.6-sol-oai"]) {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "codex",
      })?.levels.map((level) => level.id);

      expect(levels).not.toContain("max");
      expect(levels).not.toContain("ultra");
    }
  });

  it("lets authoritative Codex model/list metadata override native fallbacks", () => {
    const solLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    })?.levels.map((level) => level.id);
    const terraLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-terra",
      agentRuntime: "codex",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    })?.levels.map((level) => level.id);

    expect(solLevels).not.toContain("ultra");
    expect(terraLevels).toContain("ultra");
  });

  it.each([
    { efforts: [], expected: ["off"] },
    { efforts: ["high"], expected: ["off", "high"] },
  ])("uses the complete authoritative Codex effort list for $efforts", ({ efforts, expected }) => {
    const profile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      compat: { supportedReasoningEfforts: efforts },
    });

    expect(profile?.levels.map((level) => level.id)).toEqual(expected);
    expect(profile?.defaultLevel).toBeUndefined();
  });

  it("keeps Codex Luna capped at Max without authoritative Ultra metadata", () => {
    const levels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      agentRuntime: "codex",
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    })?.levels.map((level) => level.id);

    expect(levels).toContain("max");
    expect(levels).not.toContain("ultra");
  });
});
