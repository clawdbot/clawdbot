// Google tests cover provider policy api plugin behavior.
import { describe, expect, it } from "vitest";
import { normalizeConfig, resolveThinkingProfile } from "./provider-policy-api.js";

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

  it("preserves Gemini 3 thinking levels when catalog reasoning metadata is stale", () => {
    expect(
      resolveThinkingProfile({
        provider: "google",
        modelId: "gemini-3-flash-preview",
        reasoning: false,
      }),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "adaptive" },
        { id: "high" },
      ],
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("preserves provider-prefixed Gemini 3 thinking levels when catalog reasoning metadata is stale", () => {
    expect(
      resolveThinkingProfile({
        provider: "google",
        modelId: "google/gemini-3-flash-preview",
        reasoning: false,
      }),
    ).toMatchObject({
      levels: expect.arrayContaining([{ id: "low" }, { id: "medium" }, { id: "adaptive" }]),
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("preserves normalized Gemini 3 aliases when catalog reasoning metadata is stale", () => {
    expect(
      resolveThinkingProfile({
        provider: "google",
        modelId: "google/gemini-3-pro",
        reasoning: false,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "adaptive" }, { id: "high" }],
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("preserves Gemini 3 Pro thinking levels when catalog reasoning metadata is stale", () => {
    expect(
      resolveThinkingProfile({
        provider: "google",
        modelId: "gemini-3.1-pro-preview",
        reasoning: false,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "adaptive" }, { id: "high" }],
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("honors catalog reasoning=false for non-Gemini 3 Google models", () => {
    expect(
      resolveThinkingProfile({
        provider: "google",
        modelId: "gemma-4-26b-a4b-it",
        reasoning: false,
      }),
    ).toBeUndefined();
  });
});
