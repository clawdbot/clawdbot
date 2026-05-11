import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

describe("google provider policy public artifact", () => {
  it("normalizes Google provider config without loading the full provider plugin", () => {
    expect(
      normalizeConfig({
        provider: "google",
        providerConfig: {
          baseUrl: "https://generativelanguage.googleapis.com",
          api: "google-generative-ai",
          apiKey: "GEMINI_API_KEY",
          models: [
            {
              id: "gemini-3-pro",
              name: "Gemini 3 Pro",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_048_576,
              maxTokens: 65_536,
            },
          ],
        },
      }),
    ).toEqual({
      api: "google-generative-ai",
      apiKey: "GEMINI_API_KEY",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      models: [
        {
          id: "gemini-3.1-pro-preview",
          name: "Gemini 3 Pro",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_048_576,
          maxTokens: 65_536,
        },
      ],
    });
  });

  it("preserves explicit OpenAI-compatible Google endpoints during normalization", () => {
    expect(
      normalizeConfig({
        provider: "google",
        providerConfig: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          api: "openai-completions",
          models: [],
        },
      }),
    ).toEqual({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      api: "openai-completions",
      models: [],
    });
  });

  it("normalizes retired Google model ids even for explicit OpenAI-compatible endpoints", () => {
    expect(
      normalizeConfig({
        provider: "google",
        providerConfig: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          api: "openai-completions",
          models: [
            {
              id: "google/gemini-3-pro-preview",
              name: "Gemini 3 Pro",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_048_576,
              maxTokens: 65_536,
            },
          ],
        },
      }),
    ).toEqual({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      api: "openai-completions",
      models: [
        {
          id: "google/gemini-3.1-pro-preview",
          name: "Gemini 3 Pro",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_048_576,
          maxTokens: 65_536,
        },
      ],
    });
  });

  it("normalizes retired Gemini CLI config model ids before emission", () => {
    expect(
      normalizeConfig({
        provider: "google-gemini-cli",
        providerConfig: {
          baseUrl: "openclaw://google-gemini-cli",
          models: [
            {
              id: "google/gemini-3-pro-preview",
              name: "Gemini CLI 3 Pro",
              reasoning: true,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_048_576,
              maxTokens: 65_536,
            },
          ],
        },
      }),
    ).toEqual({
      baseUrl: "openclaw://google-gemini-cli",
      models: [
        {
          id: "google/gemini-3.1-pro-preview",
          name: "Gemini CLI 3 Pro",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_048_576,
          maxTokens: 65_536,
        },
      ],
    });
  });
});
