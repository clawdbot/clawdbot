import { describe, expect, it } from "vitest";
import {
  applyInferredQwenThinkingCompat,
  isQwenThinkingCapableModelId,
  resolveQwenThinkingFormatForRoute,
} from "./qwen-thinking-compat.js";

describe("qwen-thinking-compat", () => {
  it.each([
    "qwen3.6-27b",
    "Qwen3.6-27B",
    "qwen3.5-plus",
    "qwen3.7-max",
    "qwen3-6-27b",
    "org/qwen3.6-flash",
  ])("detects thinking-capable id %s", (id) => {
    expect(isQwenThinkingCapableModelId(id)).toBe(true);
  });

  it.each(["qwen3-8b", "qwen2.5-coder", "llama3.1", "qwen3"])(
    "does not detect non-thinking id %s",
    (id) => {
      expect(isQwenThinkingCapableModelId(id)).toBe(false);
    },
  );

  it("infers reasoning and qwen format for custom remote routes", () => {
    expect(
      applyInferredQwenThinkingCompat({
        provider: "my-qwen",
        modelId: "Qwen3.6-27B",
        baseUrl: "https://example.com/v1",
      }),
    ).toEqual({
      reasoning: true,
      compat: { thinkingFormat: "qwen" },
    });
  });

  it("infers qwen-chat-template for local endpoints", () => {
    expect(
      resolveQwenThinkingFormatForRoute({
        provider: "custom",
        baseUrl: "http://127.0.0.1:1234/v1",
      }),
    ).toBe("qwen-chat-template");
    expect(
      applyInferredQwenThinkingCompat({
        provider: "lmstudio",
        modelId: "qwen3.6-27b",
        baseUrl: "http://localhost:1234/v1",
      }).compat,
    ).toEqual({ thinkingFormat: "qwen-chat-template" });
  });

  it("preserves explicit reasoning false and thinkingFormat", () => {
    expect(
      applyInferredQwenThinkingCompat({
        provider: "custom",
        modelId: "qwen3.6-27b",
        reasoning: false,
        compat: { thinkingFormat: "openai" },
      }),
    ).toEqual({
      reasoning: false,
      compat: { thinkingFormat: "openai" },
    });
  });
});
