// Google tests cover thinking plugin behavior.
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
    ["adaptive", undefined],
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
    ["gemini-flash-latest", "off", "MINIMAL"],
    ["gemini-flash-latest", "minimal", "MINIMAL"],
    ["gemini-flash-latest", "low", "LOW"],
    ["gemini-flash-latest", "medium", "MEDIUM"],
    ["gemini-flash-latest", "adaptive", undefined],
    ["gemini-flash-latest", "high", "HIGH"],
    ["gemini-flash-latest", "xhigh", "HIGH"],
    ["gemini-3.6-flash", "off", "MINIMAL"],
    ["gemini-3.6-flash", "minimal", "MINIMAL"],
    ["gemini-3.7-flash", "off", "LOW"],
    ["gemini-3.7-flash", "minimal", "LOW"],
    ["gemini-3.7-flash", "low", "LOW"],
    ["gemini-3.7-flash", "medium", "MEDIUM"],
    ["gemini-3.7-flash", "high", "HIGH"],
  ] as const)("maps %s thinking level %s to %s", (modelId, thinkingLevel, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId,
        thinkingLevel,
      }),
    ).toBe(expected);
  });

  it.each([
    ["gemini-3.1-flash-lite", -1, undefined],
    ["gemini-3.1-flash-lite", 0, "MINIMAL"],
    ["gemini-3.1-flash-lite", 2048, "LOW"],
    ["gemini-3.1-flash-lite", 8192, "MEDIUM"],
    ["gemini-3.1-flash-lite", 8193, "HIGH"],
    ["gemini-3.6-flash", 0, "MINIMAL"],
    ["gemini-3.7-flash", 0, "LOW"],
  ] as const)("maps %s budget %s to %s", (modelId, thinkingBudget, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId,
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

  it("keeps Gemini 3 adaptive thinking provider-dynamic instead of forcing a fixed level", () => {
    const payload = {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
      },
    };

    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "adaptive",
    });

    expect(payload.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
    });
  });

  it("maps Gemini 2.5 adaptive thinking to dynamic thinkingBudget", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 8192, includeThoughts: true },
      },
    };

    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-2.5-flash",
      thinkingLevel: "adaptive",
    });

    expect(payload.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: -1,
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
