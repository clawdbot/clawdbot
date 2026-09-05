import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCandidatePromptMode } from "./prompt-mode-from-tools-profile.js";

const agentId = "main";
const codingBaseOpenAiMinimal = {
  tools: {
    profile: "coding",
    byProvider: { openai: { profile: "minimal" } },
  },
  agents: {
    list: [{ id: "main" }],
    defaults: {
      model: { primary: "anthropic/claude-sonnet-4-6" },
      models: {
        "anthropic/claude-sonnet-4-6": {},
        "openai/gpt-5.4": {},
        "openai/channel-model": {},
        "anthropic/fallback-model": {},
      },
    },
  },
} as OpenClawConfig;

describe("resolveCandidatePromptMode", () => {
  it("uses the actual attempt model, not stored fallback state", () => {
    expect(
      resolveCandidatePromptMode({
        cfg: codingBaseOpenAiMinimal,
        agentId,
        modelProvider: "anthropic",
        modelId: "fallback-model",
        promptModeFromToolsProfile: true,
      }),
    ).toBeUndefined();
    expect(
      resolveCandidatePromptMode({
        cfg: codingBaseOpenAiMinimal,
        agentId,
        modelProvider: "openai",
        modelId: "channel-model",
        promptModeFromToolsProfile: true,
      }),
    ).toBe("minimal");
  });

  it("recomputes for a cross-provider fallback candidate", () => {
    expect(
      resolveCandidatePromptMode({
        cfg: codingBaseOpenAiMinimal,
        agentId,
        modelProvider: "openai",
        modelId: "gpt-5.4",
        promptModeFromToolsProfile: true,
      }),
    ).toBe("minimal");
    expect(
      resolveCandidatePromptMode({
        cfg: codingBaseOpenAiMinimal,
        agentId,
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-6",
        promptModeFromToolsProfile: true,
      }),
    ).toBeUndefined();
  });

  it("keeps an explicit promptMode even when the tools profile is minimal", () => {
    expect(
      resolveCandidatePromptMode({
        cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
        agentId,
        modelProvider: "openai",
        modelId: "gpt-5.4",
        promptMode: "none",
        promptModeFromToolsProfile: true,
      }),
    ).toBe("none");
  });

  it("does not derive promptMode unless the caller opted in", () => {
    expect(
      resolveCandidatePromptMode({
        cfg: { tools: { profile: "minimal" } } as OpenClawConfig,
        agentId,
        modelProvider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBeUndefined();
  });
});
