import { describe, expect, it } from "vitest";
import {
  resolveGoogleGemini3ThinkingLevel,
  sanitizeGoogleThinkingPayload,
} from "./thinking-api.js";

describe("google thinking policy", () => {
  it.each([
    ["off", "LOW"],
    ["minimal", "LOW"],
    ["low", "LOW"],
    ["medium", "HIGH"],
    ["adaptive", "HIGH"],
    ["high", "HIGH"],
    ["xhigh", "HIGH"],
  ] as const)("maps Gemini 3 Pro thinking level %s to %s", (thinkingLevel, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId: "gemini-3.1-pro-preview",
        thinkingLevel,
      }),
    ).toBe(expected);
  });

  it.each([
    [0, "LOW"],
    [2048, "LOW"],
    [2049, "HIGH"],
  ] as const)("maps Gemini 3 Pro budget %s to %s", (thinkingBudget, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId: "gemini-pro-latest",
        thinkingBudget,
      }),
    ).toBe(expected);
  });

  it.each([
    ["off", "MINIMAL"],
    ["minimal", "MINIMAL"],
    ["low", "LOW"],
    ["medium", "MEDIUM"],
    ["adaptive", "MEDIUM"],
    ["high", "HIGH"],
    ["xhigh", "HIGH"],
  ] as const)("maps Gemini 3 Flash thinking level %s to %s", (thinkingLevel, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId: "gemini-flash-latest",
        thinkingLevel,
      }),
    ).toBe(expected);
  });

  it.each([
    [-1, "MINIMAL"],
    [0, "MINIMAL"],
    [2048, "LOW"],
    [8192, "MEDIUM"],
    [8193, "HIGH"],
  ] as const)("maps Gemini 3 Flash budget %s to %s", (thinkingBudget, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId: "gemini-3.1-flash-lite-preview",
        thinkingBudget,
      }),
    ).toBe(expected);
  });

  it("removes thinkingBudget=0 for Gemini 2.5 Pro", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    sanitizeGoogleThinkingPayload({ payload, modelId: "google/gemini-2.5-pro-preview" });

    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("rewrites Gemini 3 thinking budgets to thinkingLevel", () => {
    const payload = {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 8193, includeThoughts: true },
      },
    };

    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "medium",
    });

    expect(payload.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "MEDIUM",
    });
  });

  it("maps Gemma 4 thinking mode without sending thinkingBudget", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 4096 },
      },
    };

    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemma-4-26b-a4b-it",
      thinkingLevel: "high",
    });

    expect(payload.config.thinkingConfig).toEqual({ thinkingLevel: "HIGH" });
  });
});
