import { describe, expect, it } from "vitest";
import {
  isOpenRouterDeepSeekV4ModelId,
  isOpenRouterMistralModelId,
  normalizeOpenRouterApiModelId,
} from "./models.js";

describe("normalizeOpenRouterApiModelId", () => {
  it.each([
    ["openrouter/deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
    ["openrouter/deepseek-v4-pro", "deepseek/deepseek-v4-pro"],
    ["openrouter/DEEPSEEK-V4-FLASH", "deepseek/deepseek-v4-flash"],
  ])("expands short OpenRouter ref %s to %s", (input, expected) => {
    expect(normalizeOpenRouterApiModelId(input)).toBe(expected);
  });

  it("strips provider prefix from already-namespaced refs", () => {
    expect(normalizeOpenRouterApiModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });

  it.each([
    ["openrouter/auto", "openrouter/auto"],
    ["openrouter/auto:free", "openrouter/auto:free"],
    ["openrouter/free", "openrouter/free"],
  ])("preserves native OpenRouter route %s", (input, expected) => {
    expect(normalizeOpenRouterApiModelId(input)).toBe(expected);
  });

  it("passes through refs without the openrouter prefix", () => {
    expect(normalizeOpenRouterApiModelId("deepseek/deepseek-v4-flash")).toBe(
      "deepseek/deepseek-v4-flash",
    );
  });
});

describe("isOpenRouterDeepSeekV4ModelId", () => {
  it("matches namespaced DeepSeek V4 refs", () => {
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek/deepseek-v4-pro")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4-flash")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/anthropic/claude-sonnet-4-6")).toBe(false);
    expect(isOpenRouterDeepSeekV4ModelId(null)).toBe(false);
  });
});

describe("isOpenRouterMistralModelId", () => {
  it("matches Mistral-prefixed refs", () => {
    expect(isOpenRouterMistralModelId("openrouter/mistral/ministral-8b")).toBe(true);
    expect(isOpenRouterMistralModelId("openrouter/codestral-22b")).toBe(true);
    expect(isOpenRouterMistralModelId("mistral/ministral-8b")).toBe(true);
    expect(isOpenRouterMistralModelId(null)).toBe(false);
  });
});
