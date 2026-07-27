// Regression coverage for Claude Opus 5 thinking policy on Amazon Bedrock.
// Opus 5 is adaptive-only: it must resolve to the adaptive thinking profile,
// never the legacy `enabled` + `budget_tokens` extended-thinking shape.
import { describe, expect, it } from "vitest";
import {
  isLatestAdaptiveBedrockModelRef,
  isOpus47OrNewerBedrockModelRef,
  resolveBedrockClaudeThinkingProfile,
  resolveBedrockNativeThinkingLevelMap,
  supportsBedrockNativeMaxEffort,
} from "./thinking-policy.js";

const OPUS_5_MODEL_IDS = [
  "us.anthropic.claude-opus-5",
  "eu.anthropic.claude-opus-5",
  "global.anthropic.claude-opus-5",
  "anthropic.claude-opus-5-v1:0",
  "us.anthropic.claude-opus-5-20260615-v1:0",
];

describe("Bedrock Claude Opus 5 thinking policy", () => {
  it.each(OPUS_5_MODEL_IDS)("treats %s as Opus 4.7-or-newer", (modelId) => {
    expect(isOpus47OrNewerBedrockModelRef(modelId)).toBe(true);
  });

  it.each(OPUS_5_MODEL_IDS)("treats %s as latest adaptive", (modelId) => {
    expect(isLatestAdaptiveBedrockModelRef(modelId)).toBe(true);
  });

  it.each(OPUS_5_MODEL_IDS)("supports native max effort for %s", (modelId) => {
    expect(supportsBedrockNativeMaxEffort(modelId)).toBe(true);
  });

  it.each(OPUS_5_MODEL_IDS)("maps native xhigh/max effort for %s", (modelId) => {
    expect(resolveBedrockNativeThinkingLevelMap(modelId)).toEqual({
      xhigh: "xhigh",
      max: "max",
    });
  });

  it.each(OPUS_5_MODEL_IDS)("resolves the adaptive thinking profile for %s", (modelId) => {
    const profile = resolveBedrockClaudeThinkingProfile(modelId);
    expect(profile.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
    ]);
    expect(profile.defaultLevel).toBe("high");
  });

  it("keeps legacy Claude Opus ids on the base thinking profile", () => {
    const profile = resolveBedrockClaudeThinkingProfile(
      "us.anthropic.claude-opus-4-5-20251101-v1:0",
    );
    expect(isLatestAdaptiveBedrockModelRef("us.anthropic.claude-opus-4-5-20251101-v1:0")).toBe(
      false,
    );
    expect(profile.levels.map((level) => level.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });
});
