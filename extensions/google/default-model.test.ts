import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { applyGoogleGeminiModelDefault, GOOGLE_GEMINI_DEFAULT_MODEL } from "./api.js";

describe("google default model", () => {
  it("sets defaults when model is unset", () => {
    const cfg: OpenClawConfig = { agents: { defaults: {} } };
    const applied = applyGoogleGeminiModelDefault(cfg);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({ primary: GOOGLE_GEMINI_DEFAULT_MODEL });
  });

  it("overrides existing models", () => {
    const applied = applyGoogleGeminiModelDefault({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-6" } } },
    } as OpenClawConfig);
    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({ primary: GOOGLE_GEMINI_DEFAULT_MODEL });
  });

  it("normalizes retired Gemini model map keys when applying the default", () => {
    const applied = applyGoogleGeminiModelDefault({
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3-pro-preview",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
          models: {
            "google/gemini-3-pro-preview": { alias: "gemini" },
          },
        },
      },
    } as OpenClawConfig);

    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
    expect(applied.next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": { alias: "gemini" },
    });
  });

  it("normalizes retired Gemini model maps even when the primary is already current", () => {
    const applied = applyGoogleGeminiModelDefault({
      agents: {
        defaults: {
          model: {
            primary: GOOGLE_GEMINI_DEFAULT_MODEL,
            fallbacks: ["google/gemini-3-pro-preview"],
          },
          models: {
            "google/gemini-3-pro-preview": { alias: "gemini" },
          },
        },
      },
    } as OpenClawConfig);

    expect(applied.changed).toBe(true);
    expect(applied.next.agents?.defaults?.model).toEqual({
      primary: GOOGLE_GEMINI_DEFAULT_MODEL,
      fallbacks: [GOOGLE_GEMINI_DEFAULT_MODEL],
    });
    expect(applied.next.agents?.defaults?.models).toEqual({
      [GOOGLE_GEMINI_DEFAULT_MODEL]: { alias: "gemini" },
    });
  });

  it("normalizes retired Gemini provider catalog rows when the primary is already current", () => {
    const applied = applyGoogleGeminiModelDefault({
      agents: {
        defaults: {
          model: {
            primary: GOOGLE_GEMINI_DEFAULT_MODEL,
          },
        },
      },
      models: {
        providers: {
          google: {
            api: "google-generative-ai",
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "google/gemini-3-pro-preview",
                name: "Gemini 3 Pro",
                contextWindow: 1_000_000,
                maxTokens: 8192,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: true,
              },
            ],
          },
        },
      },
    } as OpenClawConfig);

    expect(applied.changed).toBe(true);
    expect(applied.next.models?.providers?.google?.models?.map((model) => model.id)).toEqual([
      GOOGLE_GEMINI_DEFAULT_MODEL,
    ]);
  });

  it("no-ops when already on the target default", () => {
    const cfg = {
      agents: { defaults: { model: { primary: GOOGLE_GEMINI_DEFAULT_MODEL } } },
    } as OpenClawConfig;
    const applied = applyGoogleGeminiModelDefault(cfg);
    expect(applied.changed).toBe(false);
    expect(applied.next).toEqual(cfg);
  });
});
