// Vllm tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("vLLM provider thinking policy", () => {
  it("exposes a binary profile for configured Qwen chat-template models", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("uses configured Qwen compat even when catalog reasoning metadata is absent", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("exposes a binary profile for vLLM Nemotron 3 reasoning models", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "nemotron-3-super",
        reasoning: true,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("does not flatten unconfigured or non-reasoning vLLM models", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        reasoning: true,
      }),
    ).toBeNull();
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        reasoning: false,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toBeNull();
  });
});
