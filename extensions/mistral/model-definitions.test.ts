import { describe, expect, it } from "vitest";
import {
  buildMistralCatalogModels,
  buildMistralModelDefinition,
  MISTRAL_DEFAULT_CONTEXT_WINDOW,
  MISTRAL_DEFAULT_COST,
  MISTRAL_DEFAULT_MAX_TOKENS,
  MISTRAL_DEFAULT_MODEL_ID,
} from "./model-definitions.js";

describe("mistral model definitions", () => {
  it("uses current Pi pricing for the bundled default model", () => {
    expect(buildMistralModelDefinition()).toMatchObject({
      id: MISTRAL_DEFAULT_MODEL_ID,
      contextWindow: MISTRAL_DEFAULT_CONTEXT_WINDOW,
      maxTokens: MISTRAL_DEFAULT_MAX_TOKENS,
      cost: MISTRAL_DEFAULT_COST,
    });

    expect(MISTRAL_DEFAULT_COST).toEqual({
      input: 0.5,
      output: 1.5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("publishes a curated set of current Mistral catalog models", () => {
    expect(buildMistralCatalogModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "codestral-latest",
          input: ["text"],
          contextWindow: 256000,
          maxTokens: 4096,
        }),
        expect.objectContaining({
          id: "magistral-small",
          reasoning: true,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 40000,
        }),
        expect.objectContaining({
          id: "mistral-small-latest",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 16384,
        }),
        expect.objectContaining({
          id: "pixtral-large-latest",
          input: ["text", "image"],
          contextWindow: 128000,
          maxTokens: 32768,
        }),
      ]),
    );
  });
});
