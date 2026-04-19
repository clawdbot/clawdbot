import { describe, expect, it } from "vitest";
import { sanitizeGoogleThinkingPayload } from "./google-stream-wrappers.js";

describe("sanitizeGoogleThinkingPayload — gemini-2.5-pro zero budget", () => {
  it("removes thinkingBudget=0 for gemini-2.5-pro", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("removes thinkingBudget=0 for gemini-2.5-pro with provider prefix", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "google/gemini-2.5-pro-preview" });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("removes only thinkingBudget and preserves other thinkingConfig keys", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.config.thinkingConfig).not.toHaveProperty("thinkingBudget");
    expect(payload.config.thinkingConfig).toHaveProperty("includeThoughts", true);
  });

  it("removes thinkingBudget=0 from native Google generationConfig payloads", () => {
    const payload = {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.generationConfig.thinkingConfig).not.toHaveProperty("thinkingBudget");
    expect(payload.generationConfig.thinkingConfig).toHaveProperty("includeThoughts", true);
  });

  it("keeps thinkingBudget=0 for gemini-2.5-flash (not thinking-required)", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-flash" });
    expect(payload.config.thinkingConfig).toHaveProperty("thinkingBudget", 0);
  });

  it("keeps positive thinkingBudget for gemini-2.5-pro", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 1000 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.config.thinkingConfig).toHaveProperty("thinkingBudget", 1000);
  });

  it("rewrites Gemini 3 Pro budgets to thinkingLevel", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3.1-pro-preview",
      thinkingLevel: "high",
    });
    expect(payload.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
  });

  it("rewrites Gemini 3 Flash latest disabled budgets to minimal thinkingLevel", () => {
    const payload = {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-flash-latest",
      thinkingLevel: "off",
    });
    expect(payload.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "MINIMAL",
    });
  });

  it("fills thinkingLevel for Gemini 3 Flash negative budgets", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: -1, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "medium",
    });
    expect(payload.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "MEDIUM",
    });
  });
});
