import { describe, expect, it } from "vitest";
import { buildOauthProviderAuthResult } from "./provider-auth-result.js";

describe("buildOauthProviderAuthResult", () => {
  it("normalizes retired Gemini defaults before emitting config patches", () => {
    const result = buildOauthProviderAuthResult({
      providerId: "google",
      defaultModel: "google/gemini-3-pro-preview",
      access: "access-token",
    });

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": {},
          },
        },
      },
    });
  });

  it("normalizes retired Gemini refs inside explicit config patches", () => {
    const result = buildOauthProviderAuthResult({
      providerId: "google",
      defaultModel: "google/gemini-3-pro-preview",
      access: "access-token",
      configPatch: {
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-3-pro-preview",
              fallbacks: ["google/gemini-3-pro-preview", "openai/gpt-5.5"],
            },
            models: {
              "google/gemini-3-pro-preview": { alias: "gemini" },
            },
          },
        },
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              models: [
                {
                  id: "google/gemini-3-pro-preview",
                  name: "Gemini 3 Pro",
                  contextWindow: 1_048_576,
                  maxTokens: 65_536,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  reasoning: true,
                },
              ],
            },
          },
        },
      },
    });

    expect(result.defaultModel).toBe("google/gemini-3.1-pro-preview");
    expect(result.configPatch).toEqual({
      agents: {
        defaults: {
          model: {
            primary: "google/gemini-3.1-pro-preview",
            fallbacks: ["google/gemini-3.1-pro-preview", "openai/gpt-5.5"],
          },
          models: {
            "google/gemini-3.1-pro-preview": { alias: "gemini" },
          },
        },
      },
      models: {
        providers: {
          google: {
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            models: [
              {
                id: "google/gemini-3.1-pro-preview",
                name: "Gemini 3 Pro",
                contextWindow: 1_048_576,
                maxTokens: 65_536,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: true,
              },
            ],
          },
        },
      },
    });
  });
});
