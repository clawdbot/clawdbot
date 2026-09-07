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
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("exposes a binary profile for underscore-prefixed Nemotron served-model-name aliases", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "yk_nemotron-3-super",
        reasoning: true,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("exposes a three-level profile for self-hosted DeepSeek V4 reasoning models", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "deepseek-ai/DeepSeek-V4-Pro",
        reasoning: true,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "deepseek-v4-flash",
        reasoning: true,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  // Regression: served-model-name aliases joined with "_" (e.g. vLLM's
  // `--served-model-name yk_deepseek_v4`) put a word character directly
  // before "deepseek", so a leading `\b` in the id matcher would silently
  // never match and reasoning would never activate for that alias.
  it("exposes a three-level profile for underscore-prefixed served-model-name aliases", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "yk_deepseek_v4",
        reasoning: true,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
      defaultLevel: "off",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("exposes known-model-family profiles for discovered aliases regardless of catalog reasoning hint", () => {
    for (const reasoning of [false, undefined]) {
      expect(
        resolveThinkingProfile({ provider: "vllm", modelId: "yk_deepseek_v4", reasoning }),
      ).toEqual({
        levels: [{ id: "off" }, { id: "high" }, { id: "max" }],
        defaultLevel: "off",
        preserveWhenCatalogReasoningFalse: true,
      });
      expect(
        resolveThinkingProfile({ provider: "vllm", modelId: "yk_nemotron-3-super", reasoning }),
      ).toEqual({
        levels: [{ id: "off" }, { id: "low", label: "on" }],
        defaultLevel: "off",
        preserveWhenCatalogReasoningFalse: true,
      });
    }
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
