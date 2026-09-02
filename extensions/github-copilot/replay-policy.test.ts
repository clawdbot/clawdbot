// Github Copilot tests cover replay policy transport dispatch.
import type { ProviderReplayPolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import {
  buildGithubCopilotReplayPolicy,
  sanitizeGithubCopilotReplayHistory,
} from "./replay-policy.js";

function buildPolicy(modelApi: ProviderReplayPolicyContext["modelApi"], modelId: string) {
  return buildGithubCopilotReplayPolicy({ provider: "github-copilot", modelApi, modelId });
}

describe("buildGithubCopilotReplayPolicy", () => {
  it("applies Anthropic turn validation to Claude models", () => {
    // Copilot Claude hits a real Anthropic Messages endpoint, which rejects a
    // transcript ending on an assistant turn. Core only strips that trailing
    // prefill turn when validateAnthropicTurns is set.
    expect(buildPolicy("anthropic-messages", "claude-opus-5")).toMatchObject({
      validateAnthropicTurns: true,
      sanitizeMode: "full",
      repairToolUseResultPairing: true,
      preserveSignatures: true,
      allowSyntheticToolResults: true,
    });
  });

  it("drops replayed thinking for thinking-preserving Claude ids", () => {
    for (const modelId of [
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-opus-4.8",
      "claude-sonnet-4.6",
      "claude-haiku-4.5",
    ]) {
      expect(buildPolicy("anthropic-messages", modelId)).toMatchObject({
        dropThinkingBlocks: true,
      });
    }
  });

  it("leaves transcript tool ids to the Copilot stream wrapper", () => {
    const policy = buildPolicy("anthropic-messages", "claude-opus-5");
    expect(policy).not.toHaveProperty("sanitizeToolCallIds");
    expect(policy).not.toHaveProperty("toolCallIdMode");
  });

  it("claims no policy for OpenAI-compatible transports", () => {
    expect(buildPolicy("openai-responses", "gpt-5.4")).toBeUndefined();
    expect(buildPolicy("openai-completions", "gemini-3.1-pro-preview")).toBeUndefined();
  });
});

describe("sanitizeGithubCopilotReplayHistory", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private", thinkingSignature: "sig" },
        { type: "redacted_thinking", data: "opaque" },
        { type: "text", text: "visible" },
      ],
    },
  ];

  it("strips replayed thinking on the Anthropic transport", () => {
    expect(
      sanitizeGithubCopilotReplayHistory({
        provider: "github-copilot",
        modelApi: "anthropic-messages",
        modelId: "claude-opus-5",
        messages,
      } as never),
    ).toEqual([{ role: "assistant", content: [{ type: "text", text: "visible" }] }]);
  });

  it("replaces a thinking-only assistant turn with a placeholder", () => {
    expect(
      sanitizeGithubCopilotReplayHistory({
        provider: "github-copilot",
        modelApi: "anthropic-messages",
        modelId: "claude-opus-5",
        messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "private" }] }],
      } as never),
    ).toEqual([
      { role: "assistant", content: [{ type: "text", text: "[assistant reasoning omitted]" }] },
    ]);
  });

  it("strips replayed thinking on the OpenAI Responses transport", () => {
    expect(
      sanitizeGithubCopilotReplayHistory({
        provider: "github-copilot",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
        messages,
      } as never),
    ).toEqual([{ role: "assistant", content: [{ type: "text", text: "visible" }] }]);
  });

  it("passes history through on the OpenAI Completions transport", () => {
    expect(
      sanitizeGithubCopilotReplayHistory({
        provider: "github-copilot",
        modelApi: "openai-completions",
        modelId: "gpt-5.4",
        messages,
      } as never),
    ).toBe(messages);
  });
});
