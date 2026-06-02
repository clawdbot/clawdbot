import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("github-copilot provider-policy-api", () => {
  it("returns the base level set for non-xhigh GitHub Copilot models", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "claude-opus-4.6",
      })?.levels.map((level) => level.id),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("appends xhigh for current static GPT Copilot xhigh ids", () => {
    for (const modelId of ["gpt-5.4", "gpt-5.3-codex"]) {
      expect(
        resolveThinkingProfile({
          provider: "github-copilot",
          modelId,
        })?.levels.map((level) => level.id),
        `model=${modelId}`,
      ).toContain("xhigh");
    }
  });

  it("appends xhigh when catalog compat advertises it", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "future-copilot-model",
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      })?.levels.map((level) => level.id),
    ).toContain("xhigh");
  });

  it("appends xhigh for static Copilot metadata overrides", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "claude-opus-4.7-1m-internal",
      })?.levels.map((level) => level.id),
    ).toContain("xhigh");
  });

  it("normalizes the model id casing before xhigh membership checks", () => {
    expect(
      resolveThinkingProfile({
        provider: "github-copilot",
        modelId: "GPT-5.4",
      })?.levels.map((level) => level.id),
    ).toContain("xhigh");
  });

  it("returns null for non-GitHub Copilot providers", () => {
    expect(
      resolveThinkingProfile({
        provider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBeNull();
  });
});
